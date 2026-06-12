/**
 * Serviço de Faturação — DRU Business OS
 *
 * Fase 2 — Implementação completa.
 * Numeração sequencial anual por empresa (formato AGT: FT <ano>/<sequencial>),
 * cálculo de IVA por linha, geração de PDF e registo de pagamentos.
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — versão standalone com fontes embebidas, sem leitura de .afm em runtime
import PDFDocument from 'pdfkit/js/pdfkit.standalone.js';
import {
  db,
  ok,
  created,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  internalError,
  verifyToken,
  extractToken,
  registarAuditoria,
  logger,
} from '@dru-bos/shared';
import type { AuthContext, Fatura, LinhaFatura } from '@dru-bos/shared';

const FATURACAO_TABLE = process.env.FATURACAO_TABLE!;
const FILES_BUCKET = process.env.FILES_BUCKET!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

const s3 = new S3Client({ region: 'af-south-1' });
const eventBridge = new EventBridgeClient({ region: 'af-south-1' });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Schemas ──────────────────────────────────────────────────────────────────

const LinhaInputSchema = z.object({
  descricao: z.string().min(1).max(200),
  quantidade: z.number().positive(),
  precoUnitario: z.number().nonnegative(),
  ivaTaxa: z.number().min(0).max(100).default(14), // IVA padrão Angola = 14%
});

const EmitirFaturaSchema = z.object({
  clienteId: z.string().uuid().optional(),
  clienteNome: z.string().min(2).max(150),
  clienteNif: z.string().regex(/^\d{9,14}$/).optional(),
  moeda: z.enum(['AOA', 'USD']).default('AOA'),
  dataEmissao: z.string().regex(DATE_RE).default(() => new Date().toISOString().split('T')[0]),
  dataVencimento: z.string().regex(DATE_RE).optional(),
  linhas: z.array(LinhaInputSchema).min(1, 'A fatura deve ter pelo menos uma linha'),
  observacoes: z.string().max(1000).optional(),
});

const PagamentoSchema = z.object({
  valor: z.number().positive(),
  metodo: z.enum(['transferencia', 'multicaixa', 'numerario', 'cartao', 'outro']),
  referencia: z.string().max(100).optional(),
  data: z.string().regex(DATE_RE).default(() => new Date().toISOString().split('T')[0]),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

function round2(valor: number): number {
  return Math.round(valor * 100) / 100;
}

function calcularLinhas(linhas: z.infer<typeof LinhaInputSchema>[]): {
  linhasCalculadas: LinhaFatura[];
  subtotal: number;
  totalIva: number;
  total: number;
} {
  let subtotal = 0;
  let totalIva = 0;

  const linhasCalculadas: LinhaFatura[] = linhas.map((l) => {
    const linhaSubtotal = round2(l.quantidade * l.precoUnitario);
    const linhaIva = round2(linhaSubtotal * (l.ivaTaxa / 100));
    const linhaTotal = round2(linhaSubtotal + linhaIva);
    subtotal += linhaSubtotal;
    totalIva += linhaIva;
    return {
      descricao: l.descricao,
      quantidade: l.quantidade,
      precoUnitario: l.precoUnitario,
      ivaTaxa: l.ivaTaxa,
      subtotal: linhaSubtotal,
      ivaValor: linhaIva,
      total: linhaTotal,
    };
  });

  subtotal = round2(subtotal);
  totalIva = round2(totalIva);
  const total = round2(subtotal + totalIva);

  return { linhasCalculadas, subtotal, totalIva, total };
}

/**
 * Obtém o próximo número sequencial de fatura para a empresa, no ano indicado.
 * Usa um contador atómico (ADD) por empresa/ano — seguro para concorrência.
 */
