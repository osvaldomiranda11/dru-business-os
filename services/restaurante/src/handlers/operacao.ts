import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db, ok, created, badRequest, unauthorized, forbidden, conflict, notFound, internalError, verifyToken, extractToken, logger } from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';
const TABLE = process.env.RESTAURANTE_TABLE!;
const STOCK_TABLE = process.env.STOCK_TABLE!;
const FATURACAO_TABLE = process.env.FATURACAO_TABLE!;
async function auth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> { const token = extractToken(event); return token ? verifyToken(token) : null; }
const MesaSchema = z.object({ nome: z.string().min(1).max(60), zona: z.string().max(60).optional(), lugares: z.number().int().positive().max(100).default(2) });
const PedidoSchema = z.object({ mesaId: z.string().uuid().optional(), tipo: z.enum(['mesa', 'balcao', 'takeaway']).default('mesa'), observacoes: z.string().max(500).optional() }).superRefine((pedido, context) => {
	if (pedido.tipo === 'mesa' && !pedido.mesaId) context.addIssue({ code: 'custom', message: 'Mesa obrigatoria para pedidos do tipo mesa', path: ['mesaId'] });
	if (pedido.tipo !== 'mesa' && pedido.mesaId) context.addIssue({ code: 'custom', message: 'Apenas pedidos do tipo mesa aceitam mesaId', path: ['mesaId'] });
});
const LinhaSchema = z.object({ produtoId: z.string().uuid(), nome: z.string().min(1).max(150), quantidade: z.number().positive(), precoUnitario: z.number().nonnegative(), observacoes: z.string().max(300).optional() });
const EstadoSchema = z.object({ estado: z.enum(['aberto', 'em_preparacao', 'pronto', 'entregue', 'fechado', 'cancelado']) });
const transicoesPedido: Record<string, string[]> = {
	aberto: ['em_preparacao', 'cancelado'],
	em_preparacao: ['pronto', 'cancelado'],
	pronto: ['entregue', 'cancelado'],
	entregue: ['cancelado'],
};
const ListarPedidosSchema = z.object({
	estado: z.enum(['aberto', 'em_preparacao', 'pronto', 'entregue', 'fechado', 'cancelado']).optional(),
	mesaId: z.string().uuid().optional(),
	limite: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.string().optional(),
});
const FaturarPedidoSchema = z.object({ clienteNome: z.string().min(2).max(150), clienteNif: z.string().regex(/^\d{9,14}$/).optional(), moeda: z.enum(['AOA', 'USD']).default('AOA'), ivaTaxa: z.number().min(0).max(100).default(14) });
function base(empresaId: string, sk: string) { return { PK: `empresa#${empresaId}`, SK: sk }; }
function parse<T>(body: string | null | undefined, schema: z.ZodType<T>): T | null { try { const result = schema.safeParse(JSON.parse(body ?? '{}')); return result.success ? result.data : null; } catch { return null; } }
function registoAuditoria(auth: AuthContext, acao: string, recurso: string, recursoId: string, detalhes: Record<string, unknown>, createdAt: string) {
	const id = uuidv4();
	return { PK: `empresa#${auth.empresaId}`, SK: `auditoria#${createdAt}#${id}`, GSI1PK: 'tipo#auditoria', GSI1SK: `data#${createdAt.slice(0, 10)}`, id, empresaId: auth.empresaId, utilizadorId: auth.userId, acao, recurso, recursoId, detalhes, createdAt };
}
function decodificarCursor(cursor?: string): Record<string, unknown> | undefined {
	if (!cursor) return undefined;
	try {
		const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).PK === 'string' && typeof (value as Record<string, unknown>).SK === 'string') return value as Record<string, unknown>;
	} catch { /* Cursor inválido é tratado pelo chamador. */ }
	throw new Error('Cursor inválido');
}
export const criarMesa: APIGatewayProxyHandler = async (event) => { const a = await auth(event); if (!a) return unauthorized(); if (a.role === 'viewer') return forbidden(); const data = parse(event.body, MesaSchema); if (!data) return badRequest('Dados invalidos'); const id = uuidv4(); const now = new Date().toISOString(); const item = { ...base(a.empresaId, `mesa#${id}`), tipo: 'mesa', id, empresaId: a.empresaId, ...data, estado: 'livre', createdAt: now, updatedAt: now }; try { await db.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } }, { Put: { TableName: process.env.AUDITORIA_TABLE!, Item: registoAuditoria(a, 'criar-mesa', 'mesa', id, { nome: data.nome }, now), ConditionExpression: 'attribute_not_exists(PK)' } }] })); return created(item); } catch (err) { logger.error('Erro ao criar mesa', { error: String(err) }); return internalError(); } };
export const listarMesas: APIGatewayProxyHandler = async (event) => { const a = await auth(event); if (!a) return unauthorized(); try { const r = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': `empresa#${a.empresaId}`, ':prefix': 'mesa#' } })); return ok({ items: r.Items ?? [], total: r.Count ?? 0 }); } catch (err) { logger.error('Erro ao listar mesas', { error: String(err) }); return internalError(); } };
export const listarPedidos: APIGatewayProxyHandler = async (event) => {
	const a = await auth(event);
	if (!a) return unauthorized();
	const filters = ListarPedidosSchema.safeParse(event.queryStringParameters ?? {});
	if (!filters.success) return badRequest('Filtros inválidos', filters.error.flatten().fieldErrors);
	let cursor: Record<string, unknown> | undefined;
	try { cursor = decodificarCursor(filters.data.cursor); } catch { return badRequest('Cursor inválido'); }
	if (cursor && (cursor.PK !== `empresa#${a.empresaId}` || !String(cursor.SK).startsWith('pedido#'))) return badRequest('Cursor inválido');
	const conditions: string[] = [];
	const values: Record<string, unknown> = { ':pk': `empresa#${a.empresaId}`, ':prefix': 'pedido#' };
	const names: Record<string, string> = {};
	if (filters.data.estado) { conditions.push('#state = :state'); names['#state'] = 'estado'; values[':state'] = filters.data.estado; }
	if (filters.data.mesaId) { conditions.push('mesaId = :mesaId'); values[':mesaId'] = filters.data.mesaId; }
	try {
		const result = await db.send(new QueryCommand({
			TableName: TABLE,
			KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
			...(conditions.length > 0 && { FilterExpression: conditions.join(' AND ') }),
			...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
			ExpressionAttributeValues: values,
			Limit: filters.data.limite,
			ScanIndexForward: false,
			ExclusiveStartKey: cursor,
		}));
		return ok({ items: result.Items ?? [], total: result.Count ?? 0, nextCursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null });
	} catch (err) {
		logger.error('Erro ao listar pedidos', { error: String(err), empresaId: a.empresaId });
		return internalError();
	}
};

export const abrirPedido: APIGatewayProxyHandler = async (event) => {
	const a = await auth(event);
	if (!a) return unauthorized();
	if (a.role === 'viewer') return forbidden('Sem permissao para abrir pedido');
	const data = parse(event.body, PedidoSchema);
	if (!data) return badRequest('Dados invalidos');
	const id = uuidv4();
	const now = new Date().toISOString();
	const item = { ...base(a.empresaId, `pedido#${id}`), tipo: 'pedido', id, empresaId: a.empresaId, ...data, estado: 'aberto', total: 0, linhas: [], abertoPor: a.userId, createdAt: now, updatedAt: now };
	const transacoes: Array<Record<string, unknown>> = [
		{ Put: { TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
	];
	if (data.mesaId) transacoes.push({
		Update: {
			TableName: TABLE,
			Key: base(a.empresaId, `mesa#${data.mesaId}`),
			UpdateExpression: 'SET #state = :occupied, pedidoId = :pedido, updatedAt = :now',
			ConditionExpression: 'attribute_exists(PK) AND #state = :free',
			ExpressionAttributeNames: { '#state': 'estado' },
			ExpressionAttributeValues: { ':occupied': 'ocupada', ':free': 'livre', ':pedido': id, ':now': now },
		},
	});
	transacoes.push({ Put: { TableName: process.env.AUDITORIA_TABLE!, Item: registoAuditoria(a, 'abrir-pedido', 'pedido', id, { mesaId: data.mesaId }, now), ConditionExpression: 'attribute_not_exists(PK)' } });
	try {
		await db.send(new TransactWriteCommand({ TransactItems: transacoes as never[] }));
		return created(item);
	} catch (err: unknown) {
		if ((err as { name?: string }).name === 'TransactionCanceledException') return conflict(data.mesaId ? 'Mesa indisponivel; atualize a lista e tente novamente' : 'Pedido ja foi criado; atualize a lista antes de tentar novamente');
		logger.error('Erro ao abrir pedido', { error: String(err), pedidoId: id, mesaId: data.mesaId });
		return internalError();
	}
};

export const adicionarLinha: APIGatewayProxyHandler = async (event) => {
	const a = await auth(event);
	if (!a) return unauthorized();
	if (a.role === 'viewer') return forbidden('Sem permissao para adicionar linhas');
	const pedidoId = event.pathParameters?.id;
	if (!pedidoId) return badRequest('ID do pedido obrigatorio');
	const data = parse(event.body, LinhaSchema);
	if (!data) return badRequest('Dados invalidos');
	const linha = { id: uuidv4(), ...data, total: Number((data.quantidade * data.precoUnitario).toFixed(2)) };
	try {
		const result = await db.send(new UpdateCommand({
			TableName: TABLE,
			Key: base(a.empresaId, `pedido#${pedidoId}`),
			UpdateExpression: 'SET linhas = list_append(if_not_exists(linhas, :empty), :newLines), #total = if_not_exists(#total, :zero) + :lineTotal, updatedAt = :now',
			ConditionExpression: '#state IN (:open, :preparing)',
			ExpressionAttributeNames: { '#state': 'estado', '#total': 'total' },
			ExpressionAttributeValues: { ':empty': [], ':newLines': [linha], ':zero': 0, ':lineTotal': linha.total, ':now': new Date().toISOString(), ':open': 'aberto', ':preparing': 'em_preparacao' },
			ReturnValues: 'ALL_NEW',
		}));
		return ok({ pedidoId, linha, total: result.Attributes?.total ?? linha.total });
	} catch (err: unknown) {
		if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return conflict('Pedido nao encontrado ou encerrado');
		logger.error('Erro ao adicionar linha', { error: String(err), pedidoId });
		return internalError();
	}
};

export const alterarEstado: APIGatewayProxyHandler = async (event) => {
	const a = await auth(event);
	if (!a) return unauthorized();
	const id = event.pathParameters?.id;
	const data = parse(event.body, EstadoSchema);
	if (!id || !data) return badRequest('Dados invalidos');
	if (a.role === 'viewer') return forbidden('Sem permissao para alterar o pedido');
	if (data.estado === 'fechado') return conflict('Use o endpoint de fecho para aplicar stock e libertar mesa');
	try {
		const orderResult = await db.send(new GetCommand({ TableName: TABLE, Key: base(a.empresaId, `pedido#${id}`), ConsistentRead: true }));
		const order = orderResult.Item;
		if (!order) return notFound('Pedido nao encontrado');
		if (order.estado === data.estado) return ok({ id, estado: data.estado, jaEstavaAtualizado: true });
		if (['fechado', 'cancelado'].includes(String(order.estado))) return conflict('Pedido ja encerrado');
		if (!transicoesPedido[String(order.estado)]?.includes(data.estado)) return conflict('Transicao de estado invalida para o pedido');
		const now = new Date().toISOString();
		const transacoes: Array<Record<string, unknown>> = [{
			Update: {
				TableName: TABLE,
				Key: base(a.empresaId, `pedido#${id}`),
				UpdateExpression: 'SET #state = :next, actualizadoPor = :user, updatedAt = :now',
				ConditionExpression: '#state = :current',
				ExpressionAttributeNames: { '#state': 'estado' },
				ExpressionAttributeValues: { ':next': data.estado, ':current': order.estado, ':user': a.userId, ':now': now },
			},
		}];
		if (data.estado === 'cancelado' && typeof order.mesaId === 'string') {
			const mesaResult = await db.send(new GetCommand({ TableName: TABLE, Key: base(a.empresaId, `mesa#${order.mesaId}`), ConsistentRead: true }));
			if (mesaResult.Item?.pedidoId === id && mesaResult.Item.estado === 'ocupada') transacoes.push({
				Update: {
					TableName: TABLE,
					Key: base(a.empresaId, `mesa#${order.mesaId}`),
					UpdateExpression: 'SET #state = :free, updatedAt = :now REMOVE pedidoId',
					ConditionExpression: '#state = :occupied AND pedidoId = :pedido',
					ExpressionAttributeNames: { '#state': 'estado' },
					ExpressionAttributeValues: { ':free': 'livre', ':occupied': 'ocupada', ':now': now, ':pedido': id },
				},
			});
		}
		transacoes.push({ Put: { TableName: process.env.AUDITORIA_TABLE!, Item: registoAuditoria(a, 'alterar-estado-pedido', 'pedido', id, data, now), ConditionExpression: 'attribute_not_exists(PK)' } });
		await db.send(new TransactWriteCommand({ TransactItems: transacoes as never[] }));
		return ok({ id, estado: data.estado });
	} catch (err: unknown) {
		if ((err as { name?: string }).name === 'TransactionCanceledException') return conflict('Pedido alterado em simultaneo; atualize a lista');
		logger.error('Erro ao alterar estado do pedido', { error: String(err), id });
		return internalError();
	}
};

export const fecharPedido: APIGatewayProxyHandler = async (event) => {
	const a = await auth(event);
	if (!a) return unauthorized();
	if (a.role === 'viewer') return forbidden('Sem permissao para fechar pedido');
	const pedidoId = event.pathParameters?.id;
	if (!pedidoId) return badRequest('ID do pedido obrigatorio');

	try {
		const pedidoResult = await db.send(new GetCommand({ TableName: TABLE, Key: base(a.empresaId, `pedido#${pedidoId}`), ConsistentRead: true }));
		const pedido = pedidoResult.Item;
		if (!pedido || ['fechado', 'cancelado'].includes(String(pedido.estado))) return conflict('Pedido inexistente ou ja encerrado');
		if (pedido.estado !== 'entregue') return conflict('Pedido deve estar entregue antes do fecho');
		if (pedido.stockAplicado === true) return ok({ pedidoId, estado: 'fechado', stockAplicado: true, total: pedido.total });

		const linhas = (pedido.linhas as Array<{ produtoId: string; quantidade: number; nome: string; total: number }> | undefined) ?? [];
		if (linhas.length === 0) return badRequest('Pedido sem linhas');
		const linhasAgregadas = Array.from(linhas.reduce((agregadas, linha) => {
			const atual = agregadas.get(linha.produtoId) ?? { ...linha, quantidade: 0, total: 0 };
			atual.quantidade += linha.quantidade;
			atual.total += linha.total;
			agregadas.set(linha.produtoId, atual);
			return agregadas;
		}, new Map<string, { produtoId: string; quantidade: number; nome: string; total: number }>()).values());
		const produtos = await Promise.all(linhasAgregadas.map((linha) => db.send(new GetCommand({ TableName: STOCK_TABLE, Key: base(a.empresaId, `produto#${linha.produtoId}`), ConsistentRead: true }))));
		if (produtos.some((produto) => !produto.Item || produto.Item.ativo === false)) return conflict('Um ou mais produtos nao existem ou estao inativos');

		const agora = new Date().toISOString();
		const transacoes: Array<Record<string, unknown>> = linhasAgregadas.flatMap((linha) => {
			const movimentoId = uuidv4();
			return [
				{
					Put: {
						TableName: STOCK_TABLE,
						Item: {
							...base(a.empresaId, `movimento#${agora.slice(0, 10)}#${movimentoId}`),
							GSI1PK: `produto#${linha.produtoId}`,
							GSI1SK: `data#${agora.slice(0, 10)}`,
							id: movimentoId,
							empresaId: a.empresaId,
							produtoId: linha.produtoId,
							tipo: 'saida',
							quantidade: linha.quantidade,
							delta: -linha.quantidade,
							motivo: 'venda',
							pedidoId,
							criadoPor: a.userId,
							createdAt: agora,
						},
					},
				},
				{
					Update: {
						TableName: STOCK_TABLE,
						Key: base(a.empresaId, `produto#${linha.produtoId}`),
						UpdateExpression: 'SET updatedAt = :now ADD stockActual :delta',
						ConditionExpression: 'attribute_exists(PK) AND ativo = :ativo AND stockActual >= :quantidade',
						ExpressionAttributeValues: { ':now': agora, ':delta': -linha.quantidade, ':ativo': true, ':quantidade': linha.quantidade },
					},
				},
			];
		});
		transacoes.push({
			Update: {
				TableName: TABLE,
				Key: base(a.empresaId, `pedido#${pedidoId}`),
				UpdateExpression: 'SET estado = :fechado, stockAplicado = :sim, fechadoPor = :user, fechadoEm = :now, updatedAt = :now',
				ConditionExpression: 'estado = :entregue AND attribute_not_exists(stockAplicado)',
				ExpressionAttributeValues: { ':fechado': 'fechado', ':entregue': 'entregue', ':sim': true, ':user': a.userId, ':now': agora },
			},
		});
		let libertouMesa = false;
		if (typeof pedido.mesaId === 'string') {
			const mesaResult = await db.send(new GetCommand({ TableName: TABLE, Key: base(a.empresaId, `mesa#${pedido.mesaId}`), ConsistentRead: true }));
			if (mesaResult.Item?.pedidoId === pedidoId && mesaResult.Item.estado === 'ocupada') {
				transacoes.push({ Update: {
					TableName: TABLE,
					Key: base(a.empresaId, `mesa#${pedido.mesaId}`),
					UpdateExpression: 'SET #state = :free, updatedAt = :now REMOVE pedidoId',
					ConditionExpression: '#state = :occupied AND pedidoId = :pedido',
					ExpressionAttributeNames: { '#state': 'estado' },
					ExpressionAttributeValues: { ':free': 'livre', ':occupied': 'ocupada', ':now': agora, ':pedido': pedidoId },
				} });
				libertouMesa = true;
			}
		}
		transacoes.push({ Put: { TableName: process.env.AUDITORIA_TABLE!, Item: registoAuditoria(a, 'fechar-pedido', 'pedido', pedidoId, { total: pedido.total, linhas: linhasAgregadas.length, stockAplicado: true, mesaLibertada: libertouMesa }, agora), ConditionExpression: 'attribute_not_exists(PK)' } });

		await db.send(new TransactWriteCommand({ TransactItems: transacoes as never[] }));
		return ok({ pedidoId, estado: 'fechado', stockAplicado: true, mesaLibertada: libertouMesa, total: pedido.total });
	} catch (err: unknown) {
		if ((err as { name?: string }).name === 'TransactionCanceledException') return conflict('Stock insuficiente ou pedido ja fechado');
		logger.error('Erro ao fechar pedido', { error: String(err), pedidoId });
		return internalError();
	}
};

export const faturarPedido: APIGatewayProxyHandler = async (event) => {
	const a = await auth(event);
	if (!a) return unauthorized();
	if (a.role === 'viewer') return forbidden('Sem permissao para emitir fatura');
	const pedidoId = event.pathParameters?.id;
	if (!pedidoId) return badRequest('ID do pedido obrigatorio');
	const dados = parse(event.body, FaturarPedidoSchema);
	if (!dados) return badRequest('Dados invalidos');

	try {
		const pedidoResult = await db.send(new GetCommand({ TableName: TABLE, Key: base(a.empresaId, `pedido#${pedidoId}`), ConsistentRead: true }));
		const pedido = pedidoResult.Item;
		if (!pedido || pedido.estado !== 'fechado' || pedido.stockAplicado !== true) return conflict('Pedido deve estar fechado com stock aplicado');
		if (pedido.faturaId) return ok({ pedidoId, faturaId: pedido.faturaId, jaExistia: true });

		const ano = new Date().getUTCFullYear();
		const sequencialResult = await db.send(new UpdateCommand({
			TableName: FATURACAO_TABLE,
			Key: { PK: `empresa#${a.empresaId}`, SK: `contador#fatura#${ano}` },
			UpdateExpression: 'ADD sequencial :inc SET updatedAt = :now',
			ExpressionAttributeValues: { ':inc': 1, ':now': new Date().toISOString() },
			ReturnValues: 'UPDATED_NEW',
		}));
		const sequencial = Number(sequencialResult.Attributes?.sequencial ?? 1);
		const numero = `FT ${ano}/${String(sequencial).padStart(6, '0')}`;
		const faturaId = uuidv4();
		const dataEmissao = new Date().toISOString().split('T')[0];
		const ivaTaxa = dados.ivaTaxa ?? 14;
		const linhas = (pedido.linhas as Array<{ produtoId: string; nome: string; quantidade: number; precoUnitario: number; total: number }>).map((linha) => {
			const subtotal = Number(linha.total.toFixed(2));
			const ivaValor = Number((subtotal * (ivaTaxa / 100)).toFixed(2));
			return { descricao: linha.nome, produtoId: linha.produtoId, quantidade: linha.quantidade, precoUnitario: linha.precoUnitario, ivaTaxa, subtotal, ivaValor, total: Number((subtotal + ivaValor).toFixed(2)) };
		});
		const subtotal = Number(linhas.reduce((total, linha) => total + linha.subtotal, 0).toFixed(2));
		const totalIva = Number(linhas.reduce((total, linha) => total + linha.ivaValor, 0).toFixed(2));
		const total = Number((subtotal + totalIva).toFixed(2));
		const agora = new Date().toISOString();

		const transacoes: Array<Record<string, unknown>> = [
			{ Put: { TableName: FATURACAO_TABLE, Item: { ...base(a.empresaId, `fatura#${ano}#${String(sequencial).padStart(6, '0')}`), GSI1PK: 'tipo#fatura', GSI1SK: `data#${dataEmissao}#${numero}`, id: faturaId, empresaId: a.empresaId, numero, ano, sequencial, clienteNome: dados.clienteNome, clienteNif: dados.clienteNif, moeda: dados.moeda, estado: 'pendente', linhas, subtotal, totalIva, total, totalPago: 0, dataEmissao, criadoPor: a.userId, pedidoId, createdAt: agora, updatedAt: agora }, ConditionExpression: 'attribute_not_exists(PK)' } },
			{ Update: { TableName: TABLE, Key: base(a.empresaId, `pedido#${pedidoId}`), UpdateExpression: 'SET faturaId = :faturaId, faturaNumero = :numero, updatedAt = :now', ConditionExpression: 'estado = :fechado AND stockAplicado = :sim AND attribute_not_exists(faturaId)', ExpressionAttributeValues: { ':faturaId': faturaId, ':numero': numero, ':now': agora, ':fechado': 'fechado', ':sim': true } } },
		];
		transacoes.push({ Put: { TableName: process.env.AUDITORIA_TABLE!, Item: registoAuditoria(a, 'emitir-fatura-pedido', 'pedido', pedidoId, { faturaId, numero, total }, agora), ConditionExpression: 'attribute_not_exists(PK)' } });
		await db.send(new TransactWriteCommand({ TransactItems: transacoes as never[] }));
		return created({ pedidoId, faturaId, numero, subtotal, totalIva, total, moeda: dados.moeda });
	} catch (err: unknown) {
		if ((err as { name?: string }).name === 'TransactionCanceledException') return conflict('Pedido ja faturado ou numeracao indisponivel');
		logger.error('Erro ao faturar pedido', { error: String(err), pedidoId });
		return internalError();
	}
};
