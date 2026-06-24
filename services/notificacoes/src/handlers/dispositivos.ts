/**
 * Gestão de FCM tokens — Lambda HTTP autenticado.
 *
 * O app Android regista o seu FCM token aqui após login. O token é guardado
 * no DynamoDB com TTL de 90 dias — se o app não voltar a confirmar nesse
 * tempo, a entrada auto-elimina-se (e a tabela mantém-se limpa).
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  db,
  created,
  noContent,
  badRequest,
  unauthorized,
  internalError,
  verifyToken,
  extractToken,
  logger,
} from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const DISPOSITIVOS_TABLE = process.env.DISPOSITIVOS_TABLE!;
const TTL_DIAS = 90;

const RegistarSchema = z.object({
  fcmToken: z.string().min(20).max(4096),
  plataforma: z.enum(['android', 'ios', 'web']),
  modelo: z.string().max(100).optional(),
  versaoApp: z.string().max(20).optional(),
});

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

export const registar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = RegistarSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const { fcmToken, plataforma, modelo, versaoApp } = parsed.data;
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + TTL_DIAS * 86400;

  // Dedup: usar SK = dispositivo#{utilizadorId}#{hash do token} para que o mesmo
  // dispositivo (mesmo token) não duplique se voltar a registar.
  const tokenHash = fcmToken.slice(-16);
  const id = uuidv4();

  try {
    await db.send(new PutCommand({
      TableName: DISPOSITIVOS_TABLE,
      Item: {
        PK: `empresa#${auth.empresaId}`,
        SK: `dispositivo#${auth.userId}#${tokenHash}`,
        GSI1PK: `utilizador#${auth.userId}`,
        GSI1SK: `dispositivo#${tokenHash}`,
        id,
        empresaId: auth.empresaId,
        utilizadorId: auth.userId,
        fcmToken,
        plataforma,
        modelo,
        versaoApp,
        registadoEm: now.toISOString(),
        lastSeenAt: now.toISOString(),
        ttl,
      },
    }));
    logger.info('Dispositivo registado', {
      utilizadorId: auth.userId,
      plataforma,
      tokenHash,
    });
    return created({ id, tokenHash, expiraEm: ttl });
  } catch (err) {
    logger.error('Erro ao registar dispositivo', { error: String(err) });
    return internalError();
  }
};

export const remover: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  const tokenHash = event.pathParameters?.deviceId;
  if (!tokenHash) return badRequest('deviceId obrigatório (últimos 16 chars do token)');

  try {
    await db.send(new DeleteCommand({
      TableName: DISPOSITIVOS_TABLE,
      Key: {
        PK: `empresa#${auth.empresaId}`,
        SK: `dispositivo#${auth.userId}#${tokenHash}`,
      },
    }));
    return noContent();
  } catch (err) {
    logger.error('Erro ao remover dispositivo', { error: String(err) });
    return internalError();
  }
};

/**
 * Lista todos os dispositivos admin da empresa — usado pelos handlers
 * EventBridge para descobrir quem notificar.
 */
export async function listarAdminsEmpresa(empresaId: string): Promise<string[]> {
  const UTILIZADORES_TABLE = process.env.UTILIZADORES_TABLE!;
  const utilizadores = await db.send(new QueryCommand({
    TableName: UTILIZADORES_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#role = :admin AND attribute_not_exists(deletedAt) AND ativo = :ativo',
    ExpressionAttributeNames: { '#role': 'role' },
    ExpressionAttributeValues: {
      ':pk': `empresa#${empresaId}`,
      ':prefix': 'utilizador#',
      ':admin': 'admin',
      ':ativo': true,
    },
  }));
  return (utilizadores.Items ?? []).map((u) => u.id as string);
}

export async function listarTokensUtilizadores(
  empresaId: string,
  utilizadorIds: string[],
): Promise<string[]> {
  if (utilizadorIds.length === 0) return [];
  const tokens: string[] = [];
  // Querys paralelos por utilizador via GSI1
  await Promise.all(utilizadorIds.map(async (uid) => {
    const r = await db.send(new QueryCommand({
      TableName: DISPOSITIVOS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `utilizador#${uid}` },
    }));
    for (const it of r.Items ?? []) {
      if (it.fcmToken && it.empresaId === empresaId) {
        tokens.push(it.fcmToken as string);
      }
    }
  }));
  return tokens;
}
