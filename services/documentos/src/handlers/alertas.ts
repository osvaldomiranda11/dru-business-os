import type { ScheduledHandler } from 'aws-lambda';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { db, logger } from '@dru-bos/shared';
import { calcularNivel, diasRestantesAte, ehEscalada, type NivelAlerta } from '../lib/regrasExpiracao';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const eventBridge = new EventBridgeClient({ region: 'af-south-1' });

/** Janela de scan — além dos 60 dias não há nível de alerta possível, não vale a pena avaliar */
const JANELA_SCAN_DIAS = 60;

/**
 * Corre 1x/dia. Varre TODAS as empresas à procura de documentos com
 * `dataValidade` dentro da janela de alerta, calcula o nível actual pelas
 * regras determinísticas (motor de regras, sem IA) e publica um evento só
 * quando o nível é uma ESCALADA face ao último já notificado — assim o
 * mesmo documento pode alertar em "aviso", depois "crítico", depois
 * "expirado", sem repetir o mesmo aviso todos os dias.
 */
export const verificarExpiracoes: ScheduledHandler = async () => {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const limite = new Date(hoje);
  limite.setDate(limite.getDate() + JANELA_SCAN_DIAS);
  const limiteStr = limite.toISOString().slice(0, 10);

  logger.info('A verificar documentos a expirar (motor de regras)', { limite: limiteStr });

  let avaliados = 0;
  let alertados = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await db.send(
      new ScanCommand({
        TableName: DOCUMENTOS_TABLE,
        FilterExpression:
          'begins_with(SK, :docPrefix) AND NOT contains(SK, :versaoMarker) ' +
          'AND attribute_exists(dataValidade) AND attribute_not_exists(deletedAt) ' +
          'AND dataValidade <= :limite',
        ExpressionAttributeValues: {
          ':docPrefix': 'documento#',
          ':versaoMarker': '#versao#',
          ':limite': limiteStr,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const doc of result.Items ?? []) {
      avaliados++;
      const dataValidade = doc.dataValidade as string;
      const diasRestantes = diasRestantesAte(dataValidade, hoje);
      const nivel = calcularNivel(diasRestantes);
      if (!nivel) continue; // fora da janela de alerta (não devia acontecer dado o filtro, mas por segurança)

      const ultimoNivel = doc.ultimoNivelAlertaEnviado as NivelAlerta | undefined;
      if (!ehEscalada(nivel, ultimoNivel)) continue; // já foi alertado neste nível ou pior

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
                dataValidade,
                diasRestantes,
                nivel,
              }),
            }],
          }),
        );

        await db.send(
          new UpdateCommand({
            TableName: DOCUMENTOS_TABLE,
            Key: { PK: doc.PK, SK: doc.SK },
            UpdateExpression: 'SET ultimoNivelAlertaEnviado = :nivel',
            ExpressionAttributeValues: { ':nivel': nivel },
          }),
        );
        alertados++;
      } catch (err) {
        logger.error('Erro ao alertar expiração de documento', {
          error: String(err),
          documentoId: doc.id,
        });
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  logger.info('Verificação de expirações concluída', { avaliados, alertados });
};
