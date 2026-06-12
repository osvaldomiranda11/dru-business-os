/**
 * Webhook Multicaixa Express — DRU Business OS
 *
 * Fase 2: Valida a assinatura HMAC-SHA256 enviada pela GPO/EMIS,
 * localiza a fatura pela referência e regista o pagamento.
 *
 * Configuração esperada (variável de ambiente MULTICAIXA_WEBHOOK_SECRET):
 * segredo partilhado fornecido pela EMIS no momento da integração.
 *
 * Payload esperado (exemplo):
 * {
 *   "empresaId": "uuid-da-empresa",
 *   "faturaId": "uuid-da-fatura",
 *   "referencia": "REF-123456",
 *   "valor": 1500.00,
 *   "estado": "SUCCESS"
 * }
 * Header: X-Multicaixa-Signature: hex(hmac_sha256(body, secret))
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { ok, badRequest, notFound, conflict, internalError, logger } from '@dru-bos/shared';
import { obterFaturaPorId, aplicarPagamento } from './faturas';

const MULTICAIXA_WEBHOOK_SECRET = process.env.MULTICAIXA_WEBHOOK_SECRET ?? '';

const WebhookSchema = z.object({
  empresaId: z.string().uuid(),
  faturaId: z.string().uuid(),
  referencia: z.string().max(100).optional(),
  valor: z.number().positive(),
  estado: z.enum(['SUCCESS', 'FAILED', 'PENDING']),
});

function validarAssinatura(body: string, signature: string | undefined): boolean {
  if (!MULTICAIXA_WEBHOOK_SECRET) {
    // Sem segredo configurado — apenas em ambiente de desenvolvimento.
    logger.warn('MULTICAIXA_WEBHOOK_SECRET não configurado — assinatura não validada');
    return true;
  }
  if (!signature) return false;

  const esperado = createHmac('sha256', MULTICAIXA_WEBHOOK_SECRET).update(body).digest('hex');
  const a = Buffer.from(esperado, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const webhookMulticaixa: APIGatewayProxyHandler = async (event) => {
  const rawBody = event.body ?? '';
  const signature = event.headers?.['X-Multicaixa-Signature'] ?? event.headers?.['x-multicaixa-signature'];

  if (!validarAssinatura(rawBody, signature)) {
    logger.warn('Webhook Multicaixa — assinatura inválida');
    return badRequest('Assinatura inválida');
  }

  let body: unknown;
  try { body = JSON.parse(rawBody); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = WebhookSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const { empresaId, faturaId, referencia, valor, estado } = parsed.data;

  if (estado !== 'SUCCESS') {
    logger.info('Webhook Multicaixa — pagamento não concluído', { faturaId, estado });
    return ok({ received: true, processado: false, estado });
  }

  try {
    const fatura = await obterFaturaPorId(empresaId, faturaId);
    if (!fatura) return notFound('Fatura não encontrada');
    if (fatura.estado === 'paga') return conflict('Fatura já se encontra paga');
    if (fatura.estado === 'anulada') return conflict('Fatura anulada não pode receber pagamentos');

    const { pagamentoId, novoTotalPago, novoEstado } = await aplicarPagamento(
      empresaId,
      fatura,
      {
        valor,
        metodo: 'multicaixa',
        referencia,
        data: new Date().toISOString().split('T')[0],
      },
      'sistema-multicaixa',
    );

    logger.info('Webhook Multicaixa — pagamento registado', { faturaId, pagamentoId, novoEstado });
    return ok({ received: true, processado: true, pagamentoId, totalPago: novoTotalPago, estado: novoEstado });
  } catch (err) {
    logger.error('Erro ao processar webhook Multicaixa', { error: String(err), faturaId });
    return internalError();
  }
};
