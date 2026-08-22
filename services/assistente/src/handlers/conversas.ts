import type { APIGatewayProxyHandler } from 'aws-lambda';
import crypto from 'crypto';
import { PutCommand, QueryCommand, DeleteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
  internalError,
  verifyToken,
  extractToken,
  logger,
} from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const CONVERSAS_TABLE = process.env.CONVERSAS_TABLE!;

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

function pkUtilizador(auth: AuthContext): string {
  return `empresa#${auth.empresaId}#utilizador#${auth.userId}`;
}

const CriarConversaSchema = z.object({
  tituloInicial: z.string().min(1).max(200).optional(),
});

export const criar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  let body: unknown = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch {
    return badRequest('JSON malformado');
  }
  const parsed = CriarConversaSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const id = uuidv4();
  const now = new Date().toISOString();
  const conversa = {
    PK: pkUtilizador(auth),
    SK: `conversa#${id}`,
    id,
    empresaId: auth.empresaId,
    utilizadorId: auth.userId,
    titulo: parsed.data.tituloInicial ?? 'Nova conversa',
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.send(new PutCommand({ TableName: CONVERSAS_TABLE, Item: conversa }));
    return created(conversa);
  } catch (err) {
    logger.error('Erro ao criar conversa', { error: String(err) });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: CONVERSAS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': pkUtilizador(auth), ':prefix': 'conversa#' },
        ScanIndexForward: false,
      }),
    );
    // Exclui as mensagens (SK mais longo) — esta lista é só das conversas em si
    const items = (result.Items ?? []).filter((i) => !String(i.SK).includes('#mensagem#'));
    return ok({ items });
  } catch (err) {
    logger.error('Erro ao listar conversas', { error: String(err) });
    return internalError();
  }
};

export const eliminar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const conversaId = event.pathParameters?.id;
  if (!conversaId) return badRequest('ID da conversa obrigatório');

  try {
    await db.send(
      new DeleteCommand({
        TableName: CONVERSAS_TABLE,
        Key: { PK: pkUtilizador(auth), SK: `conversa#${conversaId}` },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
    return noContent();
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return notFound('Conversa não encontrada');
    logger.error('Erro ao eliminar conversa', { error: String(err), conversaId });
    return internalError();
  }
};

const AdicionarMensagemSchema = z.object({
  role: z.enum(['utilizador', 'assistente']),
  texto: z.string().min(1).max(5000),
});

export const adicionarMensagem: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const conversaId = event.pathParameters?.id;
  if (!conversaId) return badRequest('ID da conversa obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }
  const parsed = AdicionarMensagemSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const conversa = await db.send(
    new GetCommand({ TableName: CONVERSAS_TABLE, Key: { PK: pkUtilizador(auth), SK: `conversa#${conversaId}` } }),
  );
  if (!conversa.Item) return notFound('Conversa não encontrada');

  const now = new Date().toISOString();
  // Prefixo numérico (Date.now()) garante ordem cronológica; sufixo
  // aleatório evita colisão se duas mensagens forem gravadas no mesmo ms.
  const seq = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const mensagem = {
    PK: pkUtilizador(auth),
    SK: `conversa#${conversaId}#mensagem#${seq}`,
    conversaId,
    empresaId: auth.empresaId,
    utilizadorId: auth.userId,
    role: parsed.data.role,
    texto: parsed.data.texto,
    createdAt: now,
  };

  try {
    await db.send(new PutCommand({ TableName: CONVERSAS_TABLE, Item: mensagem }));

    // A primeira pergunta do utilizador vira o título da conversa (preview na lista)
    const camposUpdate = ['updatedAt = :now'];
    const valores: Record<string, unknown> = { ':now': now };
    if (parsed.data.role === 'utilizador' && conversa.Item.titulo === 'Nova conversa') {
      camposUpdate.push('titulo = :titulo');
      valores[':titulo'] = parsed.data.texto.slice(0, 100);
    }
    await db.send(
      new UpdateCommand({
        TableName: CONVERSAS_TABLE,
        Key: { PK: pkUtilizador(auth), SK: `conversa#${conversaId}` },
        UpdateExpression: `SET ${camposUpdate.join(', ')}`,
        ExpressionAttributeValues: valores,
      }),
    );

    return created(mensagem);
  } catch (err) {
    logger.error('Erro ao adicionar mensagem', { error: String(err), conversaId });
    return internalError();
  }
};

export const listarMensagens: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const conversaId = event.pathParameters?.id;
  if (!conversaId) return badRequest('ID da conversa obrigatório');

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: CONVERSAS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': pkUtilizador(auth), ':prefix': `conversa#${conversaId}#mensagem#` },
      }),
    );
    return ok({ items: result.Items ?? [] });
  } catch (err) {
    logger.error('Erro ao listar mensagens', { error: String(err), conversaId });
    return internalError();
  }
};
