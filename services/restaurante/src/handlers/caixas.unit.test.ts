jest.mock('@dru-bos/shared', () => ({
  db: { send: jest.fn() },
  ok: (data: unknown, statusCode = 200) => ({ statusCode, body: JSON.stringify({ data }) }),
  created: (data: unknown) => ({ statusCode: 201, body: JSON.stringify({ data }) }),
  badRequest: (message: string) => ({ statusCode: 400, body: message }),
  unauthorized: () => ({ statusCode: 401 }),
  forbidden: () => ({ statusCode: 403 }),
  conflict: () => ({ statusCode: 409 }),
  notFound: () => ({ statusCode: 404 }),
  internalError: () => ({ statusCode: 500 }),
  verifyToken: jest.fn().mockResolvedValue({ userId: 'user-1', empresaId: 'empresa-1', role: 'gestor' }),
  extractToken: jest.fn().mockReturnValue('token'),
  registarAuditoria: jest.fn().mockResolvedValue(undefined),
  logger: { error: jest.fn() },
}));

import { abrir, fechar, movimentar } from './caixas';

const { db: mockedDb } = jest.requireMock('@dru-bos/shared') as { db: { send: jest.Mock } };
const send = mockedDb.send;

describe('caixas - validacao de entrada', () => {
  beforeEach(() => send.mockReset());

  it('rejeita JSON invalido ao abrir caixa sem consultar a base de dados', async () => {
    const result = await abrir({ body: '{', headers: {} } as never, {} as never, {} as never);
    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejeita JSON invalido ao movimentar caixa', async () => {
    const result = await movimentar({ body: '{', pathParameters: { id: 'caixa-1' }, headers: {} } as never, {} as never, {} as never);
    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejeita JSON invalido ao fechar caixa', async () => {
    const result = await fechar({ body: '{', pathParameters: { id: 'caixa-1' }, headers: {} } as never, {} as never, {} as never);
    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});