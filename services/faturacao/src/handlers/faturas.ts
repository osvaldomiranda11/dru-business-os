/**
 * Serviço de Faturação — DRU Business OS
 *
 * Fase 2 — Implementação completa.
 * Esqueleto definido com tipos e estrutura de dados prontos.
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { ok, badRequest, unauthorized, notFound, internalError, verifyToken, extractToken, logger } from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const FATURACAO_TABLE = process.env.FATURACAO_TABLE!;
const FILES_BUCKET = process.env.FILES_BUCKET!;

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

// TODO Fase 2: Implementar emissão de fatura com numeração sequencial por empresa
export const emitir: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  logger.info('emitirFatura — em desenvolvimento', { empresaId: auth.empresaId });
  return ok({ message: 'Módulo de faturação em desenvolvimento — disponível na Fase 2' });
};

// TODO Fase 2: Listar faturas com filtros (estado: pendente/pago/vencido, cliente, período)
export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  return ok({ items: [], total: 0, message: 'Módulo em desenvolvimento' });
};

// TODO Fase 2: Obter fatura com linhas de detalhe
export const obter: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  return notFound('Fatura não encontrada — módulo em desenvolvimento');
};

// TODO Fase 2: Registar pagamento — actualiza estado para "pago", emite evento EventBridge
export const registarPagamento: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  return ok({ message: 'Pagamento — em desenvolvimento' });
};

// TODO Fase 2: Gerar PDF via Lambda, guardar em S3 faturas/, retornar URL pre-signed (1h)
export const gerarPdf: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  return ok({ message: 'Geração de PDF — em desenvolvimento', bucket: FILES_BUCKET });
};
