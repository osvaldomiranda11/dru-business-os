import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db, ok, created, badRequest, unauthorized, forbidden, conflict, internalError, verifyToken, extractToken, logger } from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const RESTAURANTE_TABLE = process.env.RESTAURANTE_TABLE!;
const MovimentoSchema = z.object({ tipo: z.enum(['entrada', 'saida', 'sangria', 'reforco']), valor: z.number().positive(), metodo: z.enum(['numerario', 'cartao', 'multicaixa', 'transferencia', 'outro']).default('numerario'), motivo: z.string().min(2).max(200) });
const AbrirSchema = z.object({ fundoInicial: z.number().nonnegative(), observacoes: z.string().max(500).optional() });
const FecharSchema = z.object({ numerarioContado: z.number().nonnegative(), observacoes: z.string().max(500).optional() });

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> { const token = extractToken(event); return token ? verifyToken(token) : null; }
function key(empresaId: string, id: string): { PK: string; SK: string } { return { PK: `empresa#${empresaId}`, SK: `caixa#${id}` }; }
function parseBody(body: string | null): unknown | null { try { return JSON.parse(body ?? '{}'); } catch { return null; } }
function auditItem(auth: AuthContext, acao: string, recursoId: string, detalhes: Record<string, unknown>, createdAt: string) { const id = uuidv4(); return { PK: `empresa#${auth.empresaId}`, SK: `auditoria#${createdAt}#${id}`, GSI1PK: 'tipo#auditoria', GSI1SK: `data#${createdAt.slice(0, 10)}`, id, empresaId: auth.empresaId, utilizadorId: auth.userId, acao, recurso: 'caixa', recursoId, detalhes, createdAt }; }

export const abrir: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event); if (!auth) return unauthorized(); if (auth.role === 'viewer') return forbidden('Sem permissao para abrir caixa');
  const body = parseBody(event.body); if (body === null) return badRequest('JSON malformado'); const parsed = AbrirSchema.safeParse(body); if (!parsed.success) return badRequest('Dados invalidos', parsed.error.flatten().fieldErrors);
  const lockKey = { PK: `empresa#${auth.empresaId}`, SK: 'lock#caixa-aberto' };
  try {
    const lock = await db.send(new GetCommand({ TableName: RESTAURANTE_TABLE, Key: lockKey, ConsistentRead: true }));
    if (lock.Item) return conflict('Ja existe um caixa aberto');
    let cursor: Record<string, unknown> | undefined;
    do {
      const existing = await db.send(new QueryCommand({
        TableName: RESTAURANTE_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: '#type = :cash AND #state = :open',
        ExpressionAttributeNames: { '#type': 'tipo', '#state': 'estado' },
        ExpressionAttributeValues: { ':pk': `empresa#${auth.empresaId}`, ':prefix': 'caixa#', ':cash': 'caixa', ':open': 'aberto' },
        ExclusiveStartKey: cursor,
      }));
      if ((existing.Items?.length ?? 0) > 0) return conflict('Ja existe um caixa aberto');
      cursor = existing.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);

    const id = uuidv4(); const now = new Date().toISOString();
    const item = { ...key(auth.empresaId, id), tipo: 'caixa', id, empresaId: auth.empresaId, estado: 'aberto', abertoPor: auth.userId, fundoInicial: parsed.data.fundoInicial, totalEntradas: parsed.data.fundoInicial, totalSaidas: 0, totalVendas: 0, observacoes: parsed.data.observacoes, createdAt: now, updatedAt: now };
    const lockItem = { ...lockKey, tipo: 'lock_caixa', caixaId: id, createdAt: now };
    await db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: RESTAURANTE_TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: RESTAURANTE_TABLE, Item: lockItem, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: process.env.AUDITORIA_TABLE!, Item: auditItem(auth, 'abrir-caixa', id, { fundoInicial: parsed.data.fundoInicial }, now), ConditionExpression: 'attribute_not_exists(PK)' } },
    ] }));
    return created(item);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') return conflict('Ja existe um caixa aberto ou a abertura foi alterada em simultaneo');
    logger.error('Erro ao abrir caixa', { error: String(err) });
    return internalError();
  }
};

