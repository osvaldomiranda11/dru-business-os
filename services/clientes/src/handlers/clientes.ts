import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, QueryCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
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
import type { AuthContext } from '@dru-bos/shared';

const CLIENTES_TABLE = process.env.CLIENTES_TABLE!;

// ── Schemas ──────────────────────────────────────────────────────────────────

const ClienteSchema = z.object({
  nome: z.string().min(2).max(150),
  nif: z.string().regex(/^\d{9,14}$/, 'NIF inválido').optional(),
  email: z.string().email('Email inválido').optional(),
  telefone: z.string().min(9).max(20).optional(),
  endereco: z.string().max(255).optional(),
  observacoes: z.string().max(1000).optional(),
  limiteCredito: z.number().positive().optional(),
  moeda: z.enum(['AOA', 'USD']).default('AOA'),
});

const ClienteUpdateSchema = ClienteSchema.partial();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const criar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  if (auth.role === 'viewer') return forbidden('Sem permissão para criar clientes');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = ClienteSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const id = uuidv4();
  const now = new Date().toISOString();
  const data = now.split('T')[0];

  const cliente = {
    PK: `empresa#${auth.empresaId}`,
    SK: `cliente#${id}`,
    GSI1PK: `tipo#cliente`,
    GSI1SK: `data#${data}`,
    id,
    empresaId: auth.empresaId,
    ...parsed.data,
    ativo: true,
    totalFaturas: 0,
    totalDebitoEmAberto: 0,
    criadoPor: auth.userId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.send(new PutCommand({ TableName: CLIENTES_TABLE, Item: cliente }));
    await registarAuditoria(auth, 'criar', 'cliente', id, { nome: parsed.data.nome });
    logger.info('Cliente criado', { id, empresaId: auth.empresaId });
    return created({ id, ...parsed.data, createdAt: now });
  } catch (err) {
    logger.error('Erro ao criar cliente', { error: String(err) });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const qs = event.queryStringParameters ?? {};
  const limite = Math.min(Number(qs.limite ?? 50), 100);
  const pesquisa = qs.pesquisa?.trim();
  const cursor = qs.cursor;

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: CLIENTES_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: pesquisa
          ? 'attribute_not_exists(deletedAt) AND contains(#nome, :pesquisa)'
          : 'attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'cliente#',
          ...(pesquisa && { ':pesquisa': pesquisa }),
        },
        ...(pesquisa && { ExpressionAttributeNames: { '#nome': 'nome' } }),
        Limit: limite,
        ScanIndexForward: false,
        ExclusiveStartKey: cursor
          ? JSON.parse(Buffer.from(cursor, 'base64').toString())
          : undefined,
      }),
    );

    const nextCursor = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return ok({ items: result.Items ?? [], total: result.Count ?? 0, nextCursor });
  } catch (err) {
    logger.error('Erro ao listar clientes', { error: String(err) });
    return internalError();
  }
};

export const obter: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do cliente obrigatório');

  try {
    const result = await db.send(
      new GetCommand({
        TableName: CLIENTES_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `cliente#${id}` },
      }),
    );

    if (!result.Item || result.Item.deletedAt) return notFound('Cliente não encontrado');
    return ok(result.Item);
  } catch (err) {
    logger.error('Erro ao obter cliente', { error: String(err), id });
    return internalError();
  }
};

export const actualizar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  if (auth.role === 'viewer') return forbidden('Sem permissão para actualizar clientes');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do cliente obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = ClienteUpdateSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  if (Object.keys(parsed.data).length === 0) return badRequest('Pelo menos um campo obrigatório');

  const now = new Date().toISOString();
  const campos = Object.keys(parsed.data) as Array<keyof typeof parsed.data>;
  const updateExpr = ['updatedAt = :updatedAt', ...campos.map((c) => `${c} = :${c}`)].join(', ');
  const exprValues: Record<string, unknown> = { ':updatedAt': now };
  for (const c of campos) exprValues[`:${c}`] = parsed.data[c];

  try {
    await db.send(
      new UpdateCommand({
        TableName: CLIENTES_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `cliente#${id}` },
        UpdateExpression: `SET ${updateExpr}`,
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: exprValues,
      }),
    );
    await registarAuditoria(auth, 'actualizar', 'cliente', id, parsed.data);
    return ok({ id, ...parsed.data, updatedAt: now });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return notFound('Cliente não encontrado');
    }
    logger.error('Erro ao actualizar cliente', { error: String(err), id });
    return internalError();
  }
};

export const eliminar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  if (auth.role !== 'admin' && auth.role !== 'gestor') {
    return forbidden('Apenas admin ou gestor pode eliminar clientes');
  }

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do cliente obrigatório');

  const now = new Date().toISOString();
  try {
    await db.send(
      new UpdateCommand({
        TableName: CLIENTES_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `cliente#${id}` },
        UpdateExpression: 'SET deletedAt = :deletedAt, updatedAt = :updatedAt, ativo = :ativo',
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: { ':deletedAt': now, ':updatedAt': now, ':ativo': false },
      }),
    );
    await registarAuditoria(auth, 'eliminar', 'cliente', id);
    return noContent();
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return notFound('Cliente não encontrado');
    }
    logger.error('Erro ao eliminar cliente', { error: String(err), id });
    return internalError();
  }
};

export const historico: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do cliente obrigatório');

  try {
    // Verificar que o cliente existe
    const clienteResult = await db.send(
      new GetCommand({
        TableName: CLIENTES_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `cliente#${id}` },
      }),
    );
    if (!clienteResult.Item || clienteResult.Item.deletedAt) {
      return notFound('Cliente não encontrado');
    }

    // Histórico de interacções do cliente
    const interacoesResult = await db.send(
      new QueryCommand({
        TableName: CLIENTES_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': `interacao#${id}#`,
        },
        ScanIndexForward: false,
        Limit: 50,
      }),
    );

    return ok({
      cliente: clienteResult.Item,
      interacoes: interacoesResult.Items ?? [],
      totalInteracoes: interacoesResult.Count ?? 0,
    });
  } catch (err) {
    logger.error('Erro ao obter histórico', { error: String(err), id });
    return internalError();
  }
};
