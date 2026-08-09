const MESES: Record<string, string> = {
  janeiro: '01', fevereiro: '02', marco: '03', abril: '04', maio: '05', junho: '06',
  julho: '07', agosto: '08', setembro: '09', outubro: '10', novembro: '11', dezembro: '12',
};

function semAcentos(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function normalizarData(dia: string, mes: string, ano: string): string | null {
  const d = dia.padStart(2, '0');
  const m = mes.padStart(2, '0');
  let a = ano;
  if (a.length === 2) a = (Number(a) > 50 ? '19' : '20') + a; // heurística simples para anos a 2 dígitos

  const diaNum = Number(d);
  const mesNum = Number(m);
  if (mesNum < 1 || mesNum > 12 || diaNum < 1 || diaNum > 31) return null;

  const data = new Date(`${a}-${m}-${d}T00:00:00`);
  if (Number.isNaN(data.getTime())) return null;
  // Confirma que a data "voltou" igual — apanha coisas como 31/02 que o JS auto-corrige
  if (data.getUTCDate() !== diaNum || data.getUTCMonth() + 1 !== mesNum) return null;

  return `${a}-${m}-${d}`;
}

export interface DataDetectada {
  data: string; // ISO YYYY-MM-DD
  contexto: string; // excerto do texto onde foi encontrada, para o utilizador confirmar com confiança
}

/**
 * Procura uma data de validade no texto extraído de um documento (OCR/parse).
 * Determinístico, sem IA — procura o padrão "validade"/"válido até" seguido
 * de uma data em formato numérico ou por extenso. Só devolve UM resultado
 * (o primeiro encontrado); a confirmação fica sempre a cargo do utilizador.
 */
export function detectarDataValidade(texto: string): DataDetectada | null {
  if (!texto) return null;

  // Padrão 1: "válido até 25/08/2026", "validade: 25-08-2026", "data de validade 25.08.2026"
  const regexNumerica =
    /(v[aá]lid[ao]s?\s+at[ée]|data\s+de\s+validade|validade)[:\s]{0,10}(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/i;
  let m = texto.match(regexNumerica);
  if (m) {
    const data = normalizarData(m[2], m[3], m[4]);
    if (data) return { data, contexto: m[0].trim() };
  }

  // Padrão 2: "válido até 25 de agosto de 2026"
  const regexExtenso =
    /(v[aá]lid[ao]s?\s+at[ée]|data\s+de\s+validade|validade)[:\s]{0,10}(\d{1,2})\s+de\s+([a-zçã]+)\s+de\s+(\d{4})/i;
  m = texto.match(regexExtenso);
  if (m) {
    const mesNum = MESES[semAcentos(m[3])];
    if (mesNum) {
      const data = normalizarData(m[2], mesNum, m[4]);
      if (data) return { data, contexto: m[0].trim() };
    }
  }

  return null;
}
