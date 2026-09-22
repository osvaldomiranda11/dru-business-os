import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db, ok, created, badRequest, unauthorized, forbidden, conflict, notFound, internalError, verifyToken, extractToken, registarAuditoria, logger } from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';
const TABLE = process.env.RESTAURANTE_TABLE!;
const STOCK_TABLE = process.env.STOCK_TABLE!;
const FATURACAO_TABLE = process.env.FATURACAO_TABLE!;
async function auth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> { const token = extractToken(event); return token ? verifyToken(token) : null; }
const MesaSchema = z.object({ nome: z.string().min(1).max(60), zona: z.string().max(60).optional(), lugares: z.number().int().positive().max(100).default(2) });
const PedidoSchema = z.object({ mesaId: z.string().uuid().optional(), tipo: z.enum(['mesa', 'balcao', 'takeaway']).default('mesa'), observacoes: z.string().max(500).optional() });
const LinhaSchema = z.object({ produtoId: z.string().uuid(), nome: z.string().min(1).max(150), quantidade: z.number().positive(), precoUnitario: z.number().nonnegative(), observacoes: z.string().max(300).optional() });
const EstadoSchema = z.object({ estado: z.enum(['aberto', 'em_preparacao', 'pronto', 'entregue', 'fechado', 'cancelado']) });
const FaturarPedidoSchema = z.object({ clienteNome: z.string().min(2).max(150), clienteNif: z.string().regex(/^\d{9,14}$/).optional(), moeda: z.enum(['AOA', 'USD']).default('AOA'), ivaTaxa: z.number().min(0).max(100).default(14) });
function base(empresaId: string, sk: string) { return { PK: `empresa#${empresaId}`, SK: sk }; }
function parse<T>(body: string | null | undefined, schema: z.ZodType<T>): T | null { try { const result = schema.safeParse(JSON.parse(body ?? '{}')); return result.success ? result.data : null; } catch { return null; } }
export const criarMesa: APIGatewayProxyHandler = async (event) => { const a = await auth(event); if (!a) return unauthorized(); if (a.role === 'viewer') return forbidden(); const data = parse(event.body, MesaSchema); if (!data) return badRequest('Dados invalidos'); const id = uuidv4(); const now = new Date().toISOString(); const item = { ...base(a.empresaId, `mesa#${id}`), tipo: 'mesa', id, empresaId: a.empresaId, ...data, estado: 'livre', createdAt: now, updatedAt: now }; try { await db.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' })); return created(item); } catch (err) { logger.error('Erro ao criar mesa', { error: String(err) }); return internalError(); } };
export const listarMesas: APIGatewayProxyHandler = async (event) => { const a = await auth(event); if (!a) return unauthorized(); try { const r = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': `empresa#${a.empresaId}`, ':prefix': 'mesa#' } })); return ok({ items: r.Items ?? [], total: r.Count ?? 0 }); } catch (err) { logger.error('Erro ao listar mesas', { error: String(err) }); return internalError(); } };
export const abrirPedido: APIGatewayProxyHandler = async (event) => { const a = await auth(event); if (!a) return unauthorized(); const data = parse(event.body, PedidoSchema); if (!data) return badRequest('Dados invalidos'); const id = uuidv4(); const now = new Date().toISOString(); const item = { ...base(a.empresaId, `pedido#${id}`), tipo: 'pedido', id, empresaId: a.empresaId, ...data, estado: 'aberto', total: 0, linhas: [], abertoPor: a.userId, createdAt: now, updatedAt: now }; try { await db.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' })); if (data.mesaId) await db.send(new UpdateCommand({ TableName: TABLE, Key: base(a.empresaId, `mesa#${data.mesaId}`), UpdateExpression: 'SET estado = :ocupada, pedidoId = :pedido, updatedAt = :now', ConditionExpression: 'attribute_exists(PK) AND estado = :livre', ExpressionAttributeValues: { ':ocupada': 'ocupada', ':livre': 'livre', ':pedido': id, ':now': now } })); await registarAuditoria(a, 'abrir-pedido', 'pedido', id, { mesaId: data.mesaId }); return created(item); } catch (err) { logger.error('Erro ao abrir pedido', { error: String(err) }); return internalError(); } };
export const adicionarLinha: APIGatewayProxyHandler = async (event) => { const a = await auth(event); if (!a) return unauthorized(); const pedidoId = event.pathParameters?.id; if (!pedidoId) return badRequest('ID do pedido obrigatorio'); const data = parse(event.body, LinhaSchema); if (!data) return badRequest('Dados invalidos'); const p = await db.send(new GetCommand({ TableName: TABLE, Key: base(a.empresaId, `pedido#${pedidoId}`), ConsistentRead: true })); if (!p.Item || ['fechado', 'cancelado'].includes(String(p.Item.estado))) return conflict('Pedido inexistente ou encerrado'); const linha = { id: uuidv4(), ...data, total: Number((data.quantidade * data.precoUnitario).toFixed(2)) }; const linhas = [...((p.Item.linhas as Array<{ total: number }> | undefined) ?? []), linha]; const total = Number(linhas.reduce((s, l) => s + l.total, 0).toFixed(2)); try { await db.send(new UpdateCommand({ TableName: TABLE, Key: base(a.empresaId, `pedido#${pedidoId}`), UpdateExpression: 'SET linhas = :linhas, total = :total, updatedAt = :now', ConditionExpression: 'estado = :aberto OR estado = :prep', ExpressionAttributeValues: { ':linhas': linhas, ':total': total, ':now': new Date().toISOString(), ':aberto': 'aberto', ':prep': 'em_preparacao' } })); return ok({ pedidoId, linha, total }); } catch (err) { logger.error('Erro ao adicionar linha', { error: String(err) }); return internalError(); } };
export const alterarEstado: APIGatewayProxyHandler = async (event) => { const a = await auth(event); if (!a) return unauthorized(); const id = event.pathParameters?.id; const data = parse(event.body, EstadoSchema); if (!id || !data) return badRequest('Dados invalidos'); if (data.estado === 'fechado' && a.role === 'vendedor') return forbidden('Fecho requer gestor'); try { await db.send(new UpdateCommand({ TableName: TABLE, Key: base(a.empresaId, `pedido#${id}`), UpdateExpression: 'SET estado = :estado, actualizadoPor = :user, updatedAt = :now', ConditionExpression: 'attribute_exists(PK)', ExpressionAttributeValues: { ':estado': data.estado, ':user': a.userId, ':now': new Date().toISOString() } })); await registarAuditoria(a, 'alterar-estado-pedido', 'pedido', id, data); return ok({ id, estado: data.estado }); } catch (err) { logger.error('Erro ao alterar estado do pedido', { error: String(err) }); return notFound('Pedido nao encontrado'); } };

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

		await db.send(new TransactWriteCommand({ TransactItems: transacoes as never[] }));
		await registarAuditoria(a, 'fechar-pedido', 'pedido', pedidoId, { total: pedido.total, linhas: linhasAgregadas.length, stockAplicado: true });
		return ok({ pedidoId, estado: 'fechado', stockAplicado: true, total: pedido.total });
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

		await db.send(new TransactWriteCommand({ TransactItems: [
			{ Put: { TableName: FATURACAO_TABLE, Item: { ...base(a.empresaId, `fatura#${ano}#${String(sequencial).padStart(6, '0')}`), GSI1PK: 'tipo#fatura', GSI1SK: `data#${dataEmissao}#${numero}`, id: faturaId, empresaId: a.empresaId, numero, ano, sequencial, clienteNome: dados.clienteNome, clienteNif: dados.clienteNif, moeda: dados.moeda, estado: 'pendente', linhas, subtotal, totalIva, total, totalPago: 0, dataEmissao, criadoPor: a.userId, pedidoId, createdAt: agora, updatedAt: agora }, ConditionExpression: 'attribute_not_exists(PK)' } },
			{ Update: { TableName: TABLE, Key: base(a.empresaId, `pedido#${pedidoId}`), UpdateExpression: 'SET faturaId = :faturaId, faturaNumero = :numero, updatedAt = :now', ConditionExpression: 'estado = :fechado AND stockAplicado = :sim AND attribute_not_exists(faturaId)', ExpressionAttributeValues: { ':faturaId': faturaId, ':numero': numero, ':now': agora, ':fechado': 'fechado', ':sim': true } } },
		] }));
		await registarAuditoria(a, 'emitir-fatura-pedido', 'pedido', pedidoId, { faturaId, numero, total });
		return created({ pedidoId, faturaId, numero, subtotal, totalIva, total, moeda: dados.moeda });
	} catch (err: unknown) {
		if ((err as { name?: string }).name === 'TransactionCanceledException') return conflict('Pedido ja faturado ou numeracao indisponivel');
		logger.error('Erro ao faturar pedido', { error: String(err), pedidoId });
		return internalError();
	}
};
