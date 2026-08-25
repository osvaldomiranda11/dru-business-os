import type { APIGatewayProxyHandler, ScheduledHandler } from 'aws-lambda';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  db,
  noContent,
  badRequest,
  unauthorized,
  notFound,
  forbidden,
  internalError,
  verifyToken,
  extractToken,
  registarAuditoria,
  logger,
} from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;

/**
 * Documentos sem actividade há mais deste número de dias são arquivados
 * automaticamente — continuam pesquisáveis e acessíveis, só saem da vista
 * por omissão. Não arquivamos documentos com validade ainda válida (estão
 * claramente "vivos") nem em workflow de aprovação activo (pendente/em
 * análise) — arquivar isso a meio seria confuso.
 */
const RETENCAO_DIAS = 180;

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

export const arquivarManual: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para arquivar documentos');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do documento obrigatório');

  try {
    await db.send(
      new UpdateCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${id}` },
        UpdateExpression: 'SET arquivado = :true, arquivadoEm = :now',
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: { ':true': true, ':now': new Date().toISOString() },
      }),
    );
    await registarAuditoria(auth, 'arquivar', 'documento', id);
    return noContent();
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return notFound('Documento não encontrado');
    logger.error('Erro ao arquivar documento', { error: String(err), id });
    return internalError();
  }
};

export const desarquivar: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role === 'viewer') return forbidden('Sem permissão para desarquivar documentos');

  const id = event.pathParameters?.id;
  if (!id) return badRequest('ID do documento obrigatório');

  try {
    await db.send(
      new UpdateCommand({
        TableName: DOCUMENTOS_TABLE,
        Key: { PK: `empresa#${auth.empresaId}`, SK: `documento#${id}` },
        UpdateExpression: 'REMOVE arquivado, arquivadoEm',
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
      }),
    );
    await registarAuditoria(auth, 'desarquivar', 'documento', id);
    return noContent();
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return notFound('Documento não encontrado');
    logger.error('Erro ao desarquivar documento', { error: String(err), id });
    return internalError();
  }
};

/**
 * Corre 1x/dia. Varre TODAS as empresas à procura de documentos parados
 * há mais de RETENCAO_DIAS e arquiva-os. Scan porque é tarefa em lote,
 * não caminho de pedido — mesma lógica já usada em alertas.ts.
 */
export const arquivarAntigos: ScheduledHandler = async () => {
  const limite = new Date();
  limite.setDate(limite.getDate() - RETENCAO_DIAS);
  const limiteStr = limite.toISOString();

  logger.info('A verificar documentos para arquivo automático', { limite: limiteStr });

  let avaliados = 0;
  let arquivados = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const hojeStr = new Date().toISOString().slice(0, 10);

  do {
    const result = await db.send(
      new ScanCommand({
        TableName: DOCUMENTOS_TABLE,
        FilterExpression:
          'begins_with(SK, :docPrefix) AND NOT contains(SK, :versaoMarker) ' +
          'AND attribute_not_exists(deletedAt) AND attribute_not_exists(arquivado) ' +
          'AND updatedAt < :limite ' +
          'AND (attribute_not_exists(estadoAprovacao) OR estadoAprovacao = :aprovado OR estadoAprovacao = :rejeitado) ' +
          'AND (attribute_not_exists(dataValidade) OR dataValidade < :hoje)',
        ExpressionAttributeValues: {
          ':docPrefix': 'documento#',
          ':versaoMarker': '#versao#',
          ':limite': limiteStr,
          ':aprovado': 'aprovado',
          ':rejeitado': 'rejeitado',
          ':hoje': hojeStr,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const doc of result.Items ?? []) {
      avaliados++;
      try {
        await db.send(
          new UpdateCommand({
            TableName: DOCUMENTOS_TABLE,
            Key: { PK: doc.PK, SK: doc.SK },
            UpdateExpression: 'SET arquivado = :true, arquivadoEm = :now',
            ExpressionAttributeValues: { ':true': true, ':now': new Date().toISOString() },
          }),
        );
        arquivados++;
      } catch (err) {
        logger.error('Erro ao arquivar documento automaticamente', { error: String(err), documentoId: doc.id });
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  logger.info('Arquivo automático concluído', { avaliados, arquivados });
};
