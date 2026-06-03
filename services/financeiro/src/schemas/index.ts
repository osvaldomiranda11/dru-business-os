import { z } from 'zod';

const datePTSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD');

export const ReceitaSchema = z.object({
  descricao: z.string().min(2, 'Descrição deve ter pelo menos 2 caracteres').max(255),
  valor: z
    .number({ invalid_type_error: 'Valor deve ser um número' })
    .positive('Valor deve ser positivo')
    .multipleOf(0.01, 'Valor deve ter no máximo 2 casas decimais'),
  moeda: z.enum(['AOA', 'USD']).default('AOA'),
  categoria: z.enum(['vendas', 'servicos', 'comissoes', 'juros', 'outros']),
  data: datePTSchema,
  observacoes: z.string().max(1000).optional(),
});

export const ReceitaUpdateSchema = ReceitaSchema.partial();

export const DespesaSchema = z.object({
  descricao: z.string().min(2, 'Descrição deve ter pelo menos 2 caracteres').max(255),
  valor: z
    .number({ invalid_type_error: 'Valor deve ser um número' })
    .positive('Valor deve ser positivo')
    .multipleOf(0.01, 'Valor deve ter no máximo 2 casas decimais'),
  moeda: z.enum(['AOA', 'USD']).default('AOA'),
  categoria: z.enum([
    'fornecedores',
    'salarios',
    'renda',
    'utilidades',
    'marketing',
    'impostos',
    'outros',
  ]),
  data: datePTSchema,
  fornecedor: z.string().max(150).optional(),
  observacoes: z.string().max(1000).optional(),
});

export const DespesaUpdateSchema = DespesaSchema.partial();

export const FiltrosPeriodoSchema = z.object({
  dataInicio: datePTSchema.optional(),
  dataFim: datePTSchema.optional(),
  categoria: z.string().optional(),
  limite: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const FiltrosRelatorioSchema = z.object({
  ano: z.coerce.number().int().min(2024).max(2100),
  mes: z.coerce.number().int().min(1).max(12).optional(),
  moeda: z.enum(['AOA', 'USD']).default('AOA'),
});

export type ReceitaInput = z.infer<typeof ReceitaSchema>;
export type ReceitaUpdateInput = z.infer<typeof ReceitaUpdateSchema>;
export type DespesaInput = z.infer<typeof DespesaSchema>;
export type DespesaUpdateInput = z.infer<typeof DespesaUpdateSchema>;
export type FiltrosPeriodo = z.infer<typeof FiltrosPeriodoSchema>;
export type FiltrosRelatorio = z.infer<typeof FiltrosRelatorioSchema>;
