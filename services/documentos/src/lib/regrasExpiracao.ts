export type NivelAlerta = 'aviso' | 'atencao' | 'critico' | 'expirado';

/** Ordem de severidade — usada para saber se um novo nível é uma escalada */
const SEVERIDADE: Record<NivelAlerta, number> = {
  aviso: 1,
  atencao: 2,
  critico: 3,
  expirado: 4,
};

/**
 * SE validade < hoje            → expirado
 * SE validade <= hoje + 7 dias  → crítico
 * SE validade <= hoje + 30 dias → atenção
 * SE validade <= hoje + 60 dias → aviso
 * senão                          → normal (sem alerta)
 */
export function calcularNivel(diasRestantes: number): NivelAlerta | null {
  if (diasRestantes < 0) return 'expirado';
  if (diasRestantes <= 7) return 'critico';
  if (diasRestantes <= 30) return 'atencao';
  if (diasRestantes <= 60) return 'aviso';
  return null;
}

/** true se o novo nível é mais grave que o último já notificado (ou é o primeiro alerta) */
export function ehEscalada(nivelAtual: NivelAlerta, ultimoNivelEnviado?: NivelAlerta): boolean {
  if (!ultimoNivelEnviado) return true;
  return SEVERIDADE[nivelAtual] > SEVERIDADE[ultimoNivelEnviado];
}

export function diasRestantesAte(dataValidade: string, hoje: Date = new Date()): number {
  const h = new Date(hoje);
  h.setHours(0, 0, 0, 0);
  const data = new Date(dataValidade);
  return Math.round((data.getTime() - h.getTime()) / (1000 * 60 * 60 * 24));
}
