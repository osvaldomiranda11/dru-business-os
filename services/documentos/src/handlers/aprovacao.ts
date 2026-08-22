import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  db,
  ok,
  badRequest,
  unauthorized,
  notFound,
  forbidden,
  internalError,
  verifyToken,
  extractToken,
  registarAuditoria,
  logger,
} from '@dru-bos/shared';
import type { AuthContext, EstadoAprovacao } from '@dru-bos/shared';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;

const AtualizarAprovacaoSchema = z.object({
  estado: z.enum(['pendente', 'em_analise', 'aprovado', 'rejeitado']),
  comentario: z.string().max(500).optional(),
});

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

/**
 * Actualiza o estado de aprovação de um documento e regista sempre uma
 * entrada no histórico — quem, quando, de que estado para que estado.
 * Não impomos uma máquina de estados rígida (ex: não podes saltar de
 * "pendente" para "aprovado") de propósito: é controlo interno, não um
 * processo legal, e forçar uma ordem rígida atrapalharia mais do que
 * ajudaria em casos reais (ex: reverter uma aprovação por engano).
 */
export const atualizar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para alterar o estado de aprovação');

  const documentoId = event.pathParameters?.id;
  if (!documentoId) return badRequest('ID do documento obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }
  const parsed = AtualizarAprovacaoSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const documento = await db.send(
    new GetCommand({ TableName: DOCUMENTOS_TABLE, Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${documentoId}` } }),
  );
  if (!documento.Item || documento.Item.deletedAt) return notFound('Documento não encontrado');

  const estadoAnterior = documento.Item.estadoAprovacao as EstadoAprovacao | undefined;
  const now = new Date().toISOString();

  const historico = {
    PK: `empresa#${auth.empresaId}`,
    SK: `documento#${documentoId}#aprovacao#${now}`,
    documentoId,
    empresaId: auth.empresaId,
    estadoAnterior,
    estadoNovo: parsed.data.estado,
    utilizadorId: auth.userId,
    utilizadorNome: auth.nome,
    comentario: parsed.data.comentario,
    createdAt: now,
  };

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: DOCUMENTOS_TABLE,
              Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${documentoId}` },
              UpdateExpression: 'SET estadoAprovacao = :estado, updatedAt = :now',
              ExpressionAttributeValues: { ':estado': parsed.data.estado, ':now': now },
            },
          },
          { Put: { TableName: DOCUMENTOS_TABLE, Item: historico } },
        ],
      }),
    );
    await registarAuditoria(auth, 'aprovacao', 'documento', documentoId, {
      estadoAnterior,
      estadoNovo: parsed.data.estado,
    });
    return ok({ estado: parsed.data.estado, updatedAt: now });
  } catch (err) {
    logger.error('Erro ao actualizar estado de aprovação', { error: String(err), documentoId });
    return internalError();
  }
};

export const historico: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const documentoId = event.pathParameters?.id;
  if (!documentoId) return badRequest('ID do documento obrigatório');

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: DOCUMENTOS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': `documento#${documentoId}#aprovacao#`,
        },
        ScanIndexForward: false,
      }),
    );
    return ok({ items: result.Items ?? [] });
  } catch (err) {
    logger.error('Erro ao obter histórico de aprovação', { error: String(err), documentoId });
    return internalError();
  }
};
