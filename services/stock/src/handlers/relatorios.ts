import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { db, ok, unauthorized, internalError, verifyToken, extractToken, logger } from '@dru-bos/shared';

const STOCK_TABLE = process.env.STOCK_TABLE!;

export const valoriacaoInventario: APIGatewayProxyHandler = async (event) => {
  const token = extractToken(event);
  if (!token) return unauthorized();
  const auth = await verifyToken(token);
  if (!auth) return unauthorized();

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: STOCK_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'attribute_not_exists(deletedAt) AND ativo = :ativo',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'produto#',
          ':ativo': true,
        },
      }),
    );

    const produtos = result.Items ?? [];
    let valorTotalCusto = 0;
    let valorTotalVenda = 0;
    const stockCritico: unknown[] = [];

    for (const p of produtos) {
      const custo = (p.precoCusto ?? 0) * (p.stockActual ?? 0);
      const venda = (p.precoVenda ?? 0) * (p.stockActual ?? 0);
      valorTotalCusto += custo;
      valorTotalVenda += venda;
      if ((p.stockActual ?? 0) <= (p.stockMinimo ?? 0)) {
        stockCritico.push({ id: p.id, nome: p.nome, stockActual: p.stockActual, stockMinimo: p.stockMinimo });
      }
    }

    return ok({
      totalProdutos: produtos.length,
      valorTotalCusto: Number(valorTotalCusto.toFixed(2)),
      valorTotalVenda: Number(valorTotalVenda.toFixed(2)),
      margemPotencial: Number((valorTotalVenda - valorTotalCusto).toFixed(2)),
      produtosStockCritico: stockCritico.length,
      stockCritico,
    });
  } catch (err) {
    logger.error('Erro ao gerar valorização', { error: String(err) });
    return internalError();
  }
};
