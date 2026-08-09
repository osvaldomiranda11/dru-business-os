import type { EventBridgeHandler } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { TextractClient, DetectDocumentTextCommand } from '@aws-sdk/client-textract';
import { db, logger } from '@dru-bos/shared';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;
const FILES_BUCKET = process.env.FILES_BUCKET!;

const s3 = new S3Client({ region: 'af-south-1' });
const textract = new TextractClient({ region: 'af-south-1' });

/** Limite de segurança para caber num item DynamoDB (limite real é 400KB por item) */
const LIMITE_CARACTERES = 300_000;

interface DocumentoCarregadoDetail {
  empresaId: string;
  documentoId: string;
  s3Key: string;
  mimeType: string;
}

async function lerBytesS3(key: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: FILES_BUCKET, Key: key }));
  const stream = obj.Body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function extrairTextoPdf(key: string): Promise<string | null> {
  // Extração directa do texto embutido — funciona bem para PDFs gerados
  // digitalmente (faturas, contratos exportados). PDFs só-imagem (scans)
  // não têm texto embutido e ficam sem resultado aqui.
  const pdfParse = (await import('pdf-parse')).default;
  const bytes = await lerBytesS3(key);
  const resultado = await pdfParse(bytes);
  return resultado.text?.trim() || null;
}

async function extrairTextoDocx(key: string): Promise<string | null> {
  const mammoth = await import('mammoth');
  const bytes = await lerBytesS3(key);
  const resultado = await mammoth.extractRawText({ buffer: bytes });
  return resultado.value?.trim() || null;
}

async function extrairTextoImagem(key: string): Promise<string | null> {
  const resultado = await textract.send(
    new DetectDocumentTextCommand({
      Document: { S3Object: { Bucket: FILES_BUCKET, Name: key } },
    }),
  );
  const linhas = (resultado.Blocks ?? [])
    .filter((b) => b.BlockType === 'LINE' && b.Text)
    .map((b) => b.Text as string);
  return linhas.length > 0 ? linhas.join('\n') : null;
}

export const processar: EventBridgeHandler<'DocumentoCarregado', DocumentoCarregadoDetail, void> = async (
  event,
) => {
  const { empresaId, documentoId, s3Key, mimeType } = event.detail;
  logger.info('A processar OCR/extração de texto', { documentoId, mimeType });

  let texto: string | null = null;
  let status: 'concluido' | 'falhou' | 'nao_suportado' = 'nao_suportado';

  try {
    if (mimeType === 'application/pdf') {
      texto = await extrairTextoPdf(s3Key);
      status = 'concluido';
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      // .docx (formato moderno, baseado em XML). O .doc antigo (binário)
      // não é suportado pela biblioteca — fica como "não suportado".
      texto = await extrairTextoDocx(s3Key);
      status = 'concluido';
    } else if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
      // Textract síncrono só suporta JPEG e PNG para imagens — webp/gif/etc
      // falhariam sempre, por isso ficam marcados como não suportados
      // directamente, em vez de tentar e falhar.
      texto = await extrairTextoImagem(s3Key);
      status = 'concluido';
    } else {
      logger.info('Tipo de ficheiro sem suporte a extração de texto', { mimeType, documentoId });
      status = 'nao_suportado';
    }
  } catch (err) {
    logger.error('Erro ao extrair texto do documento', { error: String(err), documentoId, mimeType });
    status = 'falhou';
  }

  const textoLower = texto?.toLowerCase().slice(0, LIMITE_CARACTERES);
  const now = new Date().toISOString();

  try {
    await db.send(
      new UpdateCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${empresaId}`, SK: `documento#${documentoId}` },
        // Só actualiza se o documento ainda existir e não tiver sido entretanto eliminado —
        // evita reviver metadata de um documento apagado por uma versão antiga em fila.
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
        UpdateExpression: textoLower
          ? 'SET ocrStatus = :status, textoExtraidoLower = :texto, ocrProcessadoEm = :now'
          : 'SET ocrStatus = :status, ocrProcessadoEm = :now REMOVE textoExtraidoLower',
        ExpressionAttributeValues: {
          ':status': status,
          ':now': now,
          ...(textoLower && { ':texto': textoLower }),
        },
      }),
    );
    logger.info('OCR concluído', { documentoId, status, temTexto: !!textoLower });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      logger.info('Documento já não existe — a ignorar resultado de OCR', { documentoId });
      return;
    }
    logger.error('Erro ao gravar resultado do OCR', { error: String(err), documentoId });
    throw err; // deixa o EventBridge tentar de novo (falha de escrita, não de extração)
  }
};
