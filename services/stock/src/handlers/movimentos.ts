/**
 * Movimentos de Stock — DRU Business OS
 *
 * Regista entradas e saídas com rastreabilidade completa.
 * Actualiza stockActual via DynamoDB atomic counter.
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
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
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

const eventBridge = new EventBridgeClient({ region: 'af-south-1' });

const MovimentoSchema = z.object({
  produtoId: z.string().uuid('ID do produto inválido'),
  tipo: z.enum(['entrada', 'saida']),
  quantidade: z.number().int().positive('Quantidade deve ser um inteiro positivo'),
  motivo: z.enum(['compra', 'venda', 'ajuste', 'devolucao', 'perda']),
  observacoes: z.string().max(500).optional(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().split('T')[0]),
});

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

export const registar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para registar movimentos');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = MovimentoSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const { produtoId, tipo, quantidade, motivo, observacoes, data } = parsed.data;
  const id = uuidv4();
  const now = new Date().toISOString();
  const delta = tipo === 'entrada' ? quantidade : -quantidade;

  const movimento = {
    PK: `empresa#${auth.empresaId}`,
    SK: `movimento#${data}#${id}`,
    GSI1PK: `produto#${produtoId}`,
    GSI1SK: `data#${data}`,
    id,
    empresaId: auth.empresaId,
    produtoId,
    tipo,
    quantidade,
    delta,
    motivo,
    observacoes,
    data,
    criadoPor: auth.userId,
    createdAt: now,
  };

  try {
    // Gravar movimento e actualizar stock atomicamente
    await Promise.all([
      db.send(new PutCommand({ TableName: STOCK_TABLE, Item: movimento })),
      db.send(
        new UpdateCommand({
          TableName: STOCK_TABLE,
          Key: { PK: `empresa#${auth.empresaId}`, SK: `produto#${produtoId}` },
          UpdateExpression: 'SET stockActual = stockActual + :delta, updatedAt = :updatedAt',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':delta': delta, ':updatedAt': now },
        }),
      ),
    ]);

    // Publicar evento no EventBridge para verificação de stock mínimo
    await eventBridge.send(
      new PutEventsCommand({
        Entries: [{
          EventBusName: EVENT_BUS_NAME,
          Source: 'dru-bos.stock',
          DetailType: 'MovimentoRegistado',
          Detail: JSON.stringify({
            empresaId: auth.empresaId,
            produtoId,
            tipo,
            quantidade,
            delta,
          }),
        }],
      }),
    );

    await registarAuditoria(auth, 'registar-movimento', 'stock', produtoId, { tipo, quantidade, motivo });
    return created({ id, produtoId, tipo, quantidade, delta, data, createdAt: now });
  } catch (err) {
    logger.error('Erro ao registar movimento', { error: String(err), produtoId });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const qs = event.queryStringParameters ?? {};
  const produtoId = qs.produtoId;
  const limite = Math.min(Number(qs.limite ?? 50), 100);

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: STOCK_TABLE,
        ...(produtoId
          ? {
              IndexName: 'GSI1',
              KeyConditionExpression: 'GSI1PK = :gsi1pk',
              ExpressionAttributeValues: { ':gsi1pk': `produto#${produtoId}` },
            }
          : {
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
              ExpressionAttributeValues: {
                ':pk': `empresa#${auth.empresaId}`,
                ':prefix': 'movimento#',
              },
            }),
        Limit: limite,
        ScanIndexForward: false,
      }),
    );

    return ok({ items: result.Items ?? [], total: result.Count ?? 0 });
  } catch (err) {
    logger.error('Erro ao listar movimentos', { error: String(err) });
    return internalError();
  }
};
