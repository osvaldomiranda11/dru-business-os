/**
 * Gestão de Produtos — DRU Business OS Stock
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, QueryCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  db,
  ok,
  created,
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
  // Decimal, não só inteiro — unidades como kg/lt não fazem sentido só
  // com números inteiros (ex: 2.5kg em stock)
  stockActual: z.number().nonnegative().default(0),
  stockMinimo: z.number().nonnegative().default(5),
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
    // IMPORTANTE: o "Limit" do DynamoDB corta o número de itens AVALIADOS
    // antes do FilterExpression correr — não o número de itens que passam
    // no filtro. Como o SK é um UUID (ordem arbitrária, não por data),
    // usar Limit aqui podia "perder" produtos com stock crítico reais só
    // por calhar de terem um UUID que ordena mais tarde. Por isso pagina-se
    // tudo primeiro, e só se corta ao número pedido depois de filtrar.
    let items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
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
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items = items.concat(result.Items ?? []);
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);

    return ok({
      items: items.slice(0, limite),
      total: items.length,
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
  const exprValues: Record<string, unknown> = { ':updatedAt': now };
  for (const c of campos) exprValues[`:${c}`] = parsed.data[c];

  // A margem depende dos dois preços — se só um deles mudar (ex: só o
  // preço de venda), é preciso saber o outro (que não veio no pedido)
  // para recalcular correctamente. Sem isto, a margem guardada ficava
  // desactualizada silenciosamente sempre que se editava um preço.
  const precosAlterados = parsed.data.precoVenda !== undefined || parsed.data.precoCusto !== undefined;
  const camposUpdate = [...campos.map((c) => `${c} = :${c}`)];

  if (precosAlterados) {
    const actual = await db.send(
      new GetCommand({ TableName: STOCK_TABLE, Key: { PK: `empresa#${auth.empresaId}`, SK: `produto#${id}` } }),
    );
    if (!actual.Item || actual.Item.deletedAt) return notFound('Produto não encontrado');

    const precoVenda = parsed.data.precoVenda ?? (actual.Item.precoVenda as number);
    const precoCusto = parsed.data.precoCusto ?? (actual.Item.precoCusto as number);
    const margem = precoVenda > 0 ? Number((((precoVenda - precoCusto) / precoVenda) * 100).toFixed(2)) : 0;

    camposUpdate.push('margem = :margem');
    exprValues[':margem'] = margem;
  }

  const updateExpr = ['updatedAt = :updatedAt', ...camposUpdate].join(', ');

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
