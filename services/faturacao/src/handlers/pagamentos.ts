/**
 * Webhook Multicaixa Express — DRU Business OS
 *
 * Fase 2: Validar assinatura HMAC, activar plano, emitir evento.
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ok, badRequest, internalError, logger } from '@dru-bos/shared';

// TODO Fase 2: Implementar validação de assinatura Multicaixa e activação de planos
export const webhookMulticaixa: APIGatewayProxyHandler = async (event) => {
  logger.info('Webhook Multicaixa recebido', {
    headers: event.headers,
    body: event.body?.substring(0, 100),
  });

  // Validação de assinatura HMAC (implementar com secret do Multicaixa)
  // const signature = event.headers['X-Multicaixa-Signature'];
  // if (!validarAssinatura(event.body, signature)) return badRequest('Assinatura inválida');

  return ok({ received: true, message: 'Webhook processado — implementação completa na Fase 2' });
};
