import type { APIGatewayProxyHandler } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
} from '@aws-sdk/client-cognito-identity-provider';
import { ok, badRequest, unauthorized, internalError, logger } from '@dru-bos/shared';
import { RefreshSchema } from '../schemas';

const cognito = new CognitoIdentityProviderClient({ region: 'af-south-1' });

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Corpo da requisição inválido — JSON malformado');
  }

  const parsed = RefreshSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  }

  const { refreshToken } = parsed.data;

  try {
    const result = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: process.env.COGNITO_CLIENT_ID!,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      }),
    );

    const tokens = result.AuthenticationResult;
    if (!tokens) {
      return unauthorized('Token expirado ou inválido');
    }

    return ok({
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      expiresIn: tokens.ExpiresIn,
      tokenType: tokens.TokenType,
    });
  } catch (err) {
    if (err instanceof NotAuthorizedException) {
      return unauthorized('Refresh token expirado ou inválido — por favor efectue login novamente');
    }
    logger.error('Erro ao renovar tokens', { error: String(err) });
    return internalError();
  }
};
