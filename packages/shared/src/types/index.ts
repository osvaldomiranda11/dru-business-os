export type Role = 'admin' | 'gestor' | 'vendedor' | 'viewer';

export type Moeda = 'AOA' | 'USD';

export type PlanoSubscricao = 'starter' | 'growth' | 'enterprise';

export type EstadoSubscricao = 'activo' | 'suspenso' | 'cancelado' | 'trial';

export interface Empresa {
  PK: string;
  SK: string;
  id: string;
  nome: string;
  nif: string;
  email: string;
  telefone?: string;
  endereco?: string;
  plano: PlanoSubscricao;
  estadoSubscricao: EstadoSubscricao;
  moedaPadrao: Moeda;
  logoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Utilizador {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  id: string;
  empresaId: string;
  cognitoSub: string;
  email: string;
  nome: string;
  role: Role;
  ativo: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ReceitaFinanceira {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  id: string;
  empresaId: string;
  descricao: string;
  valor: number;
  moeda: Moeda;
  categoria: CategoriaReceita;
  data: string;
  observacoes?: string;
  criadoPor: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface DespesaFinanceira {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  id: string;
  empresaId: string;
  descricao: string;
  valor: number;
  moeda: Moeda;
  categoria: CategoriaDespesa;
  data: string;
  fornecedor?: string;
  observacoes?: string;
  criadoPor: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export type CategoriaReceita =
  | 'vendas'
  | 'servicos'
  | 'comissoes'
  | 'juros'
  | 'outros';

export type CategoriaDespesa =
  | 'fornecedores'
  | 'salarios'
  | 'renda'
  | 'utilidades'
  | 'marketing'
  | 'impostos'
  | 'outros';

export type EstadoFatura = 'pendente' | 'parcial' | 'paga' | 'vencida' | 'anulada';

export interface LinhaFatura {
  descricao: string;
  quantidade: number;
  precoUnitario: number;
  ivaTaxa: number;
  subtotal: number;
  ivaValor: number;
  total: number;
}

export interface Fatura {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  id: string;
  empresaId: string;
  numero: string;
  ano: number;
  sequencial: number;
  clienteId?: string;
  clienteNome: string;
  clienteNif?: string;
  moeda: Moeda;
  estado: EstadoFatura;
  linhas: LinhaFatura[];
  subtotal: number;
  totalIva: number;
  total: number;
  totalPago: number;
  dataEmissao: string;
  dataVencimento?: string;
  observacoes?: string;
  criadoPor: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface PagamentoFatura {
  PK: string;
  SK: string;
  id: string;
  empresaId: string;
  faturaId: string;
  faturaNumero: string;
  valor: number;
  moeda: Moeda;
  metodo: string;
  referencia?: string;
  data: string;
  registadoPor: string;
  createdAt: string;
}

export interface RegistoAuditoria {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  id: string;
  empresaId: string;
  utilizadorId: string;
  acao: string;
  recurso: string;
  recursoId: string;
  detalhes?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
}

export interface JwtClaims {
  sub: string;
  email: string;
  name: string;
  'custom:empresa_id': string;
  'custom:role': Role;
  iat: number;
  exp: number;
}

export interface AuthContext {
  userId: string;
  empresaId: string;
  email: string;
  nome: string;
  role: Role;
}
