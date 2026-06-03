import type { APIGatewayProxyHandler } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { db, Tables, created, badRequest, conflict, internalError, logger } from '@dru-bos/shared';
import { RegisterSchema } from '../schemas';
import type { Empresa, Utilizador } from '@dru-bos/shared';

const cognito = new CognitoIdentityProviderClient({ region: 'af-south-1' });

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Corpo da requisição inválido — JSON malformado');
  }

  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  }

  const { nome, email, password, nomeEmpresa, nifEmpresa, telefone, moedaPadrao } = parsed.data;

  const empresaId = uuidv4();
  const now = new Date().toISOString();

  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID!,
        Username: email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: nome },
          { Name: 'custom:empresa_id', Value: empresaId },
          { Name: 'custom:role', Value: 'admin' },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      return conflict('Este email já está registado');
    }
    logger.error('Erro ao criar utilizador no Cognito', { error: String(err) });
    return internalError();
  }

  try {
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID!,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
  } catch (err) {
    logger.error('Erro ao definir password no Cognito', { error: String(err) });
    return internalError();
  }

  const empresa: Empresa = {
    PK: `empresa#${empresaId}`,
    SK: 'perfil#0',
    id: empresaId,
    nome: nomeEmpresa,
    nif: nifEmpresa,
    email,
    telefone,
    plano: 'starter',
    estadoSubscricao: 'trial',
    moedaPadrao: moedaPadrao as 'AOA' | 'USD',
    createdAt: now,
    updatedAt: now,
  };

  const utilizadorId = uuidv4();

  const utilizador: Utilizador = {
    PK: `empresa#${empresaId}`,
    SK: `utilizador#${utilizadorId}`,
    GSI1PK: `email#${email}`,
    GSI1SK: `empresa#${empresaId}`,
    id: utilizadorId,
    empresaId,
    cognitoSub: '',
    email,
    nome,
    role: 'admin',
    ativo: true,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await Promise.all([
      db.send(new PutCommand({ TableName: Tables.empresas, Item: empresa })),
      db.send(
        new PutCommand({
          TableName: Tables.utilizadores,
          Item: utilizador,
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      ),
    ]);
  } catch (err) {
    logger.error('Erro ao gravar empresa/utilizador no DynamoDB', { error: String(err) });
    return internalError();
  }

  logger.info('Nova empresa registada', { empresaId, email, nomeEmpresa });

  return created({
    empresaId,
    email,
    nome,
    nomeEmpresa,
    plano: 'starter',
    message: 'Empresa registada com sucesso. Pode efectuar login.',
  });
};
