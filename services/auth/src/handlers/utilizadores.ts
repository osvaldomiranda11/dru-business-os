/**
 * Gestão de Utilizadores — DRU Business OS
 *
 * Permite ao admin convidar, listar, alterar role e remover utilizadores
 * da sua empresa. Cria utilizadores no Cognito (com password temporária)
 * e no DynamoDB com a mesma transacção lógica que o register.
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { PutCommand, QueryCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import {
  db,
  Tables,
  ok,
  created,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  internalError,
  verifyToken,
  extractToken,
  registarAuditoria,
  logger,
} from '@dru-bos/shared';
import type { AuthContext, Utilizador } from '@dru-bos/shared';

const cognito = new CognitoIdentityProviderClient({ region: 'af-south-1' });
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;

// ── Schemas ──────────────────────────────────────────────────────────────────

const ConvidarSchema = z.object({
  nome: z.string().min(2).max(150),
  email: z.string().email(),
  role: z.enum(['admin', 'gestor', 'vendedor', 'viewer']).default('vendedor'),
});

const AlterarRoleSchema = z.object({
  role: z.enum(['admin', 'gestor', 'vendedor', 'viewer']),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

function passwordTemporaria(): string {
  // 16 chars: maiúscula + minúscula + dígito + símbolo + 12 chars aleatórios
  const random = randomBytes(9).toString('base64').replace(/[/+=]/g, 'a');
  return `Aa1!${random}`;
}

async function obterUtilizador(empresaId: string, id: string): Promise<Utilizador | null> {
  const result = await db.send(
    new GetCommand({
      TableName: Tables.utilizadores,
      Key: { PK: `empresa#${empresaId}`, SK: `utilizador#${id}` },
    }),
  );
  return (result.Item as Utilizador | undefined) ?? null;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: Tables.utilizadores,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: 'attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'utilizador#',
        },
      }),
    );

    const items = (result.Items ?? []).map((u) => ({
      id: u.id,
      email: u.email,
      nome: u.nome,
      role: u.role,
      ativo: u.ativo,
      createdAt: u.createdAt,
    }));

    return ok({ items, total: items.length });
  } catch (err) {
    logger.error('Erro ao listar utilizadores', { error: String(err) });
    return internalError();
  }
};

export const convidar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin') return forbidden('Apenas administradores podem convidar utilizadores');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = ConvidarSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const { nome, email, role } = parsed.data;
  const utilizadorId = uuidv4();
  const password = passwordTemporaria();
  const now = new Date().toISOString();

  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: nome },
          { Name: 'custom:empresa_id', Value: auth.empresaId },
          { Name: 'custom:role', Value: role },
        ],
      }),
    );

    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        Password: password,
        Permanent: false, // utilizador é obrigado a mudar no primeiro login
      }),
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      return conflict('Este email já está registado');
    }
    logger.error('Erro ao criar utilizador no Cognito', { error: String(err) });
    return internalError();
  }

  const utilizador: Utilizador = {
    PK: `empresa#${auth.empresaId}`,
    SK: `utilizador#${utilizadorId}`,
    GSI1PK: `email#${email}`,
    GSI1SK: `empresa#${auth.empresaId}`,
    id: utilizadorId,
    empresaId: auth.empresaId,
    cognitoSub: '',
    email,
    nome,
    role,
    ativo: true,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.send(new PutCommand({ TableName: Tables.utilizadores, Item: utilizador }));
    await registarAuditoria(auth, 'convidar', 'utilizador', utilizadorId, { email, role });
    logger.info('Utilizador convidado', { email, role, empresaId: auth.empresaId });

    return created({
      id: utilizadorId,
      nome,
      email,
      role,
      passwordTemporaria: password,
      message: 'Utilizador convidado. Será obrigado a definir nova password no primeiro login.',
    });
  } catch (err) {
    logger.error('Erro ao gravar utilizador no DynamoDB', { error: String(err) });
    return internalError();
  }
};

export const alterarRole: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin') return forbidden('Apenas administradores podem alterar roles');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do utilizador obrigatório');
  if (id === auth.userId) return badRequest('Não pode alterar o seu próprio role');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = AlterarRoleSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const { role: novoRole } = parsed.data;

  try {
    const utilizador = await obterUtilizador(auth.empresaId, id);
    if (!utilizador || utilizador.deletedAt) return notFound('Utilizador não encontrado');
    if (utilizador.role === novoRole) return conflict('Utilizador já possui este role');

    const now = new Date().toISOString();

    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: utilizador.email,
        UserAttributes: [{ Name: 'custom:role', Value: novoRole }],
      }),
    );

    await db.send(
      new UpdateCommand({
        TableName: Tables.utilizadores,
        Key: { PK: utilizador.PK, SK: utilizador.SK },
        UpdateExpression: 'SET #role = :role, updatedAt = :now',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':role': novoRole, ':now': now },
      }),
    );

    await registarAuditoria(auth, 'alterar-role', 'utilizador', id, {
      roleAnterior: utilizador.role,
      roleNovo: novoRole,
    });

    return ok({ id, role: novoRole, updatedAt: now });
  } catch (err) {
    logger.error('Erro ao alterar role', { error: String(err), id });
    return internalError();
  }
};

export const desactivar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin') return forbidden('Apenas administradores podem desactivar utilizadores');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do utilizador obrigatório');
  if (id === auth.userId) return badRequest('Não pode desactivar a sua própria conta');

  try {
    const utilizador = await obterUtilizador(auth.empresaId, id);
    if (!utilizador || utilizador.deletedAt) return notFound('Utilizador não encontrado');

    const now = new Date().toISOString();

    await cognito.send(
      new AdminDisableUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: utilizador.email,
      }),
    );

    await db.send(
      new UpdateCommand({
        TableName: Tables.utilizadores,
        Key: { PK: utilizador.PK, SK: utilizador.SK },
        UpdateExpression: 'SET ativo = :falso, updatedAt = :now',
        ExpressionAttributeValues: { ':falso': false, ':now': now },
      }),
    );

    await registarAuditoria(auth, 'desactivar', 'utilizador', id);
    return ok({ id, ativo: false, updatedAt: now });
  } catch (err) {
    logger.error('Erro ao desactivar utilizador', { error: String(err), id });
    return internalError();
  }
};

export const reactivar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin') return forbidden('Apenas administradores podem reactivar utilizadores');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do utilizador obrigatório');

  try {
    const utilizador = await obterUtilizador(auth.empresaId, id);
    if (!utilizador || utilizador.deletedAt) return notFound('Utilizador não encontrado');

    const now = new Date().toISOString();

    await cognito.send(
      new AdminEnableUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: utilizador.email,
      }),
    );

    await db.send(
      new UpdateCommand({
        TableName: Tables.utilizadores,
        Key: { PK: utilizador.PK, SK: utilizador.SK },
        UpdateExpression: 'SET ativo = :verdade, updatedAt = :now',
        ExpressionAttributeValues: { ':verdade': true, ':now': now },
      }),
    );

    await registarAuditoria(auth, 'reactivar', 'utilizador', id);
    return ok({ id, ativo: true, updatedAt: now });
  } catch (err) {
    logger.error('Erro ao reactivar utilizador', { error: String(err), id });
    return internalError();
  }
};
