/**
 * Dashboard — DRU Business OS
 *
 * Agrega KPIs de financeiro, faturacao, stock e clientes para a homepage.
 * Todos os endpoints fazem queries paralelas em multiplas tabelas DynamoDB
 * e retornam metricas pre-calculadas prontas para renderizar.
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  db,
  ok,
  unauthorized,
  internalError,
  verifyToken,
  extractToken,
  logger,
} from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const FINANCEIRO_TABLE = process.env.FINANCEIRO_TABLE!;
const FATURACAO_TABLE = process.env.FATURACAO_TABLE!;
const STOCK_TABLE = process.env.STOCK_TABLE!;
const CLIENTES_TABLE = process.env.CLIENTES_TABLE!;

interface ProdutoDoc {
  SK: string;
  id: string;
  nome: string;
  stockActual?: number;
  stockMinimo?: number;
  precoCusto?: number;
  precoVenda?: number;
  ativo?: boolean;
  deletedAt?: string;
}

interface FaturaDoc {
  SK: string;
  id: string;
  numero: string;
  estado: string;
  total: number;
  totalPago: number;
  dataEmissao: string;
  dataVencimento?: string;
  clienteNome: string;
  deletedAt?: string;
}

interface RegistoFinanceiroDoc {
  SK: string;
  valor: number;
  data: string;
  categoria: string;
  deletedAt?: string;
}

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hoje(): string {
  return new Date().toISOString().split('T')[0];
}

function diasAtras(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function queryAll<T>(
  tableName: string,
  empresaId: string,
  prefix: string,
): Promise<T[]> {
  const items: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await db.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${empresaId}`,
          ':prefix': prefix,
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((result.Items ?? []) as T[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * GET /dashboard/resumo — KPIs principais para a homepage.
 *
 * Devolve métricas consolidadas dos últimos 30 dias e estado actual:
 *   - receitas / despesas / saldo do período
 *   - facturação: total emitido, pendente, pago, em atraso
 *   - stock: número de produtos, valor de inventário, alertas críticos
 *   - clientes: total activo
 */
export const resumo: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const dataInicio = diasAtras(30);
  const dataHoje = hoje();

  try {
    const [receitas, despesas, faturas, produtos, clientes] = await Promise.all([
      queryAll<RegistoFinanceiroDoc>(FINANCEIRO_TABLE, auth.empresaId, 'receita#'),
      queryAll<RegistoFinanceiroDoc>(FINANCEIRO_TABLE, auth.empresaId, 'despesa#'),
      queryAll<FaturaDoc>(FATURACAO_TABLE, auth.empresaId, 'fatura#'),
      queryAll<ProdutoDoc>(STOCK_TABLE, auth.empresaId, 'produto#'),
      queryAll<{ SK: string; ativo?: boolean; deletedAt?: string }>(
        CLIENTES_TABLE,
        auth.empresaId,
        'cliente#',
      ),
    ]);

    const receitasPeriodo = receitas
      .filter((r) => r.data >= dataInicio)
      .reduce((acc, r) => acc + r.valor, 0);
    const despesasPeriodo = despesas
      .filter((d) => d.data >= dataInicio)
      .reduce((acc, d) => acc + d.valor, 0);
    const saldo = round2(receitasPeriodo - despesasPeriodo);

    // Apenas faturas reais (com numero) — exclui contadores e pagamentos.
    const faturasReais = faturas.filter((f) => f.numero && f.estado);
    const totalEmitido = faturasReais.reduce((acc, f) => acc + (f.total ?? 0), 0);
    const totalPago = faturasReais.reduce((acc, f) => acc + (f.totalPago ?? 0), 0);
    const totalPendente = round2(totalEmitido - totalPago);
    const emAtraso = faturasReais
      .filter(
        (f) =>
          f.estado !== 'paga' &&
          f.estado !== 'anulada' &&
          f.dataVencimento &&
          f.dataVencimento < dataHoje,
      )
      .reduce((acc, f) => acc + (f.total - (f.totalPago ?? 0)), 0);

    const produtosAtivos = produtos.filter((p) => p.ativo !== false);
    const valorInventario = produtosAtivos.reduce(
      (acc, p) => acc + (p.stockActual ?? 0) * (p.precoCusto ?? 0),
      0,
    );
    const stockCritico = produtosAtivos.filter(
      (p) => (p.stockActual ?? 0) <= (p.stockMinimo ?? 0),
    ).length;

    const clientesAtivos = clientes.filter((c) => c.ativo !== false).length;

    return ok({
      periodo: { inicio: dataInicio, fim: dataHoje, dias: 30 },
      financeiro: {
        receitas: round2(receitasPeriodo),
        despesas: round2(despesasPeriodo),
        saldo,
      },
      faturacao: {
        totalEmitido: round2(totalEmitido),
        totalPago: round2(totalPago),
        totalPendente,
        emAtraso: round2(emAtraso),
        numeroFaturas: faturasReais.length,
      },
      stock: {
        numeroProdutos: produtosAtivos.length,
        valorInventario: round2(valorInventario),
        alertasCriticos: stockCritico,
      },
      clientes: {
        total: clientesAtivos,
      },
    });
  } catch (err) {
    logger.error('Erro no resumo do dashboard', { error: String(err) });
    return internalError();
  }
};

