/**
 * Subscrições e Planos — DRU Business OS
 *
 * Gere os 3 planos comerciais (Starter, Growth, Enterprise),
 * trial automático de 14 dias, upgrade/downgrade, cancelamento
 * e verificação de limites (utilizadores, módulos).
 */
import type { APIGatewayProxyHandler } from 'aws-lambda';
import { GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { z } from 'zod';
import {
  db,
  ok,
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
import type { AuthContext, PlanoSubscricao } from '@dru-bos/shared';

const EMPRESAS_TABLE = process.env.EMPRESAS_TABLE!;
const UTILIZADORES_TABLE = process.env.UTILIZADORES_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

const eventBridge = new EventBridgeClient({ region: 'af-south-1' });

// ── Catálogo de planos ───────────────────────────────────────────────────────

interface PlanoDefinicao {
  id: PlanoSubscricao;
  nome: string;
  precoMensalUSD: number;
  precoMensalAOA: number;
  maxUtilizadores: number | null; // null = ilimitado
  modulos: string[];
  recursos: string[];
  destaque?: boolean;
}

const PLANOS: Record<PlanoSubscricao, PlanoDefinicao> = {
  starter: {
    id: 'starter',
    nome: 'Starter',
    precoMensalUSD: 49,
    precoMensalAOA: 45000,
    maxUtilizadores: 1,
    modulos: ['financeiro', 'faturacao'],
    recursos: [
      'Receitas e despesas',
      'Faturação básica',
      'Dashboard simples',
      'Suporte por email',
    ],
  },
  growth: {
    id: 'growth',
    nome: 'Growth',
    precoMensalUSD: 149,
    precoMensalAOA: 137000,
    maxUtilizadores: 5,
    modulos: ['financeiro', 'faturacao', 'stock', 'clientes', 'dashboard'],
    recursos: [
      'Tudo do Starter',
      'Gestão de stock',
      'CRM clientes',
      'Dashboard avançado',
      'Relatórios completos',
      'Suporte prioritário',
    ],
    destaque: true,
  },
  enterprise: {
    id: 'enterprise',
    nome: 'Enterprise',
    precoMensalUSD: 399,
    precoMensalAOA: 367000,
    maxUtilizadores: null,
    modulos: ['financeiro', 'faturacao', 'stock', 'clientes', 'dashboard', 'api'],
    recursos: [
      'Tudo do Growth',
      'Utilizadores ilimitados',
      'API REST',
      'SLA 99.9%',
      'Suporte dedicado',
      'Onboarding personalizado',
    ],
  },
};

const TRIAL_DIAS = 14;

// ── Schemas ──────────────────────────────────────────────────────────────────

const AlterarPlanoSchema = z.object({
  plano: z.enum(['starter', 'growth', 'enterprise']),
  motivo: z.string().max(500).optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAuth(event: Parameters<APIGatewayProxyHandler>[0]): Promise<AuthContext | null> {
  const token = extractToken(event);
  if (!token) return null;
  return verifyToken(token);
}

async function obterEmpresa(empresaId: string): Promise<Record<string, unknown> | null> {
  const result = await db.send(
    new GetCommand({
      TableName: EMPRESAS_TABLE,
      Key: { PK: `empresa#${empresaId}`, SK: 'perfil#0' },
    }),
  );
  return result.Item ?? null;
}

async function contarUtilizadores(empresaId: string): Promise<number> {
  const result = await db.send(
    new QueryCommand({
      TableName: UTILIZADORES_TABLE,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'attribute_not_exists(deletedAt) AND ativo = :ativo',
      ExpressionAttributeValues: {
        ':pk': `empresa#${empresaId}`,
        ':ativo': true,
      },
      Select: 'COUNT',
    }),
  );
  return result.Count ?? 0;
}

function diasRestantesTrial(empresa: Record<string, unknown>): number | null {
  if (empresa.estadoSubscricao !== 'trial') return null;
  const inicio = (empresa.trialInicio as string) ?? (empresa.createdAt as string);
  if (!inicio) return null;
  const fim = new Date(inicio);
  fim.setDate(fim.getDate() + TRIAL_DIAS);
  const diff = Math.max(0, Math.floor((fim.getTime() - Date.now()) / 86400000));
  return diff;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const listarPlanos: APIGatewayProxyHandler = async () => {
  return ok({
    trialDias: TRIAL_DIAS,
    planos: Object.values(PLANOS),
  });
};

export const obterSubscricao: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  try {
    const empresa = await obterEmpresa(auth.empresaId);
    if (!empresa) return notFound('Empresa não encontrada');

    const plano = PLANOS[empresa.plano as PlanoSubscricao];
    const trialRestante = diasRestantesTrial(empresa);

    return ok({
      empresaId: empresa.id,
      plano,
      estadoSubscricao: empresa.estadoSubscricao,
      trialDiasRestantes: trialRestante,
      desde: empresa.subscricaoDesde ?? empresa.createdAt,
      proximaCobranca: empresa.proximaCobranca,
    });
  } catch (err) {
    logger.error('Erro ao obter subscrição', { error: String(err) });
    return internalError();
  }
};

export const alterarPlano: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin') return forbidden('Apenas administradores podem alterar o plano');

  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); } catch {
    return badRequest('JSON malformado');
  }

  const parsed = AlterarPlanoSchema.safeParse(body);
  if (!parsed.success) return badRequest('Dados inválidos', parsed.error.flatten().fieldErrors);

  const { plano: novoPlano, motivo } = parsed.data;

  try {
    const empresa = await obterEmpresa(auth.empresaId);
    if (!empresa) return notFound('Empresa não encontrada');

    const planoActual = empresa.plano as PlanoSubscricao;
    if (planoActual === novoPlano) {
      return conflict('A empresa já se encontra neste plano');
    }

    // Validar que utilizadores existentes não excedem limite do novo plano
    const definicao = PLANOS[novoPlano];
    if (definicao.maxUtilizadores !== null) {
      const total = await contarUtilizadores(auth.empresaId);
      if (total > definicao.maxUtilizadores) {
        return badRequest(
          `Plano ${definicao.nome} permite no máximo ${definicao.maxUtilizadores} utilizadores. Tem ${total} activos.`,
        );
      }
    }

    const now = new Date().toISOString();
    const proximaCobranca = new Date();
    proximaCobranca.setMonth(proximaCobranca.getMonth() + 1);

    await db.send(
      new UpdateCommand({
        TableName: EMPRESAS_TABLE,
        Key: { PK: empresa.PK as string, SK: empresa.SK as string },
        UpdateExpression:
          'SET plano = :plano, estadoSubscricao = :estado, subscricaoDesde = :desde, ' +
          'proximaCobranca = :proxima, updatedAt = :now',
        ExpressionAttributeValues: {
          ':plano': novoPlano,
          ':estado': 'activo',
          ':desde': now,
          ':proxima': proximaCobranca.toISOString().split('T')[0],
          ':now': now,
        },
      }),
    );

    await eventBridge.send(
      new PutEventsCommand({
        Entries: [{
          EventBusName: EVENT_BUS_NAME,
          Source: 'dru-bos.subscriptions',
          DetailType: 'PlanoAlterado',
          Detail: JSON.stringify({
            empresaId: auth.empresaId,
            planoAnterior: planoActual,
            planoNovo: novoPlano,
            motivo,
          }),
        }],
      }),
    );

    await registarAuditoria(auth, 'alterar-plano', 'subscricao', auth.empresaId, {
      planoAnterior: planoActual,
      planoNovo: novoPlano,
      motivo,
    });

    return ok({
      plano: PLANOS[novoPlano],
      estadoSubscricao: 'activo',
      proximaCobranca: proximaCobranca.toISOString().split('T')[0],
    });
  } catch (err) {
    logger.error('Erro ao alterar plano', { error: String(err) });
    return internalError();
  }
};

export const cancelarSubscricao: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin') return forbidden('Apenas administradores podem cancelar a subscrição');

  try {
    const empresa = await obterEmpresa(auth.empresaId);
    if (!empresa) return notFound('Empresa não encontrada');
    if (empresa.estadoSubscricao === 'cancelado') {
      return conflict('Subscrição já se encontra cancelada');
    }

    const now = new Date().toISOString();

    await db.send(
      new UpdateCommand({
        TableName: EMPRESAS_TABLE,
        Key: { PK: empresa.PK as string, SK: empresa.SK as string },
        UpdateExpression:
          'SET estadoSubscricao = :estado, canceladoEm = :now, updatedAt = :now',
        ExpressionAttributeValues: {
          ':estado': 'cancelado',
          ':now': now,
        },
      }),
    );

    await eventBridge.send(
      new PutEventsCommand({
        Entries: [{
          EventBusName: EVENT_BUS_NAME,
          Source: 'dru-bos.subscriptions',
          DetailType: 'SubscricaoCancelada',
          Detail: JSON.stringify({ empresaId: auth.empresaId }),
        }],
      }),
    );

    await registarAuditoria(auth, 'cancelar', 'subscricao', auth.empresaId);

    return ok({ estadoSubscricao: 'cancelado', canceladoEm: now });
  } catch (err) {
    logger.error('Erro ao cancelar subscrição', { error: String(err) });
    return internalError();
  }
};

export const verificarLimites: APIGatewayProxyHandler = async (event) => {
  const auth = await getAuth(event);
  if (!auth) return unauthorized();

  try {
    const empresa = await obterEmpresa(auth.empresaId);
    if (!empresa) return notFound('Empresa não encontrada');

    const plano = PLANOS[empresa.plano as PlanoSubscricao];
    const utilizadoresActivos = await contarUtilizadores(auth.empresaId);

    return ok({
      plano: plano.id,
      utilizadores: {
        actual: utilizadoresActivos,
        maximo: plano.maxUtilizadores,
        disponiveis:
          plano.maxUtilizadores === null
            ? null
            : Math.max(0, plano.maxUtilizadores - utilizadoresActivos),
        excedido:
          plano.maxUtilizadores !== null && utilizadoresActivos > plano.maxUtilizadores,
      },
      modulosDisponiveis: plano.modulos,
      estadoSubscricao: empresa.estadoSubscricao,
      trialDiasRestantes: diasRestantesTrial(empresa),
    });
  } catch (err) {
    logger.error('Erro ao verificar limites', { error: String(err) });
    return internalError();
  }
};
