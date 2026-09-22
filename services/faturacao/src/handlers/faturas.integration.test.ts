jest.mock('@dru-bos/shared', () => ({
  db: { send: jest.fn() },
  ok: jest.fn(), created: jest.fn(), badRequest: jest.fn(), unauthorized: jest.fn(), forbidden: jest.fn(), notFound: jest.fn(), conflict: jest.fn(), internalError: jest.fn(),
  verifyToken: jest.fn(), extractToken: jest.fn(), registarAuditoria: jest.fn(), logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({ FailedEntryCount: 0 }) })),
  PutEventsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { aplicarPagamento } from './faturas';

const { db: mockedDb } = jest.requireMock('@dru-bos/shared') as { db: { send: jest.Mock } };
const send = mockedDb.send;
const eventSend = (jest.requireMock('@aws-sdk/client-eventbridge').EventBridgeClient as jest.Mock).mock.results[0].value.send as jest.Mock;

const fatura = {
  PK: 'empresa#empresa-1', SK: 'fatura#2026#000001', GSI1PK: 'tipo#fatura', GSI1SK: 'data#2026-09-22#FT',
  id: 'fatura-1', empresaId: 'empresa-1', numero: 'FT 2026/000001', ano: 2026, sequencial: 1,
  clienteNome: 'Cliente', moeda: 'AOA' as const, estado: 'pendente' as const, linhas: [], subtotal: 100,
  totalIva: 14, total: 114, totalPago: 0, dataEmissao: '2026-09-22', criadoPor: 'user-1', createdAt: '2026-09-22', updatedAt: '2026-09-22',
};

describe('pagamento - integracao transacional', () => {
  beforeEach(() => { send.mockReset(); eventSend.mockClear(); });

  it('incrementa o total dentro da transacao e publica um evento', async () => {
    send.mockImplementation(async (command: { input?: any }) => {
      if (command.input?.TransactItems) return {};
      if (command.input?.Key?.SK === fatura.SK) return { Item: { ...fatura, totalPago: 50 } };
      return {};
    });

    const result = await aplicarPagamento('empresa-1', fatura, { valor: 50, metodo: 'numerario', data: '2026-09-22' }, 'user-1');

    expect(result.novoTotalPago).toBe(50);
    expect(send.mock.calls[0][0].input.TransactItems[1].Update.UpdateExpression).toContain('ADD totalPago :valor');
    expect(eventSend).toHaveBeenCalledTimes(1);
  });

  it('não publica segundo evento quando o mesmo webhook é reenviado', async () => {
    let primeira = true;
    send.mockImplementation(async (command: { input?: Record<string, any> }) => {
      if (command.input?.TransactItems) {
        if (primeira) { primeira = false; return {}; }
        const error = new Error('duplicate'); Object.assign(error, { name: 'TransactionCanceledException' }); throw error;
      }
      if (command.input?.Key?.SK.includes('#pagamento#')) return { Item: { valor: 50, faturaId: fatura.id } };
      return { Item: { ...fatura, totalPago: 50 } };
    });

    await aplicarPagamento('empresa-1', fatura, { valor: 50, metodo: 'multicaixa', referencia: 'MC-1', data: '2026-09-22' }, 'sistema', 'MC-1');
    await aplicarPagamento('empresa-1', fatura, { valor: 50, metodo: 'multicaixa', referencia: 'MC-1', data: '2026-09-22' }, 'sistema', 'MC-1');

    expect(eventSend).toHaveBeenCalledTimes(1);
  });
});