/**
 * GET /dashboard/fluxo-caixa?meses=6
 * Devolve serie temporal de receitas/despesas/saldo agrupados por mes.
 */
export const fluxoCaixa: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const qs = event.queryStringParameters ?? {};
  const meses = Math.min(Math.max(Number(qs.meses ?? 6), 1), 24);

  const inicio = new Date();
  inicio.setMonth(inicio.getMonth() - (meses - 1));
  inicio.setDate(1);
  const dataInicio = inicio.toISOString().split('T')[0];

  try {
    const [receitas, despesas] = await Promise.all([
      queryAll<RegistoFinanceiroDoc>(FINANCEIRO_TABLE, auth.empresaId, 'receita#'),
      queryAll<RegistoFinanceiroDoc>(FINANCEIRO_TABLE, auth.empresaId, 'despesa#'),
    ]);

    const buckets: Record<string, { receitas: number; despesas: number }> = {};
    for (let i = 0; i < meses; i++) {
      const d = new Date(inicio);
      d.setMonth(d.getMonth() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      buckets[key] = { receitas: 0, despesas: 0 };
    }

    for (const r of receitas) {
      if (r.data < dataInicio) continue;
      const key = r.data.substring(0, 7);
      if (buckets[key]) buckets[key].receitas += r.valor;
    }
    for (const d of despesas) {
      if (d.data < dataInicio) continue;
      const key = d.data.substring(0, 7);
      if (buckets[key]) buckets[key].despesas += d.valor;
    }

    const serie = Object.entries(buckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mes, { receitas: r, despesas: d }]) => ({
        mes,
        receitas: round2(r),
        despesas: round2(d),
        saldo: round2(r - d),
      }));

    return ok({ meses, serie });
  } catch (err) {
    logger.error('Erro no fluxo de caixa', { error: String(err) });
    return internalError();
  }
};

/**
 * GET /dashboard/top-produtos?limite=10
 * Top produtos por valor de stock em armazem (stockActual * precoCusto).
 */
export const topProdutos: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const qs = event.queryStringParameters ?? {};
  const limite = Math.min(Math.max(Number(qs.limite ?? 10), 1), 50);

  try {
    const produtos = await queryAll<ProdutoDoc>(STOCK_TABLE, auth.empresaId, 'produto#');
    const ranking = produtos
      .filter((p) => p.ativo !== false)
      .map((p) => ({
        id: p.id,
        nome: p.nome,
        stockActual: p.stockActual ?? 0,
        precoCusto: p.precoCusto ?? 0,
        precoVenda: p.precoVenda ?? 0,
        valorStock: round2((p.stockActual ?? 0) * (p.precoCusto ?? 0)),
        margemPotencial: round2(
          ((p.stockActual ?? 0) * (p.precoVenda ?? 0)) -
          ((p.stockActual ?? 0) * (p.precoCusto ?? 0)),
        ),
      }))
      .sort((a, b) => b.valorStock - a.valorStock)
      .slice(0, limite);

    return ok({ limite, total: ranking.length, items: ranking });
  } catch (err) {
    logger.error('Erro no top produtos', { error: String(err) });
    return internalError();
  }
};

/**
 * GET /dashboard/alertas
 * Alertas accionaveis para o utilizador resolver hoje.
 */
export const alertas: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const dataHoje = hoje();

  try {
    const [faturas, produtos] = await Promise.all([
      queryAll<FaturaDoc>(FATURACAO_TABLE, auth.empresaId, 'fatura#'),
      queryAll<ProdutoDoc>(STOCK_TABLE, auth.empresaId, 'produto#'),
    ]);

    const faturasReais = faturas.filter((f) => f.numero && f.estado);

    const faturasVencidas = faturasReais
      .filter(
        (f) =>
          f.estado !== 'paga' &&
          f.estado !== 'anulada' &&
          f.dataVencimento &&
          f.dataVencimento < dataHoje,
      )
      .map((f) => ({
        tipo: 'fatura-vencida' as const,
        faturaId: f.id,
        numero: f.numero,
        cliente: f.clienteNome,
        valor: round2(f.total - (f.totalPago ?? 0)),
        diasAtraso: Math.floor(
          (Date.now() - new Date(f.dataVencimento!).getTime()) / 86400000,
        ),
      }));

    const stockCritico = produtos
      .filter((p) => p.ativo !== false && (p.stockActual ?? 0) <= (p.stockMinimo ?? 0))
      .map((p) => ({
        tipo: 'stock-critico' as const,
        produtoId: p.id,
        nome: p.nome,
        stockActual: p.stockActual ?? 0,
        stockMinimo: p.stockMinimo ?? 0,
      }));

    return ok({
      total: faturasVencidas.length + stockCritico.length,
      faturasVencidas,
      stockCritico,
    });
  } catch (err) {
    logger.error('Erro nos alertas', { error: String(err) });
    return internalError();
  }
};
