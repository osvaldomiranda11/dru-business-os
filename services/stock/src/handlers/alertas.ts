import type { EventBridgeHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { db, logger } from '@dru-bos/shared';

const STOCK_TABLE = process.env.STOCK_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

const eventBridge = new EventBridgeClient({ region: 'af-south-1' });

// Triggered via EventBridge após cada movimento de stock
export const verificarStockMinimo: EventBridgeHandler<'MovimentoRegistado', { empresaId: string; produtoId: string }, void> = async (event) => {
  const { empresaId, produtoId } = event.detail;

  try {
    const result = await db.send(
      new QueryCommand({
        TableName: STOCK_TABLE,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        FilterExpression: 'stockActual <= stockMinimo',
        ExpressionAttributeValues: {
          ':pk': `empresa#${empresaId}`,
          ':sk': `produto#${produtoId}`,
        },
      }),
    );

    if (result.Items?.length) {
      const produto = result.Items[0];
      logger.warn('Stock mínimo atingido', {
        empresaId,
        produtoId,
        nome: produto.nome,
        stockActual: produto.stockActual,
        stockMinimo: produto.stockMinimo,
      });

      // Publicar alerta para o dashboard via EventBridge
      await eventBridge.send(
        new PutEventsCommand({
          Entries: [{
            EventBusName: EVENT_BUS_NAME,
            Source: 'dru-bos.stock',
            DetailType: 'AlertaStockMinimo',
            Detail: JSON.stringify({
              empresaId,
              produtoId,
              nome: produto.nome,
              stockActual: produto.stockActual,
              stockMinimo: produto.stockMinimo,
            }),
          }],
        }),
      );
    }
  } catch (err) {
    logger.error('Erro ao verificar stock mínimo', { error: String(err), produtoId });
  }
};
