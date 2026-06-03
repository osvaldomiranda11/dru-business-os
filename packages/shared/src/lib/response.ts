import type { APIGatewayProxyResult } from 'aws-lambda';

const headers = {
  'Content-Type': 'application/json',
  'X-Powered-By': 'DRU Business OS',
};

export function ok<T>(data: T, statusCode = 200): APIGatewayProxyResult {
  return {
    statusCode,
    headers,
    body: JSON.stringify({ success: true, data }),
  };
}

export function created<T>(data: T): APIGatewayProxyResult {
  return ok(data, 201);
}

export function noContent(): APIGatewayProxyResult {
  return {
    statusCode: 204,
    headers,
    body: '',
  };
}

export function error(
  statusCode: number,
  message: string,
  details?: unknown,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers,
    body: JSON.stringify({ success: false, error: message, details }),
  };
}

export function badRequest(message: string, details?: unknown): APIGatewayProxyResult {
  return error(400, message, details);
}

export function unauthorized(message = 'Não autorizado'): APIGatewayProxyResult {
  return error(401, message);
}

export function forbidden(message = 'Sem permissão para este recurso'): APIGatewayProxyResult {
  return error(403, message);
}

export function notFound(message = 'Recurso não encontrado'): APIGatewayProxyResult {
  return error(404, message);
}

export function conflict(message: string): APIGatewayProxyResult {
  return error(409, message);
}

export function internalError(message = 'Erro interno do servidor'): APIGatewayProxyResult {
  return error(500, message);
}
