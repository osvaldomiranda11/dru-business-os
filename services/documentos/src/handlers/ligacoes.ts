import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, DeleteCommand, QueryCommand, GetCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  db,
  ok,
  created,
  noContent,
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
import type { AuthContext } from '@dru-bos/shared';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;

/**
 * Tipo de entidade a que um documento pode ser ligado — deixou de ser uma
 * lista fechada (2026-08). O núcleo documental é transversal: uma escola
 * pode ligar a "aluno", uma igreja a "membro", uma instituição a
 * "processo", sem precisar de código novo aqui. Só validamos o formato
 * (identificador seguro), não o vocabulário.
 */
const TipoEntidadeSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use letras minúsculas, números e _ (ex: cliente, aluno, processo)');

const LigarSchema = z.object({
  tipoEntidade: TipoEntidadeSchema,
  entidadeId: z.string().min(1),
  entidadeNome: z.string().max(200).optional(),
});

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

export const ligar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para ligar documentos');

  const documentoId = event.pathParameters?.id;
  if (!documentoId) return badRequest('ID do documento obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = LigarSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  const { tipoEntidade, entidadeId, entidadeNome } = parsed.data;

  const documento = await db.send(
    new GetCommand({ TableName: DOCUMENTOS_TABLE, Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${documentoId}` } }),
  );
  if (!documento.Item || documento.Item.deletedAt) return notFound('Documento não encontrado');

  const now = new Date().toISOString();
  const ligacao = {
    PK: `empresa#${auth.empresaId}`,
    SK: `link#${tipoEntidade}#${entidadeId}#${documentoId}`,
    empresaId: auth.empresaId,
    documentoId,
    tipoEntidade,
    entidadeId,
    entidadeNome,
    criadoPor: auth.userId,
    createdAt: now,
  };

  try {
    await db.send(
      new PutCommand({
        TableName: DOCUMENTOS_TABLE,
        Item: ligacao,
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    await registarAuditoria(auth, 'ligar', 'documento', documentoId, { tipoEntidade, entidadeId });
    return created(ligacao);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return badRequest('Documento já está ligado a esta entidade');
    }
    logger.error('Erro ao ligar documento', { error: String(err), documentoId });
    return internalError();
  }
};

export const desligar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para desligar documentos');

  const documentoId = event.pathParameters?.id;
  const tipoEntidade = event.pathParameters?.tipoEntidade;
  const entidadeId = event.pathParameters?.entidadeId;
  if (!documentoId || !tipoEntidade || !entidadeId) {
    return badRequest('Parâmetros obrigatórios em falta');
  }

  try {
    await db.send(
      new DeleteCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `link#${tipoEntidade}#${entidadeId}#${documentoId}` },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
    await registarAuditoria(auth, 'desligar', 'documento', documentoId, { tipoEntidade, entidadeId });
    return noContent();
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return notFound('Ligação não encontrada');
    }
    logger.error('Erro ao desligar documento', { error: String(err), documentoId });
    return internalError();
  }
};

/**
 * Lista os documentos ligados a uma entidade específica (ex: todos os
 * documentos de um cliente, ou os anexos de uma fatura).
 */
export const listarPorEntidade: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const tipoEntidade = event.pathParameters?.tipoEntidade;
  const entidadeId = event.pathParameters?.entidadeId;
  if (!tipoEntidade || !entidadeId) return badRequest('Parâmetros obrigatórios em falta');
  if (!TipoEntidadeSchema.safeParse(tipoEntidade).success) {
    return badRequest('Tipo de entidade inválido');
  }

  try {
    const ligacoes = await db.send(
      new QueryCommand({
        TableName: DOCUMENTOS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': `link#${tipoEntidade}#${entidadeId}#`,
        },
      }),
    );

    const items = ligacoes.Items ?? [];
    if (items.length === 0) return ok({ items: [], total: 0 });

    const keys = items.map((l) => ({ PK: `empresa#${auth.empresaId}`, SK: `documento#${l.documentoId}` }));
    const batch = await db.send(
      new BatchGetCommand({ RequestItems: { [DOCUMENTOS_TABLE]: { Keys: keys } } }),
    );

    const documentos = (batch.Responses?.[DOCUMENTOS_TABLE] ?? []).filter((doc) => !doc.deletedAt);
    return ok({ items: documentos, total: documentos.length });
  } catch (err) {
    logger.error('Erro ao listar documentos da entidade', { error: String(err), tipoEntidade, entidadeId });
    return internalError();
  }
};
