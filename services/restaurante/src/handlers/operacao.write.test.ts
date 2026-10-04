export {};

process.env.RESTAURANTE_TABLE = 'restaurante-test';
process.env.STOCK_TABLE = 'stock-test';
process.env.FATURACAO_TABLE = 'faturacao-test';
process.env.AUDITORIA_TABLE = 'auditoria-test';

jest.mock('@dru-bos/shared', () => ({
  db: { send: jest.fn() },
  ok: (data: unknown, statusCode = 200) => ({ statusCode, body: JSON.stringify({ success: true, data }) }),
  created: (data: unknown) => ({ statusCode: 201, body: JSON.stringify({ success: true, data }) }),
  badRequest: (message: string) => ({ statusCode: 400, body: message }),
  unauthorized: () => ({ statusCode: 401 }),
  forbidden: () => ({ statusCode: 403 }),
  conflict: (message: string) => ({ statusCode: 409, body: message }),
  notFound: (message: string) => ({ statusCode: 404, body: message }),
  internalError: () => ({ statusCode: 500 }),
  verifyToken: jest.fn().mockResolvedValue({ userId: 'user-1', empresaId: 'empresa-1', role: 'gestor' }),
  extractToken: jest.fn().mockReturnValue('token'),
  logger: { error: jest.fn() },
}));

const { db } = require('@dru-bos/shared') as { db: { send: jest.Mock } };
const { abrirPedido, listarPedidos, adicionarLinha, alterarEstado } = require('./operacao') as typeof import('./operacao');
const send = db.send;
const handlerArgs = (event: Record<string, unknown>) => [event as never, {} as never, {} as never] as const;

describe('restaurante - escritas e leitura coerentes', () => {
  beforeEach(() => send.mockReset());

  it('cria pedido, ocupa a mesa e grava auditoria na mesma transacao', async () => {
    send.mockResolvedValueOnce({});
    const mesaId = '11111111-1111-4111-8111-111111111111';

    const result = await abrirPedido(...handlerArgs({
      body: JSON.stringify({ mesaId, tipo: 'mesa' }),
      headers: {},
    }));
    const transaction = send.mock.calls[0][0].input.TransactItems;

    expect((result as { statusCode: number }).statusCode).toBe(201);
    expect(transaction).toHaveLength(3);
    expect(transaction[0].Put.TableName).toBe('restaurante-test');
    expect(transaction[1].Update.Key.SK).toBe(`mesa#${mesaId}`);
    expect(transaction[1].Update.ConditionExpression).toContain('#state = :free');
    expect(transaction[2].Put.TableName).toBe('auditoria-test');
  });

  it('retorna 409 sem deixar pedido parcial quando a mesa já foi ocupada', async () => {
    const error = Object.assign(new Error('transaction cancelled'), { name: 'TransactionCanceledException' });
    send.mockRejectedValueOnce(error);

    const result = await abrirPedido(...handlerArgs({
      body: JSON.stringify({ mesaId: '11111111-1111-4111-8111-111111111111', tipo: 'mesa' }),
      headers: {},
    }));

    expect((result as { statusCode: number }).statusCode).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.TransactItems[0].Put).toBeDefined();
  });

  it('lista pedidos do tenant com cursor de paginação', async () => {
    const lastKey = { PK: 'empresa#empresa-1', SK: 'pedido#p1' };
    send.mockResolvedValueOnce({ Items: [{ id: 'p1', estado: 'aberto' }], Count: 1, LastEvaluatedKey: lastKey });

    const result = await listarPedidos(...handlerArgs({
      queryStringParameters: { estado: 'aberto', limite: '20' },
      headers: {},
    }));
    const response = JSON.parse((result as { body: string }).body);
    const input = send.mock.calls[0][0].input;

    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(input.ExpressionAttributeValues[':pk']).toBe('empresa#empresa-1');
    expect(input.ExpressionAttributeValues[':state']).toBe('aberto');
    expect(response.data.items).toHaveLength(1);
    expect(Buffer.from(response.data.nextCursor, 'base64url').toString()).toBe(JSON.stringify(lastKey));
  });

  it('acrescenta linhas com list_append sem substituir uma leitura antiga', async () => {
    send.mockResolvedValueOnce({ Attributes: { total: 1600 } });

    const result = await adicionarLinha(...handlerArgs({
      pathParameters: { id: 'pedido-1' },
      body: JSON.stringify({ produtoId: '11111111-1111-4111-8111-111111111111', nome: 'Sumo', quantidade: 2, precoUnitario: 800 }),
      headers: {},
    }));
    const update = send.mock.calls[0][0].input;

    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(update.UpdateExpression).toContain('list_append(if_not_exists(linhas');
    expect(update.UpdateExpression).toContain('if_not_exists(#total, :zero) + :lineTotal');
    expect(update.ExpressionAttributeNames['#total']).toBe('total');
  });

  it('cancela pedido e liberta a mesa na mesma transacao', async () => {
    send
      .mockResolvedValueOnce({ Item: { id: 'pedido-1', estado: 'aberto', mesaId: '11111111-1111-4111-8111-111111111111' } })
      .mockResolvedValueOnce({ Item: { id: '11111111-1111-4111-8111-111111111111', estado: 'ocupada', pedidoId: 'pedido-1' } })
      .mockResolvedValueOnce({});

    const result = await alterarEstado(...handlerArgs({
      pathParameters: { id: 'pedido-1' },
      body: JSON.stringify({ estado: 'cancelado' }),
      headers: {},
    }));
    const transaction = send.mock.calls[2][0].input.TransactItems;

    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(transaction).toHaveLength(3);
    expect(transaction[1].Update.UpdateExpression).toContain('REMOVE pedidoId');
    expect(transaction[2].Put.TableName).toBe('auditoria-test');
  });

  it('não permite fechar por alteração simples e ignorar stock', async () => {
    const result = await alterarEstado(...handlerArgs({
      pathParameters: { id: 'pedido-1' },
      body: JSON.stringify({ estado: 'fechado' }),
      headers: {},
    }));

    expect((result as { statusCode: number }).statusCode).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });
});
