import type { APIGatewayProxyHandler } from 'aws-lambda';
import crypto from 'crypto';
import { PutCommand, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
import { FILES_BUCKET } from '../lib/util';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;
const PARTILHAS_TABLE = process.env.PARTILHAS_TABLE!;
const s3 = new S3Client({ region: 'af-south-1' });

const CriarPartilhaSchema = z.object({
  diasValidade: z.number().int().min(1).max(365).default(7),
  limiteAcessos: z.number().int().min(1).max(1000).optional(),
});

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

function gerarToken(): string {
  // 32 bytes aleatórios em base64url — suficientemente longo para não ser adivinhável
  return crypto.randomBytes(32).toString('base64url');
}

// ── Autenticados (gestão da partilha) ────────────────────────────────────────

export const criar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para partilhar documentos');

  const documentoId = event.pathParameters?.id;
  if (!documentoId) return badRequest('ID do documento obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }
  const parsed = CriarPartilhaSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const documento = await db.send(
    new GetCommand({ TableName: DOCUMENTOS_TABLE, Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${documentoId}` } }),
  );
  if (!documento.Item || documento.Item.deletedAt) return notFound('Documento não encontrado');

  const now = new Date();
  const expiraEm = new Date(now.getTime() + parsed.data.diasValidade * 24 * 60 * 60 * 1000);
  const token = gerarToken();

  const partilha = {
    PK: `token#${token}`,
    token,
    empresaId: auth.empresaId,
    documentoId,
    criadoPor: auth.userId,
    criadoEm: now.toISOString(),
    expiraEm: expiraEm.toISOString(),
    expiraEmEpoch: Math.floor(expiraEm.getTime() / 1000),
    limiteAcessos: parsed.data.limiteAcessos,
    acessosContagem: 0,
    revogada: false,
  };

  try {
    await db.send(new PutCommand({ TableName: PARTILHAS_TABLE, Item: partilha, ConditionExpression: 'attribute_not_exists(PK)' }));
    await registarAuditoria(auth, 'partilhar', 'documento', documentoId, { token, expiraEm: partilha.expiraEm });
    return created({ token, expiraEm: partilha.expiraEm, limiteAcessos: partilha.limiteAcessos });
  } catch (err) {
    logger.error('Erro ao criar partilha', { error: String(err), documentoId });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const documentoId = event.pathParameters?.id;
  if (!documentoId) return badRequest('ID do documento obrigatório');

  try {
    // Tabela pequena, uso interno pouco frequente — Scan filtrado é
    // aceitável. Se o volume crescer muito, adiciona-se um GSI por
    // documentoId.
    const result = await db.send(
      new ScanCommand({
        TableName: PARTILHAS_TABLE,
        FilterExpression: 'documentoId = :documentoId AND empresaId = :empresaId',
        ExpressionAttributeValues: { ':documentoId': documentoId, ':empresaId': auth.empresaId },
      }),
    );
    return ok({ items: result.Items ?? [] });
  } catch (err) {
    logger.error('Erro ao listar partilhas', { error: String(err), documentoId });
    return internalError();
  }
};

export const revogar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para revogar partilhas');

  const documentoId = event.pathParameters?.id;
  const token = event.pathParameters?.token;
  if (!documentoId || !token) return badRequest('Parâmetros obrigatórios em falta');

  try {
    const partilha = await db.send(new GetCommand({ TableName: PARTILHAS_TABLE, Key: { PK: `token#${token}` } }));
    if (!partilha.Item || partilha.Item.empresaId !== auth.empresaId || partilha.Item.documentoId !== documentoId) {
      return notFound('Partilha não encontrada');
    }

    await db.send(
      new UpdateCommand({
        TableName: PARTILHAS_TABLE,
        Key: { PK: `token#${token}` },
        UpdateExpression: 'SET revogada = :true',
        ExpressionAttributeValues: { ':true': true },
      }),
    );
    await registarAuditoria(auth, 'revogar-partilha', 'documento', documentoId, { token });
    return noContent();
  } catch (err) {
    logger.error('Erro ao revogar partilha', { error: String(err), documentoId, token });
    return internalError();
  }
};

// ── Público (sem autenticação — usado por quem recebe o link) ───────────────

export const acederPublico: APIGatewayProxyHandler = async (event) => {
  const token = event.pathParameters?.token;
  if (!token) return badRequest('Token obrigatório');

  try {
    const partilhaResult = await db.send(new GetCommand({ TableName: PARTILHAS_TABLE, Key: { PK: `token#${token}` } }));
    const partilha = partilhaResult.Item;
    if (!partilha) return notFound('Link inválido ou expirado');
    if (partilha.revogada) return forbidden('Este link foi revogado');
    if (new Date(partilha.expiraEm) < new Date()) return forbidden('Este link expirou');
    if (partilha.limiteAcessos && partilha.acessosContagem >= partilha.limiteAcessos) {
      return forbidden('Este link atingiu o limite de acessos');
    }

    const documento = await db.send(
      new GetCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${partilha.empresaId}`, SK: `documento#${partilha.documentoId}` },
      }),
    );
    if (!documento.Item || documento.Item.deletedAt) return notFound('Documento já não está disponível');

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: FILES_BUCKET, Key: documento.Item.s3Key }),
      { expiresIn: 900 }, // 15 minutos — o link de partilha é longo prazo, mas cada acesso gera uma URL curta
    );

    // Incrementa contagem de acessos — best-effort, não bloqueia a resposta em caso de falha
    try {
      await db.send(
        new UpdateCommand({
          TableName: PARTILHAS_TABLE,
          Key: { PK: `token#${token}` },
          UpdateExpression: 'SET acessosContagem = acessosContagem + :um',
          ExpressionAttributeValues: { ':um': 1 },
        }),
      );
    } catch (err) {
      logger.error('Erro ao incrementar contagem de acessos', { error: String(err), token });
    }

    return ok({
      nome: documento.Item.nome,
      categoria: documento.Item.categoria,
      mimeType: documento.Item.mimeType,
      downloadUrl,
    });
  } catch (err) {
    logger.error('Erro ao aceder a partilha pública', { error: String(err), token });
    return internalError();
  }
};
