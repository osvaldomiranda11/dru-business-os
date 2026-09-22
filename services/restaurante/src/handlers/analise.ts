import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { db, ok, badRequest, unauthorized, internalError, verifyToken, extractToken, logger } from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const TABLE = process.env.RESTAURANTE_TABLE!;
const FiltrosSchema = z.object({
  inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  return token ? verifyToken(token) : null;
}

async function pedidos(empresaId: string): Promise<Array<Record<string, any>>> {
  const items: Array<Record<string, any>> = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await db.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `empresa#${empresaId}`, ':prefix': 'pedido#' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...((result.Items ?? []) as Array<Record<string, any>>));
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return items;
}

export const filaCozinha: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  try {
    const itens = (await pedidos(auth.empresaId))
      .filter((pedido) => ['aberto', 'em_preparacao', 'pronto'].includes(String(pedido.estado)))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((pedido) => ({
        pedidoId: pedido.id,
        mesaId: pedido.mesaId ?? null,
        tipo: pedido.tipo,
        estado: pedido.estado,
        linhas: pedido.linhas ?? [],
        observacoes: pedido.observacoes,
        abertoEm: pedido.createdAt,
      }));
    return ok({ items: itens, total: itens.length });
  } catch (err) {
    logger.error('Erro ao listar fila da cozinha', { error: String(err) });
    return internalError();
  }
};

export const relatorioVendas: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  const filtros = FiltrosSchema.safeParse(event.queryStringParameters ?? {});
  if (!filtros.success || filtros.data.inicio > filtros.data.fim) return badRequest('Periodo invalido', filtros.success ? undefined : filtros.error.flatten().fieldErrors);
  try {
    const vendas = (await pedidos(auth.empresaId)).filter((pedido) => {
      const data = String(pedido.fechadoEm ?? pedido.updatedAt ?? '').slice(0, 10);
      return pedido.estado === 'fechado' && data >= filtros.data.inicio && data <= filtros.data.fim;
    });
    const porProduto = new Map<string, { nome: string; quantidade: number; total: number }>();
    let total = 0;
    for (const venda of vendas) {
      total += Number(venda.total ?? 0);
      for (const linha of (venda.linhas ?? []) as Array<{ nome: string; quantidade: number; total: number }>) {
        const atual = porProduto.get(linha.nome) ?? { nome: linha.nome, quantidade: 0, total: 0 };
        atual.quantidade += Number(linha.quantidade);
        atual.total += Number(linha.total);
        porProduto.set(linha.nome, atual);
      }
    }
    const totalVendas = Number(total.toFixed(2));
    return ok({
      periodo: filtros.data,
      resumo: { totalVendas, numeroPedidos: vendas.length, ticketMedio: vendas.length ? Number((total / vendas.length).toFixed(2)) : 0 },
      porProduto: Array.from(porProduto.values()).map((produto) => ({ ...produto, total: Number(produto.total.toFixed(2)) })).sort((a, b) => b.total - a.total),
    });
  } catch (err) {
    logger.error('Erro ao gerar relatorio de vendas', { error: String(err) });
    return internalError();
  }
};
