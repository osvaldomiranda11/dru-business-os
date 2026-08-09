import type { APIGatewayProxyHandler } from 'aws-lambda';
import {
  QueryCommand,
  UpdateCommand,
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
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
import { FILES_BUCKET, MIME_TYPES_ACEITES, TAMANHO_MAXIMO_BYTES, novaChaveS3 } from '../lib/util';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const s3 = new S3Client({ region: 'af-south-1' });
const eventBridge = new EventBridgeClient({ region: 'af-south-1' });

// ── Schemas ──────────────────────────────────────────────────────────────────

const CategoriaSchema = z.enum([
  'contrato',
  'comprovativo',
  'fatura_anexo',
  'ficha_tecnica',
  'identificacao',
  'licenca',
  'outro',
]);

const SolicitarUploadSchema = z.object({
  nome: z.string().min(1).max(200),
  mimeType: z.string(),
  tamanho: z.number().int().positive(),
});

const DataValidadeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD)');

const CriarDocumentoSchema = z.object({
  documentoId: z.string().uuid(),
  s3Key: z.string(),
  nome: z.string().min(1).max(200),
  descricao: z.string().max(1000).optional(),
  categoria: CategoriaSchema,
  tags: z.array(z.string().max(30)).max(15).default([]),
  pastaId: z.string().uuid().optional(),
  mimeType: z.string(),
  tamanho: z.number().int().positive(),
  dataValidade: DataValidadeSchema.optional(),
});

const ActualizarDocumentoSchema = z.object({
  nome: z.string().min(1).max(200).optional(),
  descricao: z.string().max(1000).optional(),
  categoria: CategoriaSchema.optional(),
  tags: z.array(z.string().max(30)).max(15).optional(),
  pastaId: z.string().uuid().nullable().optional(),
  dataValidade: DataValidadeSchema.nullable().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Passo 1 do upload: gera uma URL assinada para o cliente enviar o ficheiro
 * directamente para S3 (evita o limite de payload síncrono do Lambda/API Gateway).
 */
export const solicitarUploadUrl: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para carregar documentos');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = SolicitarUploadSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  if (!MIME_TYPES_ACEITES.has(parsed.data.mimeType)) {
    return badRequest('Tipo de ficheiro não suportado', { mimeType: parsed.data.mimeType });
  }
  if (parsed.data.tamanho > TAMANHO_MAXIMO_BYTES) {
    return badRequest('Ficheiro excede o tamanho máximo de 25MB');
  }

  const documentoId = uuidv4();
  const s3Key = novaChaveS3(auth.empresaId, documentoId, 1, parsed.data.nome);

  try {
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: FILES_BUCKET, Key: s3Key, ContentType: parsed.data.mimeType }),
      { expiresIn: 900 },
    );

    return ok({ documentoId, s3Key, uploadUrl, expiresIn: 900 });
  } catch (err) {
    logger.error('Erro ao gerar URL de upload', { error: String(err) });
    return internalError();
  }
};

/**
 * Passo 2 do upload: regista a metadata do documento (versão 1) depois de
 * o ficheiro já ter sido enviado com sucesso para S3.
 */
