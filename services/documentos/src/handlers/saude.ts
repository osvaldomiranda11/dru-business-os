import type { APIGatewayProxyHandler } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { db, ok, unauthorized, internalError, verifyToken, extractToken, logger } from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;

/** Mesmo limiar usado no alerta de expiração — "a vencer" = 60 dias ou menos */
const DIAS_A_VENCER = 60;

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

interface DocumentoResumo {
  id: string;
  nome: string;
  categoria: string;
  dataValidade: string;
  diasRestantes: number;
}

export const resumo: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  try {
    let items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await db.send(
        new QueryCommand({
          TableName: DOCUMENTOS_TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          FilterExpression: 'attribute_not_exists(deletedAt)',
          ExpressionAttributeValues: {
            ':pk': `empresa#${auth.empresaId}`,
            ':prefix': 'documento#',
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items = items.concat(
        (result.Items ?? []).filter((i) => !String(i.SK).includes('#versao#')),
      );
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);

    let regulares = 0;
    const aVencer: DocumentoResumo[] = [];
    const expirados: DocumentoResumo[] = [];

    for (const doc of items) {
      const dataValidade = doc.dataValidade as string | undefined;
      if (!dataValidade) {
        regulares++;
        continue;
      }

      const data = new Date(dataValidade);
      const diasRestantes = Math.round((data.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));

      const resumoItem: DocumentoResumo = {
        id: doc.id as string,
        nome: doc.nome as string,
        categoria: doc.categoria as string,
        dataValidade,
        diasRestantes,
      };

      if (diasRestantes < 0) {
        expirados.push(resumoItem);
      } else if (diasRestantes <= DIAS_A_VENCER) {
        aVencer.push(resumoItem);
      } else {
        regulares++;
      }
    }

    // Mais urgente primeiro: expirados há mais tempo, e a-vencer mais próximos
    expirados.sort((a, b) => a.diasRestantes - b.diasRestantes);
    aVencer.sort((a, b) => a.diasRestantes - b.diasRestantes);

    return ok({
      total: items.length,
      regulares,
      aVencer: aVencer.length,
      expirados: expirados.length,
      proximosAVencer: aVencer.slice(0, 5),
      expiradosRecentes: expirados.slice(0, 5),
    });
  } catch (err) {
    logger.error('Erro ao calcular saúde documental', { error: String(err) });
    return internalError();
  }
};