async function obterProximoSequencial(empresaId: string, ano: number): Promise<number> {
  const result = await db.send(
    new UpdateCommand({
      TableName: FATURACAO_TABLE,
      Key: { PK: `empresa#${empresaId}`, SK: `contador#fatura#${ano}` },
      UpdateExpression: 'ADD sequencial :inc SET updatedAt = :now',
      ExpressionAttributeValues: { ':inc': 1, ':now': new Date().toISOString() },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(result.Attributes?.sequencial ?? 1);
}

/**
 * Localiza uma fatura pelo seu ID (uuid). Como a SK usa ano/sequencial,
 * pesquisamos via GSI1 (tipo#fatura) e filtramos por id.
 */
export async function obterFaturaPorId(empresaId: string, id: string): Promise<Fatura | null> {
  const result = await db.send(
    new QueryCommand({
      TableName: FATURACAO_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk',
      FilterExpression: 'id = :id AND attribute_not_exists(deletedAt)',
      ExpressionAttributeValues: {
        ':gsi1pk': 'tipo#fatura',
        ':id': id,
      },
    }),
  );
  return (result.Items?.find((i) => i.empresaId === empresaId) as Fatura | undefined) ?? null;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const emitir: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para emitir faturas');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = EmitirFaturaSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const { clienteId, clienteNome, clienteNif, moeda, dataEmissao, dataVencimento, linhas, observacoes } = parsed.data;
  const ano = Number(dataEmissao.split('-')[0]);

  try {
    const sequencial = await obterProximoSequencial(auth.empresaId, ano);
    const numero = `FT ${ano}/${String(sequencial).padStart(6, '0')}`;
    const { linhasCalculadas, subtotal, totalIva, total } = calcularLinhas(linhas);

    const id = uuidv4();
    const now = new Date().toISOString();

    const fatura: Fatura = {
      PK: `empresa#${auth.empresaId}`,
      SK: `fatura#${ano}#${String(sequencial).padStart(6, '0')}`,
      GSI1PK: 'tipo#fatura',
      GSI1SK: `data#${dataEmissao}#${numero}`,
      id,
      empresaId: auth.empresaId,
      numero,
      ano,
      sequencial,
      clienteId,
      clienteNome,
      clienteNif,
      moeda,
      estado: 'pendente',
      linhas: linhasCalculadas,
      subtotal,
      totalIva,
      total,
      totalPago: 0,
      dataEmissao,
      dataVencimento,
      observacoes,
      criadoPor: auth.userId,
      createdAt: now,
      updatedAt: now,
    };

    await db.send(new PutCommand({ TableName: FATURACAO_TABLE, Item: fatura }));

    await eventBridge.send(
      new PutEventsCommand({
        Entries: [{
          EventBusName: EVENT_BUS_NAME,
          Source: 'dru-bos.faturacao',
          DetailType: 'FaturaEmitida',
          Detail: JSON.stringify({
            empresaId: auth.empresaId,
            faturaId: id,
            numero,
            clienteId,
            total,
            moeda,
          }),
        }],
      }),
    );

    await registarAuditoria(auth, 'emitir', 'fatura', id, { numero, total, clienteNome });
    logger.info('Fatura emitida', { id, numero, empresaId: auth.empresaId });
    return created(fatura);
  } catch (err) {
    logger.error('Erro ao emitir fatura', { error: String(err) });
    return internalError();
  }
};

export const listar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const qs = event.queryStringParameters ?? {};
  const estado = qs.estado;
  const limite = Math.min(Number(qs.limite ?? 50), 100);
  const cursor = qs.cursor;

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: FATURACAO_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: estado
          ? 'attribute_not_exists(deletedAt) AND estado = :estado'
          : 'attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: {
          ':pk': `empresa#${auth.empresaId}`,
          ':prefix': 'fatura#',
          ...(estado && { ':estado': estado }),
        },
        Limit: limite,
        ScanIndexForward: false,
        ExclusiveStartKey: cursor
          ? JSON.parse(Buffer.from(cursor, 'base64').toString())
          : undefined,
      }),
    );

    const nextCursor = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return ok({ items: result.Items ?? [], total: result.Count ?? 0, nextCursor });
  } catch (err) {
    logger.error('Erro ao listar faturas', { error: String(err) });
    return internalError();
  }
};

