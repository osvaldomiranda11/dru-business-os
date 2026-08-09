import type { ScheduledHandler } from 'aws-lambda';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { db, logger } from '@dru-bos/shared';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const eventBridge = new EventBridgeClient({ region: 'af-south-1' });

/** Avisa quando faltarem este número de dias ou menos (inclui já expirados) */
const DIAS_AVISO = 30;

/**
 * Corre 1x/dia (ver `schedule` no serverless.yml). Varre TODAS as empresas
 * à procura de documentos com `dataValidade` a aproximar-se, publica um
 * evento por documento (o serviço `notificacoes` trata do envio) e marca
 * `alertaExpiracaoEnviado` para não repetir o aviso todos os dias.
 *
 * Usa Scan porque é uma tarefa em lote, não um caminho de pedido — a tabela
 * é pequena o suficiente para isto ser aceitável nesta fase do produto.
 */
export const verificarExpiracoes: ScheduledHandler = async () => {
  const limite = new Date();
  limite.setDate(limite.getDate() + DIAS_AVISO);
  const limiteStr = limite.toISOString().slice(0, 10); // YYYY-MM-DD

  logger.info('A verificar documentos a expirar', { limite: limiteStr });

  let processados = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await db.send(
      new ScanCommand({
        TableName: DOCUMENTOS_TABLE,
        FilterExpression:
          'begins_with(SK, :docPrefix) AND NOT contains(SK, :versaoMarker) ' +
          'AND attribute_exists(dataValidade) AND attribute_not_exists(deletedAt) ' +
          'AND (attribute_not_exists(alertaExpiracaoEnviado) OR alertaExpiracaoEnviado = :falso) ' +
          'AND dataValidade <= :limite',
        ExpressionAttributeValues: {
          ':docPrefix': 'documento#',
          ':versaoMarker': '#versao#',
          ':falso': false,
          ':limite': limiteStr,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const doc of result.Items ?? []) {
      const diasRestantes = Math.ceil(
        (new Date(doc.dataValidade as string).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );

      try {
        await eventBridge.send(
          new PutEventsCommand({
            Entries: [{
              EventBusName: EVENT_BUS_NAME,
              Source: 'dru-bos.documentos',
              DetailType: 'DocumentoAExpirar',
              Detail: JSON.stringify({
                empresaId: doc.empresaId,
                documentoId: doc.id,
                nome: doc.nome,
                categoria: doc.categoria,
                dataValidade: doc.dataValidade,
                diasRestantes,
              }),
            }],
          }),
        );

        await db.send(
          new UpdateCommand({
            TableName: DOCUMENTOS_TABLE,
            Key: { PK: doc.PK, SK: doc.SK },
            UpdateExpression: 'SET alertaExpiracaoEnviado = :true',
            ExpressionAttributeValues: { ':true': true },
          }),
        );
        processados++;
      } catch (err) {
        logger.error('Erro ao alertar expiração de documento', {
          error: String(err),
          documentoId: doc.id,
        });
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  logger.info('Verificação de expirações concluída', { processados });
};
