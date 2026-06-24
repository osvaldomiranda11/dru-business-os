/**
 * Handlers EventBridge — escutam eventos de negocio e enviam push aos admins.
 *
 * Cada evento traduz-se numa notificacao curta e accionavel. O titulo/corpo
 * estao em portugues europeu, sem emojis (DRU brand voice).
 */
import type { EventBridgeHandler } from 'aws-lambda';
import { logger } from '@dru-bos/shared';
import { listarAdminsEmpresa, listarTokensUtilizadores } from './dispositivos';
import { enviarPush } from '../lib/fcm';

interface DetailFaturaEmitida {
  empresaId: string;
  faturaId: string;
  numero: string;
  clienteId?: string;
  total: number;
  moeda: string;
}

interface DetailPagamentoRegistado {
  empresaId: string;
  faturaId: string;
  numero: string;
  valor: number;
  metodo: string;
  estado: string;
}

interface DetailAlertaStock {
  empresaId: string;
  produtoId: string;
  nome: string;
  stockActual: number;
  stockMinimo: number;
}

const aoa = (v: number) =>
  new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'AOA', maximumFractionDigits: 0 }).format(v);

async function notificarAdmins(empresaId: string, titulo: string, corpo: string, data: Record<string, string>) {
  const admins = await listarAdminsEmpresa(empresaId);
  if (admins.length === 0) {
    logger.info('Sem admins activos para notificar', { empresaId });
    return;
  }
  const tokens = await listarTokensUtilizadores(empresaId, admins);
  if (tokens.length === 0) {
    logger.info('Admins sem dispositivos registados', { empresaId, admins: admins.length });
    return;
  }
  const r = await enviarPush(tokens, { titulo, corpo, data });
  logger.info('Push enviado', { empresaId, ...r });
  // Limpeza opcional dos tokens invalidos pode ser feita aqui no futuro.
}

export const faturaEmitida: EventBridgeHandler<'FaturaEmitida', DetailFaturaEmitida, void> = async (event) => {
  const d = event.detail;
  await notificarAdmins(
    d.empresaId,
    'Nova fatura emitida',
    `${d.numero} — ${aoa(d.total)}`,
    { tipo: 'fatura', faturaId: d.faturaId, numero: d.numero },
  );
};

export const pagamentoRegistado: EventBridgeHandler<'PagamentoRegistado', DetailPagamentoRegistado, void> = async (event) => {
  const d = event.detail;
  const acao = d.estado === 'paga' ? 'Fatura paga' : 'Pagamento parcial recebido';
  await notificarAdmins(
    d.empresaId,
    acao,
    `${d.numero} — ${aoa(d.valor)} via ${d.metodo}`,
    { tipo: 'pagamento', faturaId: d.faturaId, numero: d.numero },
  );
};

export const alertaStock: EventBridgeHandler<'AlertaStockMinimo', DetailAlertaStock, void> = async (event) => {
  const d = event.detail;
  await notificarAdmins(
    d.empresaId,
    'Stock crítico',
    `${d.nome}: ${d.stockActual} (mínimo ${d.stockMinimo})`,
    { tipo: 'stock', produtoId: d.produtoId },
  );
};
