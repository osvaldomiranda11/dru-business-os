import type { APIGatewayProxyHandler } from 'aws-lambda';
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import {
  db,
  ok,
  created,
  noContent,
  badRequest,
  unauthorized,
  notFound,
  forbidden,
  internalError,
  verifyToken,
  extractToken,
  registarAuditoria,
  logger,
} from '@dru-bos/shared';
import type { ReceitaFinanceira, AuthContext } from '@dru-bos/shared';
import { ReceitaSchema, ReceitaUpdateSchema, FiltrosPeriodoSchema } from '../schemas';

const FINANCEIRO_TABLE = process.env.FINANCEIRO_TABLE!;

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

export const criar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Corpo da requisição inválido — JSON malformado');
  }

  const parsed = ReceitaSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  }

  const { descricao, valor, moeda, categoria, data, observacoes } = parsed.data;
  const id = uuidv4();
  const now = new Date().toISOString();

  const receita: ReceitaFinanceira = {
    PK: `empresa#${auth.empresaId}`,
    SK: `receita#${data}#${id}`,
    GSI1PK: `tipo#receita`,
    GSI1SK: `data#${data}`,
    id,
    empresaId: auth.empresaId,
    descricao,
    valor,
    moeda,
    categoria,
    data,
    observacoes,
    criadoPor: auth.userId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.send(new PutCommand({ TableName: FINANCEIRO_TABLE, Item: receita }));
    await registarAuditoria(auth, 'criar', 'receita', id, { valor, categoria });
  } catch (err) {
    logger.error('Erro ao criar receita', { error: String(err), empresaId: auth.empresaId });
    return internalError();
  }

  logger.info('Receita criada', { id, empresaId: auth.empresaId, valor });
  return created({ id, descricao, valor, moeda, categoria, data, createdAt: now });
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const filtrosParsed = FiltrosPeriodoSchema.safeParse(event.queryStringParameters ?? {});
  if (!filtrosParsed.success) {
    return badRequest('Parâmetros inválidos', filtrosParsed.error.flatten().fieldErrors);
  }

  const { dataInicio, dataFim, categoria, limite, cursor } = filtrosParsed.data;

  let keyCondition = 'PK = :pk AND begins_with(SK, :prefix)';
  const expressionValues: Record<string, unknown> = {
    ':pk': `empresa#${auth.empresaId}`,
    ':prefix': 'receita#',
  };
  let filterExpression: string | undefined;

  if (dataInicio && dataFim) {
    keyCondition = 'PK = :pk AND SK BETWEEN :inicio AND :fim';
    expressionValues[':pk'] = `empresa#${auth.empresaId}`;
    expressionValues[':inicio'] = `receita#${dataInicio}#`;
    expressionValues[':fim'] = `receita#${dataFim}#￿`;
    delete expressionValues[':prefix'];
  }

  if (categoria) {
    filterExpression = 'categoria = :categoria AND attribute_not_exists(deletedAt)';
    expressionValues[':categoria'] = categoria;
  } else {
    filterExpression = 'attribute_not_exists(deletedAt)';
  }

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: FINANCEIRO_TABLE,
        KeyConditionExpression: keyCondition,
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionValues,
        Limit: limite,
        ScanIndexForward: false,
        ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, 'base64').toString()) : undefined,
      }),
    );

    const nextCursor = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return ok({
      items: result.Items ?? [],
      total: result.Count ?? 0,
      nextCursor,
    });
  } catch (err) {
    logger.error('Erro ao listar receitas', { error: String(err), empresaId: auth.empresaId });
    return internalError();
  }
};

export const actualizar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID da receita obrigatório');

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Corpo da requisição inválido — JSON malformado');
  }

  const parsed = ReceitaUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  }

  if (Object.keys(parsed.data).length === 0) {
    return badRequest('Pelo menos um campo deve ser fornecido para actualização');
  }

  // Localizar a receita pela SK (contém a data, que não conhecemos aqui)
  try {
    const queryResult = await db.send(
      new QueryCommand({
        TableName: FINANCEIRO_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'id = :id AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'receita#',
          ':id': id,
        },
      }),
    );

    if (!queryResult.Items?.length) return notFound('Receita não encontrada');

    const existente = queryResult.Items[0] as ReceitaFinanceira;

    if (existente.empresaId !== auth.empresaId) return forbidden();

    const now = new Date().toISOString();
    const updates = parsed.data;

    const updateExpressions: string[] = ['updatedAt = :updatedAt'];
    const expressionValues: Record<string, unknown> = { ':updatedAt': now };

    if (updates.descricao !== undefined) {
      updateExpressions.push('descricao = :descricao');
      expressionValues[':descricao'] = updates.descricao;
    }
    if (updates.valor !== undefined) {
      updateExpressions.push('valor = :valor');
      expressionValues[':valor'] = updates.valor;
    }
    if (updates.moeda !== undefined) {
      updateExpressions.push('moeda = :moeda');
      expressionValues[':moeda'] = updates.moeda;
    }
    if (updates.categoria !== undefined) {
      updateExpressions.push('categoria = :categoria');
      expressionValues[':categoria'] = updates.categoria;
    }
    if (updates.observacoes !== undefined) {
      updateExpressions.push('observacoes = :observacoes');
      expressionValues[':observacoes'] = updates.observacoes;
    }

    await db.send(
      new UpdateCommand({
        TableName: FINANCEIRO_TABLE,
        Key: { PK: existente.PK, SK: existente.SK },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeValues: expressionValues,
      }),
    );

    await registarAuditoria(auth, 'actualizar', 'receita', id, updates);

    return ok({ id, ...updates, updatedAt: now });
  } catch (err) {
    logger.error('Erro ao actualizar receita', { error: String(err), id });
    return internalError();
  }
};

export const eliminar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  if (auth.role === 'vendedor' || auth.role === 'viewer') {
    return forbidden('Sem permissão para eliminar receitas');
  }

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID da receita obrigatório');

  try {
    const queryResult = await db.send(
      new QueryCommand({
        TableName: FINANCEIRO_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'id = :id AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'receita#',
          ':id': id,
        },
      }),
    );

    if (!queryResult.Items?.length) return notFound('Receita não encontrada');

    const existente = queryResult.Items[0] as ReceitaFinanceira;
    const now = new Date().toISOString();

    await db.send(
      new UpdateCommand({
        TableName: FINANCEIRO_TABLE,
        Key: { PK: existente.PK, SK: existente.SK },
        UpdateExpression: 'SET deletedAt = :deletedAt, updatedAt = :updatedAt',
        ExpressionAttributeValues: { ':deletedAt': now, ':updatedAt': now },
      }),
    );

    await registarAuditoria(auth, 'eliminar', 'receita', id);

    return noContent();
  } catch (err) {
    logger.error('Erro ao eliminar receita', { error: String(err), id });
    return internalError();
  }
};