export const obter: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID da fatura obrigatório');

  try {
    const fatura = await obterFaturaPorId(auth.empresaId, id);
    if (!fatura) return notFound('Fatura não encontrada');
    return ok(fatura);
  } catch (err) {
    logger.error('Erro ao obter fatura', { error: String(err), id });
    return internalError();
  }
};

/**
 * Aplica um pagamento a uma fatura — reutilizado pelo endpoint autenticado
 * de registo de pagamentos e pelo webhook Multicaixa Express.
 */
export async function aplicarPagamento(
  empresaId: string,
  fatura: Fatura,
  pagamento: { valor: number; metodo: string; referencia?: string; data: string },
  registadoPor: string,
): Promise<{ pagamentoId: string; novoTotalPago: number; novoEstado: Fatura['estado'] }> {
  const novoTotalPago = round2(fatura.totalPago + pagamento.valor);
  const novoEstado: Fatura['estado'] = novoTotalPago >= fatura.total ? 'paga' : 'parcial';
  const now = new Date().toISOString();
  const pagamentoId = uuidv4();

  await Promise.all([
    db.send(
      new PutCommand({
        TableName: FATURACAO_TABLE,
        Item: {
          PK: `empresa#${empresaId}`,
          SK: `fatura#${fatura.ano}#${String(fatura.sequencial).padStart(6, '0')}#pagamento#${pagamentoId}`,
          id: pagamentoId,
          empresaId,
          faturaId: fatura.id,
          faturaNumero: fatura.numero,
          valor: pagamento.valor,
          moeda: fatura.moeda,
          metodo: pagamento.metodo,
          referencia: pagamento.referencia,
          data: pagamento.data,
          registadoPor,
          createdAt: now,
        },
      }),
    ),
    db.send(
      new UpdateCommand({
        TableName: FATURACAO_TABLE,
        Key: { PK: fatura.PK, SK: fatura.SK },
        UpdateExpression: 'SET totalPago = :totalPago, estado = :estado, updatedAt = :now',
        ExpressionAttributeValues: {
          ':totalPago': novoTotalPago,
          ':estado': novoEstado,
          ':now': now,
        },
      }),
    ),
  ]);

  await eventBridge.send(
    new PutEventsCommand({
      Entries: [{
        EventBusName: EVENT_BUS_NAME,
        Source: 'dru-bos.faturacao',
        DetailType: 'PagamentoRegistado',
        Detail: JSON.stringify({
          empresaId,
          faturaId: fatura.id,
          numero: fatura.numero,
          valor: pagamento.valor,
          metodo: pagamento.metodo,
          estado: novoEstado,
        }),
      }],
    }),
  );

  return { pagamentoId, novoTotalPago, novoEstado };
}

export const registarPagamento: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para registar pagamentos');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID da fatura obrigatório');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = PagamentoSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  try {
    const fatura = await obterFaturaPorId(auth.empresaId, id);
    if (!fatura) return notFound('Fatura não encontrada');
    if (fatura.estado === 'paga') return conflict('Fatura já se encontra paga');
    if (fatura.estado === 'anulada') return conflict('Fatura anulada não pode receber pagamentos');

    const { valor, metodo, referencia, data } = parsed.data;
    const { pagamentoId, novoTotalPago, novoEstado } = await aplicarPagamento(
      auth.empresaId,
      fatura,
      { valor, metodo, referencia, data },
      auth.userId,
    );

    await registarAuditoria(auth, 'registar-pagamento', 'fatura', fatura.id, { valor, metodo, novoEstado });
    return created({
      pagamentoId,
      faturaId: fatura.id,
      numero: fatura.numero,
      valor,
      totalPago: novoTotalPago,
      estado: novoEstado,
    });
  } catch (err) {
    logger.error('Erro ao registar pagamento', { error: String(err), id });
    return internalError();
  }
};

