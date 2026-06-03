import { z } from 'zod';

export const RegisterSchema = z.object({
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres').max(100),
  email: z.string().email('Email inválido'),
  password: z
    .string()
    .min(8, 'Password deve ter pelo menos 8 caracteres')
    .regex(/[A-Z]/, 'Password deve conter pelo menos uma maiúscula')
    .regex(/[a-z]/, 'Password deve conter pelo menos uma minúscula')
    .regex(/[0-9]/, 'Password deve conter pelo menos um número'),
  nomeEmpresa: z.string().min(2, 'Nome da empresa deve ter pelo menos 2 caracteres').max(150),
  nifEmpresa: z
    .string()
    .regex(/^\d{9,14}$/, 'NIF inválido — deve conter entre 9 e 14 dígitos'),
  telefone: z.string().min(9).max(20).optional(),
  moedaPadrao: z.enum(['AOA', 'USD']).default('AOA'),
});

export const LoginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'Password obrigatória'),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token obrigatório'),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
