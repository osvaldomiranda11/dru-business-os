export {};

process.env.RESTAURANTE_TABLE = 'restaurante-test';
process.env.AUDITORIA_TABLE = 'auditoria-test';

jest.mock('@dru-bos/shared', () => ({
  db: { send: jest.fn() },
  ok: (data: unknown, statusCode = 200) => ({ statusCode, body: JSON.stringify({ data }) }),
  created: (data: unknown) => ({ statusCode: 201, body: JSON.stringify({ data }) }),
  badRequest: (message: string) => ({ statusCode: 400, body: message }),
  unauthorized: () => ({ statusCode: 401 }),
  forbidden: () => ({ statusCode: 403 }),
  conflict: (message: string) => ({ statusCode: 409, body: message }),
  internalError: () => ({ statusCode: 500 }),
  verifyToken: jest.fn().mockResolvedValue({ userId: 'user-1', empresaId: 'empresa-1', role: 'gestor' }),
  extractToken: jest.fn().mockReturnValue('token'),
  logger: { error: jest.fn() },
}));

const { db } = require('@dru-bos/shared') as { db: { send: jest.Mock } };
const { abrir, movimentar, fechar, listar } = require('./caixas') as typeof import('./caixas');
const send = db.send;
const handlerArgs = (event: Record<string, unknown>) => [event as never, {} as never, {} as never] as const;

describe('caixas - atomicidade e consistencia', () => {
  beforeEach(() => send.mockReset());

  it('abre caixa, reserva o único lock e audita na mesma transacao', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});

    const result = await abrir(...handlerArgs({ body: JSON.stringify({ fundoInicial: 50000 }), headers: {} }));
    const transaction = send.mock.calls[2][0].input.TransactItems;

    expect((result as { statusCode: number }).statusCode).toBe(201);
    expect(transaction).toHaveLength(3);
    expect(transaction[0].Put.Item.tipo).toBe('caixa');
    expect(transaction[1].Put.Item.SK).toBe('lock#caixa-aberto');
    expect(transaction[1].Put.ConditionExpression).toContain('attribute_not_exists(PK)');
    expect(transaction[2].Put.TableName).toBe('auditoria-test');
  });

  it('devolve conflito se outra abertura ganhou o lock sem gravar caixa parcial', async () => {
    const error = Object.assign(new Error('transaction cancelled'), { name: 'TransactionCanceledException' });
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [] }).mockRejectedValueOnce(error);

    const result = await abrir(...handlerArgs({ body: JSON.stringify({ fundoInicial: 50000 }), headers: {} }));

    expect((result as { statusCode: number }).statusCode).toBe(409);
    expect(send.mock.calls[2][0].input.TransactItems).toHaveLength(3);
  });

  it('grava movimento, atualiza saldo e audita na mesma transacao', async () => {
    send.mockResolvedValueOnce({ Item: { estado: 'aberto' } }).mockResolvedValueOnce({});

    const result = await movimentar(...handlerArgs({
      pathParameters: { id: 'caixa-1' },
      body: JSON.stringify({ tipo: 'sangria', valor: 1000, metodo: 'numerario', motivo: 'Depósito' }),
      headers: {},
    }));
    const transaction = send.mock.calls[1][0].input.TransactItems;

    expect((result as { statusCode: number }).statusCode).toBe(201);
    expect(transaction).toHaveLength(3);
    expect(transaction[1].Update.UpdateExpression).toContain('ADD totalEntradas :entrada, totalSaidas :saida');
    expect(transaction[2].Put.TableName).toBe('auditoria-test');
  });

  it('fecha caixa, remove lock e audita atomicamente', async () => {
    send
      .mockResolvedValueOnce({ Item: { estado: 'aberto', totalEntradas: 50000, totalSaidas: 5000 } })
      .mockResolvedValueOnce({ Item: { caixaId: 'caixa-1' } })
      .mockResolvedValueOnce({});

    const result = await fechar(...handlerArgs({
      pathParameters: { id: 'caixa-1' },
      body: JSON.stringify({ numerarioContado: 45000 }),
      headers: {},
    }));
    const transaction = send.mock.calls[2][0].input.TransactItems;

    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(transaction).toHaveLength(3);
    expect(transaction[1].Delete.Key.SK).toBe('lock#caixa-aberto');
    expect(transaction[2].Put.TableName).toBe('auditoria-test');
  });

  it('filtra movimentos de caixa ao listar caixas', async () => {
    send.mockResolvedValueOnce({ Items: [{ tipo: 'caixa', id: 'caixa-1' }], Count: 1 });

    const result = await listar(...handlerArgs({ headers: {} }));
    const input = send.mock.calls[0][0].input;
    const data = JSON.parse((result as { body: string }).body).data;

    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(input.FilterExpression).toContain('#type = :cash');
    expect(data.items).toHaveLength(1);
  });
});
