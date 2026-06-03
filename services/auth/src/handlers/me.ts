import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  db,
  Tables,
  ok,
  unauthorized,
  notFound,
  internalError,
  verifyToken,
  extractToken,
  logger,
} from '@dru-bos/shared';
import type { Empresa, Utilizador, AuthContext } from '@dru-bos/shared';

export const handler: APIGatewayProxyHandler = async (event) => {
  // Suporta tanto o Cognito Authorizer do API Gateway como token directo
  const claimsFromAuthorizer = event.requestContext?.authorizer?.claims as Record<string, string> | undefined;

  let auth: AuthContext | null = null;

  if (claimsFromAuthorizer?.sub) {
    auth = {
      userId: claimsFromAuthorizer.sub,
      empresaId: claimsFromAuthorizer['custom:empresa_id'],
      email: claimsFromAuthorizer.email,
      nome: claimsFromAuthorizer.name,
      role: claimsFromAuthorizer['custom:role'] as AuthContext['role'],
    };
  } else {
    const token = extractToken(event);
    if (!token) return unauthorized();
    auth = await verifyToken(token);
  }

  if (!auth) return unauthorized();

  try {
    const [empresaResult, utilizadorResult] = await Promise.all([
      db.send(
        new GetCommand({
          TableName: Tables.empresas,
          Key: {
            PK: `empresa#${auth.empresaId}`,
            SK: 'perfil#0',
          },
        }),
      ),
      db.send(
        new QueryCommand({
          TableName: Tables.utilizadores,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          FilterExpression: 'email = :email',
          ExpressionAttributeValues: {
            ':pk': `empresa#${auth.empresaId}`,
            ':sk': 'utilizador#',
            ':email': auth.email,
          },
          Limit: 1,
        }),
      ),
    ]);

    if (!empresaResult.Item) {
      return notFound('Empresa não encontrada');
    }

    const empresa = empresaResult.Item as Empresa;
    const utilizador = (utilizadorResult.Items?.[0] ?? null) as Utilizador | null;

    return ok({
      utilizador: utilizador
        ? {
            id: utilizador.id,
            email: utilizador.email,
            nome: utilizador.nome,
            role: utilizador.role,
            ativo: utilizador.ativo,
          }
        : { id: auth.userId, email: auth.email, nome: auth.nome, role: auth.role },
      empresa: {
        id: empresa.id,
        nome: empresa.nome,
        nif: empresa.nif,
        email: empresa.email,
        telefone: empresa.telefone,
        plano: empresa.plano,
        estadoSubscricao: empresa.estadoSubscricao,
        moedaPadrao: empresa.moedaPadrao,
      },
    });
  } catch (err) {
    logger.error('Erro ao obter perfil', { error: String(err), userId: auth.userId });
    return internalError();
  }
};
