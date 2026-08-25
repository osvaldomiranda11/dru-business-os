import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, QueryCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
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
import type { AuthContext } from '@dru-bos/shared';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;

const DefinirAcessosSchema = z.object({
  // { id, nome } em vez de só o id — evita ter de voltar a consultar o
  // serviço de auth sempre que se lista quem tem acesso
  utilizadores: z.array(z.object({ id: z.string().min(1), nome: z.string().min(1) })).max(100),
});

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

/**
 * Substitui por completo a lista de pessoas com acesso à pasta. Lista
 * vazia = remove todas as restrições (pasta volta a ficar aberta a toda
 * a empresa).
 */
export const definir: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin' && auth.role !== 'gestor') {
    return forbidden('Apenas admin ou gestor pode gerir acessos a pastas');
  }

  const pastaId = event.pathParameters?.id;
  if (!pastaId) return badRequest('ID da pasta obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }
  const parsed = DefinirAcessosSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const pasta = await db.send(
    new GetCommand({ TableName: DOCUMENTOS_TABLE, Key: { PK: `empresa#${auth.empresaId}`, SK: `pasta#${pastaId}` } }),
  );
  if (!pasta.Item || pasta.Item.deletedAt) return notFound('Pasta não encontrada');

  try {
    // Remove as concessões actuais
    const actuais = await db.send(
      new QueryCommand({
        TableName: DOCUMENTOS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': `pasta#${pastaId}#acesso#`,
        },
      }),
    );
    for (const item of actuais.Items ?? []) {
      await db.send(new DeleteCommand({ TableName: DOCUMENTOS_TABLE, Key: { PK: item.PK, SK: item.SK } }));
    }

    // Grava as novas
    const now = new Date().toISOString();
    for (const u of parsed.data.utilizadores) {
      await db.send(
        new PutCommand({
          TableName: DOCUMENTOS_TABLE,
          Item: {
            PK: `empresa#${auth.empresaId}`,
            SK: `pasta#${pastaId}#acesso#${u.id}`,
            pastaId,
            empresaId: auth.empresaId,
            utilizadorId: u.id,
            utilizadorNome: u.nome,
            concedidoPor: auth.userId,
            createdAt: now,
          },
        }),
      );
    }

    await registarAuditoria(auth, 'definir-acessos', 'pasta', pastaId, {
      totalUtilizadores: parsed.data.utilizadores.length,
    });
    return ok({ pastaId, utilizadores: parsed.data.utilizadores });
  } catch (err) {
    logger.error('Erro ao definir acessos da pasta', { error: String(err), pastaId });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const pastaId = event.pathParameters?.id;
  if (!pastaId) return badRequest('ID da pasta obrigatório');

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: DOCUMENTOS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': `pasta#${pastaId}#acesso#`,
        },
      }),
    );
    return ok({ items: result.Items ?? [] });
  } catch (err) {
    logger.error('Erro ao listar acessos da pasta', { error: String(err), pastaId });
    return internalError();
  }
};