export const movimentar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event); if (!auth) return unauthorized(); if (auth.role === 'viewer') return forbidden('Sem permissao para movimentar caixa');
  const caixaId = event.pathParameters?.id; if (!caixaId) return badRequest('ID do caixa obrigatorio'); const body = parseBody(event.body); if (body === null) return badRequest('JSON malformado'); const parsed = MovimentoSchema.safeParse(body); if (!parsed.success) return badRequest('Dados invalidos', parsed.error.flatten().fieldErrors);
  const caixa = await db.send(new GetCommand({ TableName: RESTAURANTE_TABLE, Key: key(auth.empresaId, caixaId), ConsistentRead: true })); if (!caixa.Item || caixa.Item.estado !== 'aberto') return conflict('Caixa inexistente ou fechado');
  const id = uuidv4(); const now = new Date().toISOString(); const { tipo: tipoMovimento, ...dadosMovimento } = parsed.data; const delta = ['entrada', 'reforco'].includes(tipoMovimento) ? parsed.data.valor : -parsed.data.valor; const movimento = { ...key(auth.empresaId, `${caixaId}#movimento#${id}`), tipo: 'movimento_caixa', tipoMovimento, id, caixaId, empresaId: auth.empresaId, ...dadosMovimento, delta, criadoPor: auth.userId, createdAt: now };
  try {
    await db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: RESTAURANTE_TABLE, Item: movimento } },
      { Update: { TableName: RESTAURANTE_TABLE, Key: key(auth.empresaId, caixaId), UpdateExpression: 'SET updatedAt = :now ADD totalEntradas :entrada, totalSaidas :saida', ConditionExpression: 'estado = :aberto', ExpressionAttributeValues: { ':now': now, ':aberto': 'aberto', ':entrada': delta > 0 ? parsed.data.valor : 0, ':saida': delta < 0 ? parsed.data.valor : 0 } } },
      { Put: { TableName: process.env.AUDITORIA_TABLE!, Item: auditItem(auth, 'movimento-caixa', caixaId, parsed.data, now), ConditionExpression: 'attribute_not_exists(PK)' } },
    ] }));
    return created({ id, caixaId, ...parsed.data, delta });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') return conflict('Caixa foi fechado ou alterado em simultaneo');
    logger.error('Erro ao movimentar caixa', { error: String(err) });
    return internalError();
  }
};

export const fechar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer' || auth.role === 'vendedor') return forbidden('Apenas gestores podem fechar caixa');
  const caixaId = event.pathParameters?.id;
  if (!caixaId) return badRequest('ID do caixa obrigatorio');
  const body = parseBody(event.body);
  if (body === null) return badRequest('JSON malformado');
  const parsed = FecharSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados invalidos', parsed.error.flatten().fieldErrors);

  const now = new Date().toISOString();
  const caixa = await db.send(new GetCommand({ TableName: RESTAURANTE_TABLE, Key: key(auth.empresaId, caixaId), ConsistentRead: true }));
  if (!caixa.Item || caixa.Item.estado !== 'aberto') return conflict('Caixa inexistente ou ja fechado');
  const esperado = Number(caixa.Item.totalEntradas ?? 0) - Number(caixa.Item.totalSaidas ?? 0);
  const diferenca = parsed.data.numerarioContado - esperado;
  const lockKey = { PK: `empresa#${auth.empresaId}`, SK: 'lock#caixa-aberto' };

  try {
    const lock = await db.send(new GetCommand({ TableName: RESTAURANTE_TABLE, Key: lockKey, ConsistentRead: true }));
    const transacoes: Array<Record<string, unknown>> = [{ Update: {
      TableName: RESTAURANTE_TABLE,
      Key: key(auth.empresaId, caixaId),
      UpdateExpression: 'SET estado = :closed, fechadoPor = :user, fechadoEm = :now, numerarioContado = :counted, valorEsperado = :expected, diferenca = :difference, observacoesFecho = :observations, updatedAt = :now',
      ConditionExpression: 'estado = :open',
      ExpressionAttributeValues: { ':closed': 'fechado', ':open': 'aberto', ':user': auth.userId, ':now': now, ':counted': parsed.data.numerarioContado, ':expected': esperado, ':difference': diferenca, ':observations': parsed.data.observacoes ?? null },
    } }];
    if (lock.Item?.caixaId === caixaId) transacoes.push({ Delete: {
      TableName: RESTAURANTE_TABLE,
      Key: lockKey,
      ConditionExpression: 'caixaId = :caixaId',
      ExpressionAttributeValues: { ':caixaId': caixaId },
    } });
    transacoes.push({ Put: {
      TableName: process.env.AUDITORIA_TABLE!,
      Item: auditItem(auth, 'fechar-caixa', caixaId, { esperado, contado: parsed.data.numerarioContado, diferenca }, now),
      ConditionExpression: 'attribute_not_exists(PK)',
    } });
    await db.send(new TransactWriteCommand({ TransactItems: transacoes as never[] }));
    return ok({ caixaId, estado: 'fechado', esperado, contado: parsed.data.numerarioContado, diferenca });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') return conflict('Caixa ja fechado ou alterado em simultaneo');
    logger.error('Erro ao fechar caixa', { error: String(err) });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  try {
    let items: Record<string, unknown>[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await db.send(new QueryCommand({
        TableName: RESTAURANTE_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: '#type = :cash',
        ExpressionAttributeNames: { '#type': 'tipo' },
        ExpressionAttributeValues: { ':pk': `empresa#${auth.empresaId}`, ':prefix': 'caixa#', ':cash': 'caixa' },
        ScanIndexForward: false,
        Limit: 100,
        ExclusiveStartKey: cursor,
      }));
      items = items.concat((result.Items ?? []) as Record<string, unknown>[]);
      cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor && items.length < 100);
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return ok({ items: items.slice(0, 100), total: items.length });
  } catch (err) {
    logger.error('Erro ao listar caixas', { error: String(err) });
    return internalError();
  }
};
