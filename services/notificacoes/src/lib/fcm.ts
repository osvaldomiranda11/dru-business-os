/**
 * Cliente FCM lazy-initialized — Firebase Admin SDK carrega a Service Account
 * do AWS Secrets Manager na primeira chamada (~300ms cold start, depois cached).
 *
 * O secret é o JSON completo gerado em Firebase Console → Service accounts.
 * Nunca aparece em logs nem variáveis de ambiente.
 */
import * as admin from 'firebase-admin';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const SECRET_NAME = process.env.FIREBASE_SECRET_NAME!;
const sm = new SecretsManagerClient({ region: 'af-south-1' });

let app: admin.app.App | null = null;

async function inicializar(): Promise<admin.app.App> {
  if (app) return app;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  if (!r.SecretString) throw new Error('Service Account não encontrada em Secrets Manager');
  const serviceAccount = JSON.parse(r.SecretString) as admin.ServiceAccount;
  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return app;
}

export interface PushPayload {
  titulo: string;
  corpo: string;
  /** Dados opcionais para deep-linking dentro do app */
  data?: Record<string, string>;
}

/**
 * Envia o mesmo payload para vários tokens em paralelo (via sendEachForMulticast).
 * Devolve quantos foram enviados com sucesso e tokens inválidos para limpeza.
 */
export async function enviarPush(
  tokens: string[],
  payload: PushPayload,
): Promise<{ sucesso: number; falhas: number; tokensInvalidos: string[] }> {
  if (tokens.length === 0) {
    return { sucesso: 0, falhas: 0, tokensInvalidos: [] };
  }
  const a = await inicializar();
  // Limite FCM: 500 tokens por chamada. Para PMEs angolanas isto é mais
  // que suficiente, mas adicionamos batching defensivo.
  const lotes: string[][] = [];
  for (let i = 0; i < tokens.length; i += 500) {
    lotes.push(tokens.slice(i, i + 500));
  }
  let sucesso = 0;
  let falhas = 0;
  const tokensInvalidos: string[] = [];
  for (const lote of lotes) {
    const r = await a.messaging().sendEachForMulticast({
      tokens: lote,
      notification: { title: payload.titulo, body: payload.corpo },
      data: payload.data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'dru_admin',
          color: '#0A2540',
        },
      },
    });
    sucesso += r.successCount;
    falhas += r.failureCount;
    r.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code;
        if (code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token') {
          tokensInvalidos.push(lote[idx]);
        }
      }
    });
  }
  return { sucesso, falhas, tokensInvalidos };
}
