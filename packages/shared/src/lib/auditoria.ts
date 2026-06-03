import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { db, Tables } from './dynamodb';
import type { AuthContext, RegistoAuditoria } from '../types';

export async function registarAuditoria(
  auth: AuthContext,
  acao: string,
  recurso: string,
  recursoId: string,
  detalhes?: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const id = uuidv4();
  const dataStr = now.split('T')[0];

  const registo: RegistoAuditoria = {
    PK: `empresa#${auth.empresaId}`,
    SK: `auditoria#${now}#${id}`,
    GSI1PK: `tipo#auditoria`,
    GSI1SK: `data#${dataStr}`,
    id,
    empresaId: auth.empresaId,
    utilizadorId: auth.userId,
    acao,
    recurso,
    recursoId,
    detalhes,
    createdAt: now,
  };

  await db.send(
    new PutCommand({ TableName: Tables.auditoria, Item: registo }),
  );
}
