import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db, ok, created, badRequest, unauthorized, forbidden, conflict, internalError, verifyToken, extractToken, registarAuditoria, logger } from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const RESTAURANTE_TABLE = process.env.RESTAURANTE_TABLE!;
const MovimentoSchema = z.object({ tipo: z.enum(['entrada', 'saida', 'sangria', 'reforco']), valor: z.number().positive(), metodo: z.enum(['numerario', 'cartao', 'multicaixa', 'transferencia', 'outro']).default('numerario'), motivo: z.string().min(2).max(200) });
const AbrirSchema = z.object({ fundoInicial: z.number().nonnegative(), observacoes: z.string().max(500).optional() });
const FecharSchema = z.object({ numerarioContado: z.number().nonnegative(), observacoes: z.string().max(500).optional() });

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> { const token = extractToken(event); return token ? verifyToken(token) : null; }
function key(empresaId: string, id: string): { PK: string; SK: string } { return { PK: `empresa#${empresaId}`, SK: `caixa#${id}` }; }
function parseBody(body: string | null): unknown | null { try { return JSON.parse(body ?? '{}'); } catch { return null; } }

export const abrir: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event); if (!auth) return unauthorized(); if (auth.role === 'viewer') return forbidden('Sem permissao para abrir caixa');
  const body = parseBody(event.body); if (body === null) return badRequest('JSON malformado'); const parsed = AbrirSchema.safeParse(body); if (!parsed.success) return badRequest('Dados invalidos', parsed.error.flatten().fieldErrors);
  const existente = await db.send(new QueryCommand({ TableName: RESTAURANTE_TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', FilterExpression: 'estado = :estado', ExpressionAttributeValues: { ':pk': `empresa#${auth.empresaId}`, ':prefix': 'caixa#', ':estado': 'aberto' }, Limit: 1 }));
  if ((existente.Items?.length ?? 0) > 0) return conflict('Ja existe um caixa aberto');
  const id = uuidv4(); const now = new Date().toISOString(); const item = { ...key(auth.empresaId, id), tipo: 'caixa', id, empresaId: auth.empresaId, estado: 'aberto', abertoPor: auth.userId, fundoInicial: parsed.data.fundoInicial, totalEntradas: parsed.data.fundoInicial, totalSaidas: 0, totalVendas: 0, observacoes: parsed.data.observacoes, createdAt: now, updatedAt: now };
  try { await db.send(new PutCommand({ TableName: RESTAURANTE_TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' })); await registarAuditoria(auth, 'abrir-caixa', 'caixa', id, { fundoInicial: parsed.data.fundoInicial }); return created(item); } catch (err) { logger.error('Erro ao abrir caixa', { error: String(err) }); return internalError(); }
};

export const movimentar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event); if (!auth) return unauthorized(); if (auth.role === 'viewer') return forbidden('Sem permissao para movimentar caixa');
  const caixaId = event.pathParameters?.id; if (!caixaId) return badRequest('ID do caixa obrigatorio'); const body = parseBody(event.body); if (body === null) return badRequest('JSON malformado'); const parsed = MovimentoSchema.safeParse(body); if (!parsed.success) return badRequest('Dados invalidos', parsed.error.flatten().fieldErrors);
  const caixa = await db.send(new GetCommand({ TableName: RESTAURANTE_TABLE, Key: key(auth.empresaId, caixaId), ConsistentRead: true })); if (!caixa.Item || caixa.Item.estado !== 'aberto') return conflict('Caixa inexistente ou fechado');
  const id = uuidv4(); const now = new Date().toISOString(); const { tipo: tipoMovimento, ...dadosMovimento } = parsed.data; const delta = ['entrada', 'reforco'].includes(tipoMovimento) ? parsed.data.valor : -parsed.data.valor; const movimento = { ...key(auth.empresaId, `${caixaId}#movimento#${id}`), tipo: 'movimento_caixa', tipoMovimento, id, caixaId, empresaId: auth.empresaId, ...dadosMovimento, delta, criadoPor: auth.userId, createdAt: now };
  try { await db.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: RESTAURANTE_TABLE, Item: movimento } }, { Update: { TableName: RESTAURANTE_TABLE, Key: key(auth.empresaId, caixaId), UpdateExpression: 'SET updatedAt = :now ADD totalEntradas :entrada, totalSaidas :saida', ConditionExpression: 'estado = :aberto', ExpressionAttributeValues: { ':now': now, ':aberto': 'aberto', ':entrada': delta > 0 ? parsed.data.valor : 0, ':saida': delta < 0 ? parsed.data.valor : 0 } } }] })); await registarAuditoria(auth, 'movimento-caixa', 'caixa', caixaId, parsed.data); return created({ id, caixaId, ...parsed.data, delta }); } catch (err) { logger.error('Erro ao movimentar caixa', { error: String(err) }); return internalError(); }
};

export const fechar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event); if (!auth) return unauthorized(); if (auth.role === 'viewer' || auth.role === 'vendedor') return forbidden('Apenas gestores podem fechar caixa'); const caixaId = event.pathParameters?.id; if (!caixaId) return badRequest('ID do caixa obrigatorio'); const body = parseBody(event.body); if (body === null) return badRequest('JSON malformado'); const parsed = FecharSchema.safeParse(body); if (!parsed.success) return badRequest('Dados invalidos', parsed.error.flatten().fieldErrors);
  const now = new Date().toISOString(); const caixa = await db.send(new GetCommand({ TableName: RESTAURANTE_TABLE, Key: key(auth.empresaId, caixaId), ConsistentRead: true })); if (!caixa.Item || caixa.Item.estado !== 'aberto') return conflict('Caixa inexistente ou ja fechado'); const esperado = Number(caixa.Item.totalEntradas ?? 0) - Number(caixa.Item.totalSaidas ?? 0); const diferenca = parsed.data.numerarioContado - esperado;
  try { await db.send(new UpdateCommand({ TableName: RESTAURANTE_TABLE, Key: key(auth.empresaId, caixaId), UpdateExpression: 'SET estado = :fechado, fechadoPor = :user, fechadoEm = :now, numerarioContado = :contado, valorEsperado = :esperado, diferenca = :diferenca, observacoesFecho = :obs, updatedAt = :now', ConditionExpression: 'estado = :aberto', ExpressionAttributeValues: { ':fechado': 'fechado', ':aberto': 'aberto', ':user': auth.userId, ':now': now, ':contado': parsed.data.numerarioContado, ':esperado': esperado, ':diferenca': diferenca, ':obs': parsed.data.observacoes ?? null } })); await registarAuditoria(auth, 'fechar-caixa', 'caixa', caixaId, { esperado, contado: parsed.data.numerarioContado, diferenca }); return ok({ caixaId, estado: 'fechado', esperado, contado: parsed.data.numerarioContado, diferenca }); } catch (err) { logger.error('Erro ao fechar caixa', { error: String(err) }); return internalError(); }
};

export const listar: APIGatewayProxyHandler = async (event) => { const auth = await getAuth(event); if (!auth) return unauthorized(); try { const result = await db.send(new QueryCommand({ TableName: RESTAURANTE_TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': `empresa#${auth.empresaId}`, ':prefix': 'caixa#' }, ScanIndexForward: false, Limit: 100 })); return ok({ items: result.Items ?? [], total: result.Count ?? 0 }); } catch (err) { logger.error('Erro ao listar caixas', { error: String(err) }); return internalError(); } };
