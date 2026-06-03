import type { APIGatewayProxyHandler } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  UserNotFoundException,
  UserNotConfirmedException,
} from '@aws-sdk/client-cognito-identity-provider';
import { ok, badRequest, unauthorized, internalError, logger } from '@dru-bos/shared';
import { LoginSchema } from '../schemas';

const cognito = new CognitoIdentityProviderClient({ region: 'af-south-1' });

export const handler: APIGatewayProxyHandler = async (event) => {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Corpo da requisição inválido — JSON malformado');
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);
  }

  const { email, password } = parsed.data;

  try {
    const result = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: process.env.COGNITO_CLIENT_ID!,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }),
    );

    const tokens = result.AuthenticationResult;
    if (!tokens) {
      return unauthorized('Autenticação falhou — por favor tente novamente');
    }

    logger.info('Login efectuado', { email });

    return ok({
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresIn: tokens.ExpiresIn,
      tokenType: tokens.TokenType,
    });
  } catch (err) {
    if (err instanceof NotAuthorizedException || err instanceof UserNotFoundException) {
      return unauthorized('Email ou password incorrectos');
    }
    if (err instanceof UserNotConfirmedException) {
      return unauthorized('Conta não confirmada — verifique o seu email');
    }
    logger.error('Erro no login', { error: String(err) });
    return internalError();
  }
};