export const criar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para carregar documentos');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = CriarDocumentoSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  const d = parsed.data;

  if (!d.s3Key.startsWith(`documentos/${auth.empresaId}/${d.documentoId}/`)) {
    return badRequest('Chave S3 não corresponde ao documento/empresa');
  }

  // Confirma que o ficheiro foi mesmo enviado antes de criar o registo
  try {
    await s3.send(new HeadObjectCommand({ Bucket: FILES_BUCKET, Key: d.s3Key }));
  } catch {
    return badRequest('Ficheiro ainda não foi carregado para S3 — envie primeiro com o uploadUrl');
  }

  if (d.pastaId) {
    const pasta = await db.send(
      new GetCommand({ TableName: DOCUMENTOS_TABLE, Key: { PK: `empresa#${auth.empresaId}`, SK: `pasta#${d.pastaId}` } }),
    );
    if (!pasta.Item || pasta.Item.deletedAt) return badRequest('Pasta não encontrada');
  }

  const now = new Date().toISOString();

  const documento = {
    PK: `empresa#${auth.empresaId}`,
    SK: `documento#${d.documentoId}`,
    id: d.documentoId,
    empresaId: auth.empresaId,
    nome: d.nome,
    nomeLower: d.nome.toLowerCase(),
    descricao: d.descricao,
    categoria: d.categoria,
    tags: d.tags,
    pastaId: d.pastaId,
    mimeType: d.mimeType,
    tamanho: d.tamanho,
    s3Key: d.s3Key,
    versaoAtual: 1,
    totalVersoes: 1,
    dataValidade: d.dataValidade,
    alertaExpiracaoEnviado: false,
    criadoPor: auth.userId,
    createdAt: now,
    updatedAt: now,
  };

  const versao = {
    PK: `empresa#${auth.empresaId}`,
    SK: `documento#${d.documentoId}#versao#0001`,
    id: uuidv4(),
    empresaId: auth.empresaId,
    documentoId: d.documentoId,
    numero: 1,
    s3Key: d.s3Key,
    mimeType: d.mimeType,
    tamanho: d.tamanho,
    enviadoPor: auth.userId,
    createdAt: now,
  };

  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: DOCUMENTOS_TABLE, Item: documento, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: DOCUMENTOS_TABLE, Item: versao } },
        ],
      }),
    );
    await registarAuditoria(auth, 'criar', 'documento', d.documentoId, { nome: d.nome, categoria: d.categoria });
    logger.info('Documento criado', { id: d.documentoId, empresaId: auth.empresaId });

    // Dispara extração de texto pesquisável em background (não bloqueia a resposta)
    try {
      await eventBridge.send(
        new PutEventsCommand({
          Entries: [{
            EventBusName: EVENT_BUS_NAME,
            Source: 'dru-bos.documentos',
            DetailType: 'DocumentoCarregado',
            Detail: JSON.stringify({
              empresaId: auth.empresaId,
              documentoId: d.documentoId,
              s3Key: d.s3Key,
              mimeType: d.mimeType,
            }),
          }],
        }),
      );
    } catch (evtErr) {
      // Falha a publicar o evento não deve impedir a criação do documento —
      // fica sem texto pesquisável, mas continua utilizável.
      logger.error('Erro ao publicar evento DocumentoCarregado', { error: String(evtErr) });
    }

    return created(documento);
  } catch (err) {
    logger.error('Erro ao criar documento', { error: String(err) });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const qs = event.queryStringParameters ?? {};
  const limite = Math.min(Number(qs.limite ?? 50), 100);
  const pesquisa = qs.pesquisa?.trim().toLowerCase();
  const categoria = qs.categoria;
  const pastaId = qs.pastaId;
  const estadoValidade = qs.estadoValidade; // 'a_vencer' | 'expirado'
  const cursor = qs.cursor;

  const filtros: string[] = ['attribute_not_exists(deletedAt)'];
  const exprValues: Record<string, unknown> = { ':pk': `empresa#${auth.empresaId}`, ':prefix': 'documento#' };
  const exprNames: Record<string, string> = {};

  if (pesquisa || estadoValidade === 'expirado' || estadoValidade === 'a_vencer') {
    // Pesquisa ou filtro de validade ignoram o escopo da pasta actual —
    // ambos são vistas globais da empresa, não da pasta aberta.
    if (pesquisa) {
      filtros.push('(contains(nomeLower, :pesquisa) OR contains(textoExtraidoLower, :pesquisa))');
      exprValues[':pesquisa'] = pesquisa;
    }
  } else if (pastaId) {
    filtros.push('pastaId = :pastaId');
    exprValues[':pastaId'] = pastaId;
  } else if (qs.pastaId === '') {
    filtros.push('attribute_not_exists(pastaId)');
  }
  if (categoria) {
    filtros.push('categoria = :categoria');
    exprValues[':categoria'] = categoria;
  }
  if (estadoValidade === 'expirado' || estadoValidade === 'a_vencer') {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const hojeStr = hoje.toISOString().slice(0, 10);

    if (estadoValidade === 'expirado') {
      filtros.push('attribute_exists(dataValidade) AND dataValidade < :hoje');
      exprValues[':hoje'] = hojeStr;
    } else {
      const limiteData = new Date(hoje);
      limiteData.setDate(limiteData.getDate() + 60);
      filtros.push('attribute_exists(dataValidade) AND dataValidade BETWEEN :hoje AND :limiteVencer');
      exprValues[':hoje'] = hojeStr;
      exprValues[':limiteVencer'] = limiteData.toISOString().slice(0, 10);
    }
  }

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: DOCUMENTOS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: filtros.join(' AND '),
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length > 0 && { ExpressionAttributeNames: exprNames }),
        // Exclui itens de versão da listagem principal (só documentos "raiz")
        Limit: limite,
        ScanIndexForward: false,
        ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, 'base64').toString()) : undefined,
      }),
    );

    // SK de documentos é `documento#{id}` (sem sufixo #versao#), versões têm SK mais longo
    let items = (result.Items ?? []).filter((i) => !String(i.SK).includes('#versao#'));

    // Prioriza correspondências pelo nome sobre correspondências só no
    // conteúdo (OCR) — evita a frustração de pesquisar um nome exacto e
    // ver resultados de conteúdo à frente.
    if (pesquisa) {
      items = items.sort((a, b) => {
        const aNome = String(a.nomeLower ?? '').includes(pesquisa) ? 0 : 1;
        const bNome = String(b.nomeLower ?? '').includes(pesquisa) ? 0 : 1;
        return aNome - bNome; // sort é estável — mantém a ordem relativa dentro do grupo
      });
    }

    const nextCursor = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return ok({ items, total: items.length, nextCursor });
  } catch (err) {
    logger.error('Erro ao listar documentos', { error: String(err) });
    return internalError();
  }
};

