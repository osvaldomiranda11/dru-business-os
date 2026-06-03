import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  db,
  ok,
  badRequest,
  unauthorized,
  internalError,
  verifyToken,
  extractToken,
  logger,
} from '@dru-bos/shared';
import type { ReceitaFinanceira, DespesaFinanceira, AuthContext } from '@dru-bos/shared';
import { FiltrosRelatorioSchema } from '../schemas';

const FINANCEIRO_TABLE = process.env.FINANCEIRO_TABLE!;

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

function buildPeriodRange(ano: number, mes?: number): { inicio: string; fim: string } {
  if (mes) {
    const inicioDate = new Date(ano, mes - 1, 1);
    const fimDate = new Date(ano, mes, 0);
    return {
      inicio: inicioDate.toISOString().split('T')[0],
      fim: fimDate.toISOString().split('T')[0],
    };
  }
  return {
    inicio: `${ano}-01-01`,
    fim: `${ano}-12-31`,
  };
}

async function buscarRegistos(
  empresaId: string,
  tipo: 'receita' | 'despesa',
  inicio: string,
  fim: string,
): Promise<Array<ReceitaFinanceira | DespesaFinanceira>> {
  const items: Array<ReceitaFinanceira | DespesaFinanceira> = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await db.send(
      new QueryCommand({
        TableName: FINANCEIRO_TABLE,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :inicio AND :fim',
        FilterExpression: 'attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${empresaId}`,
          ':inicio': `${tipo}#${inicio}#`,
          ':fim': `${tipo}#${fim}#￿`,
        },
        ExclusiveStartKey: lastKey,
      }),
    );

    if (result.Items) {
      items.push(...(result.Items as Array<ReceitaFinanceira | DespesaFinanceira>));
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return items;
}

export const fluxoCaixa: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const filtrosParsed = FiltrosRelatorioSchema.safeParse(event.queryStringParameters ?? {});
  if (!filtrosParsed.success) {
    return badRequest('Parâmetros inválidos', filtrosParsed.error.flatten().fieldErrors);
  }

  const { ano, mes, moeda } = filtrosParsed.data;
  const { inicio, fim } = buildPeriodRange(ano, mes);

  try {
    const [receitas, despesas] = await Promise.all([
      buscarRegistos(auth.empresaId, 'receita', inicio, fim),
      buscarRegistos(auth.empresaId, 'despesa', inicio, fim),
    ]);

    const receitasFiltradas = (receitas as ReceitaFinanceira[]).filter(
      (r) => !moeda || r.moeda === moeda,
    );
    const despesasFiltradas = (despesas as DespesaFinanceira[]).filter(
      (d) => !moeda || d.moeda === moeda,
    );

    const totalReceitas = receitasFiltradas.reduce((acc, r) => acc + r.valor, 0);
    const totalDespesas = despesasFiltradas.reduce((acc, d) => acc + d.valor, 0);
    const saldoLiquido = totalReceitas - totalDespesas;

    // Agrupamento por dia para o gráfico de evolução
    const evolucaoDiaria = new Map<string, { receitas: number; despesas: number; saldo: number }>();

    for (const r of receitasFiltradas) {
      const entrada = evolucaoDiaria.get(r.data) ?? { receitas: 0, despesas: 0, saldo: 0 };
      entrada.receitas += r.valor;
      entrada.saldo += r.valor;
      evolucaoDiaria.set(r.data, entrada);
    }
    for (const d of despesasFiltradas) {
      const entrada = evolucaoDiaria.get(d.data) ?? { receitas: 0, despesas: 0, saldo: 0 };
      entrada.despesas += d.valor;
      entrada.saldo -= d.valor;
      evolucaoDiaria.set(d.data, entrada);
    }

    const evolucao = Array.from(evolucaoDiaria.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([data, valores]) => ({ data, ...valores }));

    return ok({
      periodo: { ano, mes: mes ?? null, inicio, fim },
      moeda,
      resumo: {
        totalReceitas: Number(totalReceitas.toFixed(2)),
        totalDespesas: Number(totalDespesas.toFixed(2)),
        saldoLiquido: Number(saldoLiquido.toFixed(2)),
        qtdReceitas: receitasFiltradas.length,
        qtdDespesas: despesasFiltradas.length,
      },
      evolucaoDiaria: evolucao,
    });
  } catch (err) {
    logger.error('Erro ao gerar relatório de fluxo de caixa', {
      error: String(err),
      empresaId: auth.empresaId,
    });
    return internalError();
  }
};

export const lucroPrejuizo: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const filtrosParsed = FiltrosRelatorioSchema.safeParse(event.queryStringParameters ?? {});
  if (!filtrosParsed.success) {
    return badRequest('Parâmetros inválidos', filtrosParsed.error.flatten().fieldErrors);
  }

  const { ano, mes, moeda } = filtrosParsed.data;
  const { inicio, fim } = buildPeriodRange(ano, mes);

  try {
    const [receitas, despesas] = await Promise.all([
      buscarRegistos(auth.empresaId, 'receita', inicio, fim),
      buscarRegistos(auth.empresaId, 'despesa', inicio, fim),
    ]);

    const receitasFiltradas = (receitas as ReceitaFinanceira[]).filter(
      (r) => !moeda || r.moeda === moeda,
    );
    const despesasFiltradas = (despesas as DespesaFinanceira[]).filter(
      (d) => !moeda || d.moeda === moeda,
    );

    // Agrupamento por categoria
    const receitasPorCategoria: Record<string, number> = {};
    for (const r of receitasFiltradas) {
      receitasPorCategoria[r.categoria] = (receitasPorCategoria[r.categoria] ?? 0) + r.valor;
    }

    const despesasPorCategoria: Record<string, number> = {};
    for (const d of despesasFiltradas) {
      despesasPorCategoria[d.categoria] = (despesasPorCategoria[d.categoria] ?? 0) + d.valor;
    }

    const totalReceitas = Object.values(receitasPorCategoria).reduce((a, b) => a + b, 0);
    const totalDespesas = Object.values(despesasPorCategoria).reduce((a, b) => a + b, 0);
    const resultado = totalReceitas - totalDespesas;
    const margemLucro = totalReceitas > 0 ? (resultado / totalReceitas) * 100 : 0;

    return ok({
      periodo: { ano, mes: mes ?? null, inicio, fim },
      moeda,
      resumo: {
        totalReceitas: Number(totalReceitas.toFixed(2)),
        totalDespesas: Number(totalDespesas.toFixed(2)),
        resultado: Number(resultado.toFixed(2)),
        margemLucro: Number(margemLucro.toFixed(2)),
        situacao: resultado >= 0 ? 'lucro' : 'prejuizo',
      },
      receitasPorCategoria: Object.entries(receitasPorCategoria).map(([categoria, valor]) => ({
        categoria,
        valor: Number(valor.toFixed(2)),
        percentagem: Number(((valor / totalReceitas) * 100).toFixed(1)),
      })),
      despesasPorCategoria: Object.entries(despesasPorCategoria).map(([categoria, valor]) => ({
        categoria,
        valor: Number(valor.toFixed(2)),
        percentagem: totalDespesas > 0
          ? Number(((valor / totalDespesas) * 100).toFixed(1))
          : 0,
      })),
    });
  } catch (err) {
    logger.error('Erro ao gerar relatório lucro/prejuízo', {
      error: String(err),
      empresaId: auth.empresaId,
    });
    return internalError();
  }
};
