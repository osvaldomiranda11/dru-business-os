# DRU Business OS

**Plataforma SaaS de gestão empresarial para PMEs angolanas**

DRU Tecnologia & Transformação Digital · Luanda, Angola · 2026

---

## Visão Geral

O DRU Business OS é um sistema integrado de Financeiro, Faturação, Stock e Dashboard em tempo real, desenhado especificamente para o contexto angolano — moeda local (AOA), impostos, conectividade instável e realidade cultural.

**Pilares arquitecturais:**
- **Offline-first** — funciona sem internet, sincroniza quando há ligação
- **Multi-tenant seguro** — dados completamente isolados por empresa
- **Custo operacional baixo** — AWS Serverless pay-per-use em af-south-1

---

## Stack Tecnológico

| Camada | Tecnologia |
|--------|-----------|
| Backend | AWS Lambda (Node.js 20 + TypeScript) |
| API | AWS API Gateway |
| Base de dados | AWS DynamoDB (af-south-1) |
| Autenticação | AWS Cognito |
| Ficheiros | AWS S3 |
| Sync offline | AWS SQS |
| Real-time | AWS AppSync |
| Deploy | Serverless Framework 3 |
| CI/CD | GitHub Actions |
| Frontend | Flutter (Web + Desktop) — repositório separado |

---

## Estrutura do Projecto

```
dru-business-os/
├── infra/                      # Infraestrutura partilhada (CloudFormation)
│   ├── serverless.yml
│   └── resources/
│       ├── cognito.yml         # User Pool e Client
│       ├── dynamodb.yml        # 6 tabelas com GSIs
│       ├── s3.yml              # Bucket de ficheiros
│       ├── sqs.yml             # Fila de sincronização offline
│       └── eventbridge.yml     # Event bus de negócio
├── packages/
│   └── shared/                 # Código partilhado entre serviços
│       └── src/
│           ├── types/          # Tipos TypeScript globais
│           ├── lib/            # DynamoDB client, logger, auditoria
│           └── middleware/     # Auth JWT middleware
├── services/
│   ├── auth/                   # Registo, login, refresh, perfil
│   ├── financeiro/             # Receitas, despesas, relatórios
│   ├── faturacao/              # Fase 2 — Clientes e faturas
│   ├── stock/                  # Fase 2 — Produtos e movimentos
│   └── subscriptions/          # Fase 2 — Planos e Multicaixa Express
└── .github/workflows/
    ├── ci.yml                  # Type check + lint + testes (PRs)
    └── deploy.yml              # Deploy automático (push main)
```

---

## Pré-requisitos

- Node.js 20+
- AWS CLI configurado com acesso à conta DRU
- Serverless Framework 3: `npm install -g serverless`

---

## Setup Inicial

```bash
# 1. Clonar o repositório
git clone https://github.com/osvaldomiranda11/dru-business-os.git
cd dru-business-os

# 2. Instalar dependências
npm install

# 3. Deploy da infraestrutura (primeira vez)
npm run deploy:infra:dev

# 4. Deploy dos serviços
npm run deploy:auth:dev
npm run deploy:financeiro:dev
```

---

## Endpoints da API

### Autenticação (`/auth`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/auth/register` | Registo de nova empresa + admin |
| POST | `/auth/login` | Login com email e password |
| POST | `/auth/refresh` | Renovação de tokens |
| GET | `/auth/me` | Perfil do utilizador autenticado |

### Financeiro (`/financeiro`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/financeiro/receitas` | Registar receita |
| GET | `/financeiro/receitas` | Listar receitas (filtros por data/categoria) |
| PUT | `/financeiro/receitas/{id}` | Actualizar receita |
| DELETE | `/financeiro/receitas/{id}` | Eliminar receita (soft delete) |
| POST | `/financeiro/despesas` | Registar despesa |
| GET | `/financeiro/despesas` | Listar despesas |
| PUT | `/financeiro/despesas/{id}` | Actualizar despesa |
| DELETE | `/financeiro/despesas/{id}` | Eliminar despesa (soft delete) |
| GET | `/financeiro/relatorios/fluxo-caixa` | Fluxo de caixa por período |
| GET | `/financeiro/relatorios/lucro-prejuizo` | Lucro e prejuízo por período |

---

## Roles e Permissões

| Role | Receitas | Despesas | Relatórios | Utilizadores | Config |
|------|----------|----------|------------|--------------|--------|
| `admin` | ✅ CRUD | ✅ CRUD | ✅ | ✅ | ✅ |
| `gestor` | ✅ CRUD | ✅ CRUD | ✅ | — | — |
| `vendedor` | ✅ Criar/ver | ✅ Criar/ver | ✅ | — | — |
| `viewer` | 👁 Ver | 👁 Ver | ✅ | — | — |

---

## Planos de Subscrição

| Plano | Preço/mês | Utilizadores | Módulos |
|-------|-----------|--------------|---------|
| Starter | $49 | 1 | Financeiro + Faturação |
| Growth | $149 | Até 5 | Todos |
| Enterprise | $399 | Ilimitado | Todos + API + SLA |

---

## Deploy para Produção

O deploy de produção é automático via GitHub Actions ao fazer push para `main`.

**Segredos necessários no repositório GitHub:**
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

```bash
# Deploy manual para produção
npm run deploy:all
```

---

## Segurança e Conformidade

- **Autenticação:** Cognito com MFA opcional, JWT com expiração de 1h
- **Autorização:** Validação de roles em cada Lambda (nunca apenas no frontend)
- **Dados em repouso:** DynamoDB encryption at rest (AES-256)
- **Dados em trânsito:** HTTPS obrigatório (API Gateway)
- **Isolamento:** Partition key por empresa — impossível acesso cruzado
- **Auditoria:** Log de todas as operações na tabela `dru-bos-auditoria`
- **Secrets:** AWS Secrets Manager para credenciais sensíveis

---

## Propriedade Intelectual

Software proprietário desenvolvido pela DRU Tecnologia & Transformação Digital.
Todos os direitos reservados. Código registado em nome do fundador.

**Osvaldo Miranda** — Fundador & Director Técnico  
Luanda, Angola · 2026