export const obter: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do documento obrigatório');

  try {
    const result = await db.send(
      new GetCommand({ TableName: DOCUMENTOS_TABLE, Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${id}` } }),
    );
    if (!result.Item || result.Item.deletedAt) return notFound('Documento não encontrado');

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: FILES_BUCKET, Key: result.Item.s3Key }),
      { expiresIn: 3600 },
    );

    return ok({ ...result.Item, downloadUrl, downloadUrlExpiraEm: 3600 });
  } catch (err) {
    logger.error('Erro ao obter documento', { error: String(err), id });
    return internalError();
  }
};

export const actualizar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para actualizar documentos');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do documento obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = ActualizarDocumentoSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  if (Object.keys(parsed.data).length === 0) return badRequest('Pelo menos um campo obrigatório');

  if (parsed.data.pastaId) {
    const pasta = await db.send(
      new GetCommand({ TableName: DOCUMENTOS_TABLE, Key: { PK: `empresa#${auth.empresaId}`, SK: `pasta#${parsed.data.pastaId}` } }),
    );
    if (!pasta.Item || pasta.Item.deletedAt) return badRequest('Pasta não encontrada');
  }

  const now = new Date().toISOString();
  const campos = (Object.keys(parsed.data) as Array<keyof typeof parsed.data>).filter(
    (c) => c !== 'dataValidade',
  );
  const updateExpr = ['updatedAt = :updatedAt', ...campos.map((c) => `${c} = :${c}`)];
  const removeExpr: string[] = [];
  const exprValues: Record<string, unknown> = { ':updatedAt': now };
  for (const c of campos) exprValues[`:${c}`] = parsed.data[c];

  // Mantém nomeLower sincronizado com nome — é o campo usado na pesquisa
  if (parsed.data.nome !== undefined) {
    updateExpr.push('nomeLower = :nomeLower');
    exprValues[':nomeLower'] = parsed.data.nome.toLowerCase();
  }

  // dataValidade é tratado à parte: null remove o campo (documento passa a
  // não ter validade), e qualquer alteração reinicia o alerta de expiração
  // para não perder o aviso de uma nova data.
  if ('dataValidade' in parsed.data) {
    if (parsed.data.dataValidade) {
      updateExpr.push('dataValidade = :dataValidade', 'alertaExpiracaoEnviado = :falso');
      exprValues[':dataValidade'] = parsed.data.dataValidade;
      exprValues[':falso'] = false;
    } else {
      removeExpr.push('dataValidade', 'alertaExpiracaoEnviado');
    }
  }

  const updateExpression = `SET ${updateExpr.join(', ')}${
    removeExpr.length > 0 ? ` REMOVE ${removeExpr.join(', ')}` : ''
  }`;

  try {
    await db.send(
      new UpdateCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${id}` },
        UpdateExpression: updateExpression,
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: exprValues,
      }),
    );
    await registarAuditoria(auth, 'actualizar', 'documento', id, parsed.data);
    return ok({ id, ...parsed.data, updatedAt: now });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return notFound('Documento não encontrado');
    }
    logger.error('Erro ao actualizar documento', { error: String(err), id });
    return internalError();
  }
};

export const eliminar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin' && auth.role !== 'gestor') {
    return forbidden('Apenas admin ou gestor pode eliminar documentos');
  }

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do documento obrigatório');

  const now = new Date().toISOString();
  try {
    await db.send(
      new UpdateCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${id}` },
        UpdateExpression: 'SET deletedAt = :deletedAt, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: { ':deletedAt': now, ':updatedAt': now },
      }),
    );
    await registarAuditoria(auth, 'eliminar', 'documento', id);
    return noContent();
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return notFound('Documento não encontrado');
    }
    logger.error('Erro ao eliminar documento', { error: String(err), id });
    return internalError();
  }
};