export const gerarPdf: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID da fatura obrigatório');

  try {
    const fatura = await obterFaturaPorId(auth.empresaId, id);
    if (!fatura) return notFound('Fatura não encontrada');

    const pdfBuffer = await gerarPdfBuffer(fatura);
    const key = `faturas/${auth.empresaId}/${fatura.numero.replace(/\s|\//g, '-')}.pdf`;

    await s3.send(
      new PutObjectCommand({
        Bucket: FILES_BUCKET,
        Key: key,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
      }),
    );

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: FILES_BUCKET, Key: key }),
      { expiresIn: 3600 },
    );

    return ok({ url, expiresIn: 3600, numero: fatura.numero });
  } catch (err) {
    logger.error('Erro ao gerar PDF', { error: String(err), id });
    return internalError();
  }
};

function gerarPdfBuffer(fatura: Fatura): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('FATURA', { align: 'right' });
    doc.fontSize(10).text(`Nº ${fatura.numero}`, { align: 'right' });
    doc.text(`Data de emissão: ${fatura.dataEmissao}`, { align: 'right' });
    if (fatura.dataVencimento) {
      doc.text(`Data de vencimento: ${fatura.dataVencimento}`, { align: 'right' });
    }
    doc.moveDown(2);

    doc.fontSize(12).text('Cliente:', { underline: true });
    doc.fontSize(10).text(fatura.clienteNome);
    if (fatura.clienteNif) doc.text(`NIF: ${fatura.clienteNif}`);
    doc.moveDown(1.5);

    const startX = 50;
    let y = doc.y;
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Descrição', startX, y, { width: 200 });
    doc.text('Qtd', startX + 200, y, { width: 50, align: 'right' });
    doc.text('Preço Unit.', startX + 250, y, { width: 80, align: 'right' });
    doc.text('IVA %', startX + 330, y, { width: 50, align: 'right' });
    doc.text('Total', startX + 380, y, { width: 90, align: 'right' });
    doc.moveDown(0.5);
    doc.font('Helvetica');
    doc.moveTo(startX, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    for (const linha of fatura.linhas) {
      y = doc.y;
      doc.text(linha.descricao, startX, y, { width: 200 });
      doc.text(String(linha.quantidade), startX + 200, y, { width: 50, align: 'right' });
      doc.text(linha.precoUnitario.toFixed(2), startX + 250, y, { width: 80, align: 'right' });
      doc.text(`${linha.ivaTaxa}%`, startX + 330, y, { width: 50, align: 'right' });
      doc.text(linha.total.toFixed(2), startX + 380, y, { width: 90, align: 'right' });
      doc.moveDown(0.5);
    }

    doc.moveDown(1);
    doc.moveTo(startX, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold');
    doc.text(`Subtotal: ${fatura.subtotal.toFixed(2)} ${fatura.moeda}`, { align: 'right' });
    doc.text(`IVA: ${fatura.totalIva.toFixed(2)} ${fatura.moeda}`, { align: 'right' });
    doc.fontSize(12).text(`Total: ${fatura.total.toFixed(2)} ${fatura.moeda}`, { align: 'right' });

    doc.moveDown(1);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Estado: ${fatura.estado.toUpperCase()}`, { align: 'right' });
    if (fatura.totalPago > 0) {
      doc.text(`Pago: ${fatura.totalPago.toFixed(2)} ${fatura.moeda}`, { align: 'right' });
    }

    if (fatura.observacoes) {
      doc.moveDown(1.5);
      doc.fontSize(9).text(`Observações: ${fatura.observacoes}`);
    }

    doc.moveDown(2);
    doc.fontSize(8).fillColor('gray').text(
      'Documento processado por programa válido — DRU Business OS',
      { align: 'center' },
    );

    doc.end();
  });
}
