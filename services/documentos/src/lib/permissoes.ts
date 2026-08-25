import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { db } from '@dru-bos/shared';
import type { AuthContext } from '@dru-bos/shared';

const DOCUMENTOS_TABLE = process.env.DOCUMENTOS_TABLE!;

/**
 * Uma pasta sem nenhuma concessão explícita está aberta a toda a empresa
 * — comportamento por omissão, compatível com pastas já existentes antes
 * desta funcionalidade. Assim que se concede acesso a pelo menos uma
 * pessoa, a pasta passa a ser restrita só a essas pessoas (mais admins,
 * que têm sempre acesso a tudo).
 */
export async function utilizadorTemAcessoPasta(auth: AuthContext, pastaId?: string): Promise<boolean> {
  if (!pastaId) return true; // raiz não é restringível
  if (auth.role === 'admin') return true;

  const result = await db.send(
    new QueryCommand({
      TableName: DOCUMENTOS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `empresa#${auth.empresaId}`,
        ':prefix': `pasta#${pastaId}#acesso#`,
      },
    }),
  );
  const concessoes = result.Items ?? [];
  if (concessoes.length === 0) return true; // pasta aberta, sem restrições
  return concessoes.some((g) => g.utilizadorId === auth.userId);
}

/**
 * Filtra uma lista de documentos, removendo os que estão em pastas
 * restritas a que o utilizador não tem acesso. Usa cache por pastaId
 * dentro do próprio pedido para não repetir a mesma verificação.
 */
export async function filtrarPorAcesso<T extends { pastaId?: string }>(
  auth: AuthContext,
  items: T[],
): Promise<T[]> {
  const cache = new Map<string, boolean>();
  const resultado: T[] = [];

  for (const item of items) {
    if (!item.pastaId) {
      resultado.push(item);
      continue;
    }
    let pode = cache.get(item.pastaId);
    if (pode === undefined) {
      pode = await utilizadorTemAcessoPasta(auth, item.pastaId);
      cache.set(item.pastaId, pode);
    }
    if (pode) resultado.push(item);
  }

  return resultado;
}
