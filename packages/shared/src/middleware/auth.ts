import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { Role, AuthContext } from '../types';
import { unauthorized, forbidden } from '../lib/response';
import { logger } from '../lib/logger';

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID!,
      tokenUse: 'id',
      clientId: process.env.COGNITO_CLIENT_ID!,
    });
  }
  return verifier;
}

export function extractToken(event: APIGatewayProxyEvent): string | null {
  const header = event.headers?.Authorization ?? event.headers?.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

export async function verifyToken(token: string): Promise<AuthContext | null> {
  try {
    const payload = await getVerifier().verify(token);
    return {
      userId: payload.sub,
      empresaId: payload['custom:empresa_id'] as string,
      email: payload.email as string,
      nome: payload.name as string,
      role: payload['custom:role'] as Role,
    };
  } catch (err) {
    logger.warn('Token inválido', { error: String(err) });
    return null;
  }
}

export function requireAuth(roles?: Role[]) {
  return async (
    event: APIGatewayProxyEvent & { auth?: AuthContext },
  ): Promise<APIGatewayProxyResult | null> => {
    const token = extractToken(event);
    if (!token) return unauthorized();

    const auth = await verifyToken(token);
    if (!auth) return unauthorized();

    if (roles && !roles.includes(auth.role)) {
      return forbidden();
    }

    event.auth = auth;
    return null;
  };
}
