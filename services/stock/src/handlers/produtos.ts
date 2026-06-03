/**
 * Gestão de Produtos — DRU Business OS Stock
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  db,
  ok,
  created,
  badRequest,
  unauthorized,
  forbidden,
  internalError,
  verifyToken,
  extractToken,
  registarAuditoria,
  logger,
} from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const STOCK_TABLE = process.env.STOCK_TABLE!;

const ProdutoSchema = z.object({
  nome: z.string().min(2).max(150),
  codigo: z.string().max(50).optional(),
  descricao: z.string().max(500).optional(),
  categoria: z.string().max(100).optional(),
  precoCusto: z.number().nonnegative(),
  precoVenda: z.number().positive(),
  moeda: z.enum(['AOA', 'USD']).default('AOA'),
  unidade: z.enum(['un', 'kg', 'lt', 'mt', 'cx', 'pct']).default('un'),
  stockActual: z.number().int().nonnegative().default(0),
  stockMinimo: z.number().int().nonnegative().default(5),
  ativo: z.boolean().default(true),
});

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

export const criar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para criar produtos');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = ProdutoSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const id = uuidv4();
  const now = new Date().toISOString();

  const produto = {
    PK: `empresa#${auth.empresaId}`,
    SK: `produto#${id}`,
    GSI1PK: `tipo#produto`,
    GSI1SK: `data#${now.split('T')[0]}`,
    id,
    empresaId: auth.empresaId,
    ...parsed.data,
    margem: parsed.data.precoVenda > 0
      ? Number((((parsed.data.precoVenda - parsed.data.precoCusto) / parsed.data.precoVenda) * 100).toFixed(2))
      : 0,
    criadoPor: auth.userId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.send(new PutCommand({ TableName: STOCK_TABLE, Item: produto }));
    await registarAuditoria(auth, 'criar', 'produto', id, { nome: parsed.data.nome });
    return created({ id, ...parsed.data, createdAt: now });
  } catch (err) {
    logger.error('Erro ao criar produto', { error: String(err) });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const qs = event.queryStringParameters ?? {};
  const limite = Math.min(Number(qs.limite ?? 50), 100);
  const apenasStockCritico = qs.stockCritico === 'true';

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: STOCK_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: apenasStockCritico
          ? 'attribute_not_exists(deletedAt) AND ativo = :ativo AND stockActual <= stockMinimo'
          : 'attribute_not_exists(deletedAt) AND ativo = :ativo',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'produto#',
          ':ativo': true,
        },
        Limit: limite,
        ScanIndexForward: false,
      }),
    );

    return ok({
      items: result.Items ?? [],
      total: result.Count ?? 0,
      stockCritico: apenasStockCritico,
    });
  } catch (err) {
    logger.error('Erro ao listar produtos', { error: String(err) });
    return internalError();
  }
};

export const actualizar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden();

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do produto obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = ProdutoSchema.partial().safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const now = new Date().toISOString();
  const campos = Object.keys(parsed.data) as Array<keyof typeof parsed.data>;
  const updateExpr = ['updatedAt = :updatedAt', ...campos.map((c) => `${c} = :${c}`)].join(', ');
  const exprValues: Record<string, unknown> = { ':updatedAt': now };
  for (const c of campos) exprValues[`:${c}`] = parsed.data[c];

  try {
    await db.send(
      new UpdateCommand({
        TableName: STOCK_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `produto#${id}` },
        UpdateExpression: `SET ${updateExpr}`,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: exprValues,
      }),
    );
    await registarAuditoria(auth, 'actualizar', 'produto', id, parsed.data);
    return ok({ id, ...parsed.data, updatedAt: now });
  } catch (err) {
    logger.error('Erro ao actualizar produto', { error: String(err), id });
    return internalError();
  }
};
