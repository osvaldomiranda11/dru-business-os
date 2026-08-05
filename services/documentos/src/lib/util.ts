import { v4 as uuidv4 } from 'uuid';

export const FILES_BUCKET = process.env.FILES_BUCKET!;

/**
 * Tipos de ficheiro aceites no repositório documental.
 * Mantido restrito de propósito — evita upload de executáveis ou tipos
 * que não fazem sentido num repositório de documentos empresariais.
 */
export const MIME_TYPES_ACEITES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
]);

export const TAMANHO_MAXIMO_BYTES = 25 * 1024 * 1024; // 25MB

export function novaChaveS3(empresaId: string, documentoId: string, versao: number, nomeFicheiro: string): string {
  const extensao = nomeFicheiro.includes('.') ? nomeFicheiro.split('.').pop() : undefined;
  const sufixo = extensao ? `.${extensao}` : '';
  return `documentos/${empresaId}/${documentoId}/v${versao}-${uuidv4()}${sufixo}`;
}

export function numeroVersaoFormatado(numero: number): string {
  return String(numero).padStart(4, '0');
}
