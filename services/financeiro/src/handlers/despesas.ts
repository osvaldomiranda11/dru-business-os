import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
import type { DespesaFinanceira, AuthContext } from '@dru-bos/shared';
import { DespesaSchema, DespesaUpdateSchema, FiltrosPeriodoSchema } from '../schemas';

const FINANCEIRO_TABLE = process.env.FINANCEIRO_TABLE!;

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

export const criar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  if (auth.role === 'viewer') return forbidden('Sem permissão para registar despesas');

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Corpo da requisição inválido — JSON malformado');
  }

  const parsed = DespesaSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  }

  const { descricao, valor, moeda, categoria, data, fornecedor, observacoes } = parsed.data;
  const id = uuidv4();
  const now = new Date().toISOString();

  const despesa: DespesaFinanceira = {
    PK: `empresa#${auth.empresaId}`,
    SK: `despesa#${data}#${id}`,
    GSI1PK: `tipo#despesa`,
    GSI1SK: `data#${data}`,
    id,
    empresaId: auth.empresaId,
    descricao,
    valor,
    moeda,
    categoria,
    data,
    fornecedor,
    observacoes,
    criadoPor: auth.userId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.send(new PutCommand({ TableName: FINANCEIRO_TABLE, Item: despesa }));
    await registarAuditoria(auth, 'criar', 'despesa', id, { valor, categoria });
  } catch (err) {
    logger.error('Erro ao criar despesa', { error: String(err), empresaId: auth.empresaId });
    return internalError();
  }

  logger.info('Despesa criada', { id, empresaId: auth.empresaId, valor });
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
    ':prefix': 'despesa#',
  };
  let filterExpression: string | undefined;

  if (dataInicio && dataFim) {
    keyCondition = 'PK = :pk AND SK BETWEEN :inicio AND :fim';
    expressionValues[':pk'] = `empresa#${auth.empresaId}`;
    expressionValues[':inicio'] = `despesa#${dataInicio}#`;
    expressionValues[':fim'] = `despesa#${dataFim}#￿`;
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
    logger.error('Erro ao listar despesas', { error: String(err), empresaId: auth.empresaId });
    return internalError();
  }
};

export const actualizar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  if (auth.role === 'viewer') return forbidden('Sem permissão para actualizar despesas');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID da despesa obrigatório');

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Corpo da requisição inválido — JSON malformado');
  }

  const parsed = DespesaUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  }

  if (Object.keys(parsed.data).length === 0) {
    return badRequest('Pelo menos um campo deve ser fornecido para actualização');
  }

  try {
    const queryResult = await db.send(
      new QueryCommand({
        TableName: FINANCEIRO_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'id = :id AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'despesa#',
          ':id': id,
        },
      }),
    );

    if (!queryResult.Items?.length) return notFound('Despesa não encontrada');

    const existente = queryResult.Items[0] as DespesaFinanceira;
    const now = new Date().toISOString();
    const updates = parsed.data;

    const updateExpressions: string[] = ['updatedAt = :updatedAt'];
    const expressionValues: Record<string, unknown> = { ':updatedAt': now };

    const campos: Array<keyof typeof updates> = [
      'descricao', 'valor', 'moeda', 'categoria', 'fornecedor', 'observacoes',
    ];
    for (const campo of campos) {
      if (updates[campo] !== undefined) {
        updateExpressions.push(`${campo} = :${campo}`);
        expressionValues[`:${campo}`] = updates[campo];
      }
    }

    await db.send(
      new UpdateCommand({
        TableName: FINANCEIRO_TABLE,
        Key: { PK: existente.PK, SK: existente.SK },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeValues: expressionValues,
      }),
    );

    await registarAuditoria(auth, 'actualizar', 'despesa', id, updates);

    return ok({ id, ...updates, updatedAt: now });
  } catch (err) {
    logger.error('Erro ao actualizar despesa', { error: String(err), id });
    return internalError();
  }
};

export const eliminar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  if (auth.role === 'vendedor' || auth.role === 'viewer') {
    return forbidden('Sem permissão para eliminar despesas');
  }

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID da despesa obrigatório');

  try {
    const queryResult = await db.send(
      new QueryCommand({
        TableName: FINANCEIRO_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'id = :id AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'despesa#',
          ':id': id,
        },
      }),
    );

    if (!queryResult.Items?.length) return notFound('Despesa não encontrada');

    const existente = queryResult.Items[0] as DespesaFinanceira;
    const now = new Date().toISOString();

    await db.send(
      new UpdateCommand({
        TableName: FINANCEIRO_TABLE,
        Key: { PK: existente.PK, SK: existente.SK },
        UpdateExpression: 'SET deletedAt = :deletedAt, updatedAt = :updatedAt',
        ExpressionAttributeValues: { ':deletedAt': now, ':updatedAt': now },
      }),
    );

    await registarAuditoria(auth, 'eliminar', 'despesa', id);

    return noContent();
  } catch (err) {
    logger.error('Erro ao eliminar despesa', { error: String(err), id });
    return internalError();
  }
};
