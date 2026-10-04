process.env.RESTAURANTE_TABLE = 'restaurante-test';
process.env.STOCK_TABLE = 'stock-test';
process.env.FATURACAO_TABLE = 'faturacao-test';
process.env.AUDITORIA_TABLE = 'auditoria-test';

jest.mock('@dru-bos/shared', () => ({
  db: { send: jest.fn() },
  ok: (data: unknown) => ({ statusCode: 200, body: JSON.stringify({ data }) }),
  created: jest.fn(),
  badRequest: (message: string) => ({ statusCode: 400, body: message }),
  unauthorized: () => ({ statusCode: 401 }),
  forbidden: () => ({ statusCode: 403 }),
  conflict: (message: string) => ({ statusCode: 409, body: message }),
  notFound: () => ({ statusCode: 404 }),
  internalError: () => ({ statusCode: 500 }),
  verifyToken: jest.fn().mockResolvedValue({ userId: 'user-1', empresaId: 'empresa-1', role: 'gestor' }),
  extractToken: jest.fn().mockReturnValue('token'),
  registarAuditoria: jest.fn().mockResolvedValue(undefined),
  logger: { error: jest.fn() },
}));

import { db } from '@dru-bos/shared';
import { fecharPedido } from './operacao';

const send = db.send as jest.Mock;

describe('fecharPedido - integracao stock', () => {
  beforeEach(() => send.mockReset());

  it('agrega linhas repetidas e fecha pedido na mesma transacao da baixa de stock', async () => {
    send
      .mockResolvedValueOnce({ Item: { estado: 'entregue', total: 1500, linhas: [
        { produtoId: '11111111-1111-4111-8111-111111111111', nome: 'Sumo', quantidade: 1, total: 500 },
        { produtoId: '11111111-1111-4111-8111-111111111111', nome: 'Sumo', quantidade: 2, total: 1000 },
      ], mesaId: '22222222-2222-4222-8222-222222222222' } })
      .mockResolvedValueOnce({ Item: { ativo: true, stockActual: 10 } })
      .mockResolvedValueOnce({ Item: { estado: 'ocupada', pedidoId: 'pedido-1' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await fecharPedido({ pathParameters: { id: 'pedido-1' }, headers: {} } as never, {} as never, {} as never);
    const transaction = send.mock.calls[3][0].input.TransactItems;

    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(transaction).toHaveLength(5);
    expect(transaction[0].Put.Item.quantidade).toBe(3);
    expect(transaction[1].Update.ExpressionAttributeValues[':delta']).toBe(-3);
    expect(transaction[2].Update.UpdateExpression).toContain('stockAplicado');
    expect(transaction[3].Update.UpdateExpression).toContain('REMOVE pedidoId');
    expect(transaction[4].Put.TableName).toBe('auditoria-test');
  });
});
