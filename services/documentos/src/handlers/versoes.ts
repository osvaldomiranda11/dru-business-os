import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  db,
  ok,
  created,
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
import { FILES_BUCKET, MIME_TYPES_ACEITES, TAMANHO_MAXIMO_BYTES, novaChaveS3, numeroVersaoFormatado } from '../lib/util';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;
const s3 = new S3Client({ region: 'af-south-1' });

const SolicitarUploadVersaoSchema = z.object({
  nome: z.string().min(1).max(200),
  mimeType: z.string(),
  tamanho: z.number().int().positive(),
});

const CriarVersaoSchema = z.object({
  s3Key: z.string(),
  mimeType: z.string(),
  tamanho: z.number().int().positive(),
  comentario: z.string().max(500).optional(),
});

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

async function obterDocumentoActivo(empresaId: string, id: string) {
  const result = await db.send(
    new GetCommand({ TableName: DOCUMENTOS_TABLE, Key: { PK: `empresa#${empresaId}`, SK: `documento#${id}` } }),
  );
  if (!result.Item || result.Item.deletedAt) return null;
  return result.Item;
}

export const solicitarUploadUrl: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para carregar novas versões');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do documento obrigatório');

  const documento = await obterDocumentoActivo(auth.empresaId, id);
  if (!documento) return notFound('Documento não encontrado');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = SolicitarUploadVersaoSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  if (!MIME_TYPES_ACEITES.has(parsed.data.mimeType)) {
    return badRequest('Tipo de ficheiro não suportado', { mimeType: parsed.data.mimeType });
  }
  if (parsed.data.tamanho > TAMANHO_MAXIMO_BYTES) {
    return badRequest('Ficheiro excede o tamanho máximo de 25MB');
  }

  const proximoNumero = (documento.versaoAtual as number) + 1;
  const s3Key = novaChaveS3(auth.empresaId, id, proximoNumero, parsed.data.nome);

  try {
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: FILES_BUCKET, Key: s3Key, ContentType: parsed.data.mimeType }),
      { expiresIn: 900 },
    );
    return ok({ s3Key, uploadUrl, proximoNumero, expiresIn: 900 });
  } catch (err) {
    logger.error('Erro ao gerar URL de upload de versão', { error: String(err), id });
    return internalError();
  }
};

export const criar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para carregar novas versões');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do documento obrigatório');

  const documento = await obterDocumentoActivo(auth.empresaId, id);
  if (!documento) return notFound('Documento não encontrado');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = CriarVersaoSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  const d = parsed.data;

  if (!d.s3Key.startsWith(`documentos/${auth.empresaId}/${id}/`)) {
    return badRequest('Chave S3 não corresponde ao documento/empresa');
  }

  try {
    await s3.send(new HeadObjectCommand({ Bucket: FILES_BUCKET, Key: d.s3Key }));
  } catch {
    return badRequest('Ficheiro ainda não foi carregado para S3 — envie primeiro com o uploadUrl');
  }

  const numero = (documento.versaoAtual as number) + 1;
  const now = new Date().toISOString();

  const versao = {
    PK: `empresa#${auth.empresaId}`,
    SK: `documento#${id}#versao#${numeroVersaoFormatado(numero)}`,
    id: uuidv4(),
    empresaId: auth.empresaId,
    documentoId: id,
    numero,
    s3Key: d.s3Key,
    mimeType: d.mimeType,
    tamanho: d.tamanho,
    comentario: d.comentario,
    enviadoPor: auth.userId,
    createdAt: now,
  };

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: DOCUMENTOS_TABLE,
              Item: versao,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Update: {
              TableName: DOCUMENTOS_TABLE,
              Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${id}` },
              UpdateExpression:
                'SET versaoAtual = :numero, totalVersoes = :numero, s3Key = :s3Key, mimeType = :mimeType, tamanho = :tamanho, updatedAt = :updatedAt',
              ConditionExpression: 'versaoAtual = :versaoAnterior',
              ExpressionAttributeValues: {
                ':numero': numero,
                ':versaoAnterior': documento.versaoAtual,
                ':s3Key': d.s3Key,
                ':mimeType': d.mimeType,
                ':tamanho': d.tamanho,
                ':updatedAt': now,
              },
            },
          },
        ],
      }),
    );
    await registarAuditoria(auth, 'nova-versao', 'documento', id, { numero, comentario: d.comentario });
    logger.info('Nova versão de documento', { id, numero, empresaId: auth.empresaId });
    return created(versao);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'TransactionCanceledException') {
      return badRequest('O documento foi alterado entretanto — recarregue e tente novamente');
    }
    logger.error('Erro ao criar versão', { error: String(err), id });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do documento obrigatório');

  const documento = await obterDocumentoActivo(auth.empresaId, id);
  if (!documento) return notFound('Documento não encontrado');

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: DOCUMENTOS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': `documento#${id}#versao#`,
        },
        ScanIndexForward: false,
      }),
    );
    return ok({ items: result.Items ?? [], total: result.Count ?? 0 });
  } catch (err) {
    logger.error('Erro ao listar versões', { error: String(err), id });
    return internalError();
  }
};

export const obter: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const id = event.pathParameters?.id;
  const numeroStr = event.pathParameters?.numero;
  if (!id || !numeroStr) return badRequest('ID do documento e número de versão obrigatórios');

  const numero = Number(numeroStr);
  if (!Number.isInteger(numero) || numero < 1) return badRequest('Número de versão inválido');

  try {
    const result = await db.send(
      new GetCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${id}#versao#${numeroVersaoFormatado(numero)}` },
      }),
    );
    if (!result.Item) return notFound('Versão não encontrada');

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: FILES_BUCKET, Key: result.Item.s3Key }),
      { expiresIn: 3600 },
    );

    return ok({ ...result.Item, downloadUrl, downloadUrlExpiraEm: 3600 });
  } catch (err) {
    logger.error('Erro ao obter versão', { error: String(err), id, numero });
    return internalError();
  }
};
