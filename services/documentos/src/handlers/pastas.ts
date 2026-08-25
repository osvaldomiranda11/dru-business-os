import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, QueryCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
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
  conflict,
  internalError,
  verifyToken,
  extractToken,
  registarAuditoria,
  logger,
} from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';
import { utilizadorTemAcessoPasta } from '../lib/permissoes';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;

// ── Schemas ──────────────────────────────────────────────────────────────────

const PastaSchema = z.object({
  nome: z.string().min(1).max(100),
  pastaPaiId: z.string().uuid().optional(),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Cor inválida (formato hex)').optional(),
});

const PastaUpdateSchema = PastaSchema.partial();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const criar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para criar pastas');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = PastaSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  // Validar que a pasta-pai existe, se indicada
  if (parsed.data.pastaPaiId) {
    const pai = await db.send(
      new GetCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `pasta#${parsed.data.pastaPaiId}` },
      }),
    );
    if (!pai.Item || pai.Item.deletedAt) return badRequest('Pasta-pai não encontrada');
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  const pasta = {
    PK: `empresa#${auth.empresaId}`,
    SK: `pasta#${id}`,
    id,
    empresaId: auth.empresaId,
    nome: parsed.data.nome,
    pastaPaiId: parsed.data.pastaPaiId,
    cor: parsed.data.cor,
    criadoPor: auth.userId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.send(new PutCommand({ TableName: DOCUMENTOS_TABLE, Item: pasta }));
    await registarAuditoria(auth, 'criar', 'pasta', id, { nome: parsed.data.nome });
    return created(pasta);
  } catch (err) {
    logger.error('Erro ao criar pasta', { error: String(err) });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const qs = event.queryStringParameters ?? {};
  const pastaPaiId = qs.pastaPaiId; // undefined => pastas de topo (raiz)

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: DOCUMENTOS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: pastaPaiId
          ? 'attribute_not_exists(deletedAt) AND pastaPaiId = :pastaPaiId'
          : 'attribute_not_exists(deletedAt) AND attribute_not_exists(pastaPaiId)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'pasta#',
          ...(pastaPaiId && { ':pastaPaiId': pastaPaiId }),
        },
      }),
    );

    // Uma pasta é restrita a si própria (quem não tem acesso à pasta X não
    // a vê listada), independentemente de ser pai ou filha de outra.
    const idsComAcesso: Array<Record<string, unknown>> = [];
    for (const item of result.Items ?? []) {
      if (await utilizadorTemAcessoPasta(auth, item.id as string)) idsComAcesso.push(item);
    }

    return ok({ items: idsComAcesso, total: idsComAcesso.length });
  } catch (err) {
    logger.error('Erro ao listar pastas', { error: String(err) });
    return internalError();
  }
};

export const actualizar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para actualizar pastas');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID da pasta obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = PastaUpdateSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  if (Object.keys(parsed.data).length === 0) return badRequest('Pelo menos um campo obrigatório');

  if (parsed.data.pastaPaiId === id) return badRequest('Uma pasta não pode ser pai de si própria');

  const now = new Date().toISOString();

  const updateExpr: string[] = ['updatedAt = :updatedAt'];
  const exprValues: Record<string, unknown> = { ':updatedAt': now };

  if (parsed.data.nome !== undefined) {
    updateExpr.push('nome = :nome');
    exprValues[':nome'] = parsed.data.nome;
  }
  if (parsed.data.cor !== undefined) {
    updateExpr.push('cor = :cor');
    exprValues[':cor'] = parsed.data.cor;
  }
  if (parsed.data.pastaPaiId !== undefined) {
    updateExpr.push('pastaPaiId = :pastaPaiId');
    exprValues[':pastaPaiId'] = parsed.data.pastaPaiId;
  }

  try {
    await db.send(
      new UpdateCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `pasta#${id}` },
        UpdateExpression: `SET ${updateExpr.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: exprValues,
      }),
    );
    await registarAuditoria(auth, 'actualizar', 'pasta', id, parsed.data);
    return ok({ id, ...parsed.data, updatedAt: now });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return notFound('Pasta não encontrada');
    }
    logger.error('Erro ao actualizar pasta', { error: String(err), id });
    return internalError();
  }
};

export const eliminar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin' && auth.role !== 'gestor') {
    return forbidden('Apenas admin ou gestor pode eliminar pastas');
  }

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID da pasta obrigatório');

  try {
    // Impedir eliminação de pasta com documentos dentro
    const documentos = await db.send(
      new QueryCommand({
        TableName: DOCUMENTOS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'attribute_not_exists(deletedAt) AND pastaId = :pastaId',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'documento#',
          ':pastaId': id,
        },
        Limit: 1,
      }),
    );
    if ((documentos.Items ?? []).length > 0) {
      return conflict('Pasta contém documentos — mova-os ou elimine-os primeiro');
    }

    // Impedir eliminação de pasta com subpastas
    const subpastas = await db.send(
      new QueryCommand({
        TableName: DOCUMENTOS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'attribute_not_exists(deletedAt) AND pastaPaiId = :pastaPaiId',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'pasta#',
          ':pastaPaiId': id,
        },
        Limit: 1,
      }),
    );
    if ((subpastas.Items ?? []).length > 0) {
      return conflict('Pasta contém subpastas — mova-as ou elimine-as primeiro');
    }

    const now = new Date().toISOString();
    await db.send(
      new UpdateCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `pasta#${id}` },
        UpdateExpression: 'SET deletedAt = :deletedAt, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: { ':deletedAt': now, ':updatedAt': now },
      }),
    );
    await registarAuditoria(auth, 'eliminar', 'pasta', id);
    return noContent();
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return notFound('Pasta não encontrada');
    }
    logger.error('Erro ao eliminar pasta', { error: String(err), id });
    return internalError();
  }
};
