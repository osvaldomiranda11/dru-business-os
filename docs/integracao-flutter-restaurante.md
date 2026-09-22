# Guia Flutter - DRU Business OS Restaurante

Este documento define o contrato de integração do Flutter com o backend do DRU Business OS para o piloto de bar e restaurante.

## Ambientes e autenticação

As APIs são independentes por serviço. O Flutter deve receber as URLs por configuração de ambiente, nunca hardcoded no código de ecrã.

```text
AUTH_API_BASE=https://<auth-api-id>.execute-api.af-south-1.amazonaws.com/prod
RESTAURANTE_API_BASE=https://<restaurante-api-id>.execute-api.af-south-1.amazonaws.com/prod
DOCUMENTOS_API_BASE=https://<documentos-api-id>.execute-api.af-south-1.amazonaws.com/prod
```

Login:

```http
POST {AUTH_API_BASE}/auth/login
Content-Type: application/json

{
  "email": "utilizador@empresa.ao",
  "password": "..."
}
```

A resposta contém `data.idToken`, `data.accessToken`, `data.refreshToken` e `data.expiresIn`.
Para as rotas protegidas atuais, enviar o `idToken`:

```http
Authorization: Bearer <idToken>
```

O token deve ficar apenas em armazenamento seguro do dispositivo. Nunca gravar password ou token em logs.

## Envelope de resposta

Sucesso:

```json
{
  "success": true,
  "data": {}
}
```

Erro:

```json
{
  "success": false,
  "error": "Mensagem",
  "details": {}
}
```

Tratar pelo menos `400`, `401`, `403`, `404`, `409` e `500`. Em `401`, renovar o token uma vez e repetir a chamada; se falhar, terminar sessão.

## Fluxo operacional

### 1. Caixa

Abrir:

```http
POST /restaurante/caixas
```

```json
{
  "fundoInicial": 50000,
  "observacoes": "Turno da tarde"
}
```

Listar:

```http
GET /restaurante/caixas
```

Movimento:

```http
POST /restaurante/caixas/{caixaId}/movimentos
```

```json
{
  "tipo": "sangria",
  "valor": 10000,
  "metodo": "numerario",
  "motivo": "Depósito bancário"
}
```

Tipos: `entrada`, `saida`, `sangria`, `reforco`.

Fechar:

```http
POST /restaurante/caixas/{caixaId}/fecho
```

```json
{
  "numerarioContado": 40000,
  "observacoes": "Fecho conferido pelo gestor"
}
```

O fecho devolve `esperado`, `contado` e `diferenca`.

### 2. Mesas e pedidos

Criar mesa:

```http
POST /restaurante/mesas
```

```json
{
  "nome": "Mesa 04",
  "zona": "Esplanada",
  "lugares": 4
}
```

Listar mesas:

```http
GET /restaurante/mesas
```

Abrir pedido:

```http
POST /restaurante/pedidos
```

```json
{
  "mesaId": "uuid-da-mesa",
  "tipo": "mesa",
  "observacoes": "Cliente prefere serviço rápido"
}
```

Tipos de pedido: `mesa`, `balcao`, `takeaway`.

Adicionar linha:

```http
POST /restaurante/pedidos/{pedidoId}/linhas
```

```json
{
  "produtoId": "uuid-do-produto",
  "nome": "Cerveja 33cl",
  "quantidade": 2,
  "precoUnitario": 800,
  "observacoes": "Bem fresca"
}
```

Alterar estado:

```http
POST /restaurante/pedidos/{pedidoId}/estado
```

```json
{
  "estado": "em_preparacao"
}
```

Estados: `aberto`, `em_preparacao`, `pronto`, `entregue`, `fechado`, `cancelado`.

Fluxo normal:

```text
aberto -> em_preparacao -> pronto -> entregue -> fechado
```

### 3. Cozinha

```http
GET /restaurante/cozinha/fila
```

A resposta contém pedidos nos estados `aberto`, `em_preparacao` e `pronto`, ordenados pelo momento de abertura. A cozinha deve atualizar o estado do pedido, não criar uma entidade paralela de KDS.

### 4. Stock e fatura

Depois de o pedido estar `entregue`:

```http
POST /restaurante/pedidos/{pedidoId}/fecho
```

Esta operação baixa o stock atomicamente e marca `stockAplicado: true`. Em caso de stock insuficiente, tratar `409` e manter o pedido visível para intervenção do gestor.

Depois do fecho com sucesso:

```http
POST /restaurante/pedidos/{pedidoId}/faturar
```

```json
{
  "clienteNome": "Consumidor final",
  "moeda": "AOA",
  "ivaTaxa": 14
}
```

A operação devolve `faturaId`, `numero`, `subtotal`, `totalIva` e `total`. Repetir o pedido de faturação devolve a fatura já associada, sem duplicar.

### 5. Relatórios

```http
GET /restaurante/relatorios/vendas?inicio=2026-09-01&fim=2026-09-22
```

A resposta contém:

- `resumo.totalVendas`
- `resumo.numeroPedidos`
- `resumo.ticketMedio`
- `porProduto`

## Gestão documental

Os documentos usam a API Documentos, não endpoints duplicados no Restaurante.

Ligar documento:

```http
POST {DOCUMENTOS_API_BASE}/documentos/{documentoId}/ligar
```

```json
{
  "tipoEntidade": "fornecedor",
  "entidadeId": "fornecedor-uuid",
  "entidadeNome": "Fornecedor de bebidas"
}
```

Tipos recomendados:

| Tipo | Uso |
| --- | --- |
| `fornecedor` | Contratos e identificação |
| `licenca` | Alvarás e certificados |
| `produto` | Fichas técnicas e alergénios |
| `compra` | Faturas de fornecedores |
| `pedido` | Comprovativos da venda |
| `mesa` | Reservas e notas operacionais |

Consultar documentos ligados:

```http
GET {DOCUMENTOS_API_BASE}/documentos/entidade/{tipoEntidade}/{entidadeId}
```

Para documentos com validade, mostrar `dataValidade`, `ocrStatus` e eventuais alertas. A sugestão de validade detetada por OCR exige confirmação do utilizador.

## Regras de implementação Flutter

- Separar `ApiClient`, modelos, repositórios e estado de ecrã.
- Não colocar regras de dinheiro, stock ou permissões no Flutter.
- Desativar botões durante pedidos em curso para evitar submissões acidentais.
- Tratar `409` como conflito operacional visível, não como erro genérico.
- Preservar o `pedidoId`, `caixaId` e `faturaId` nas rotas e no estado local.
- Mostrar claramente o estado de sincronização e erros de rede.
- Preparar retry apenas para leituras e operações idempotentes.
- Não repetir automaticamente abertura de caixa, criação de pedido ou movimentos sem uma chave de operação controlada.

## Critérios de aceite do piloto

- Operador abre caixa e vê o caixa activo.
- Operador cria mesa e pedido.
- Pedido aparece na fila da cozinha.
- Cozinha altera o estado até `entregue`.
- Fecho baixa stock sem permitir stock negativo.
- Fatura é emitida uma única vez.
- Gestor fecha caixa e vê a diferença.
- Gestor encontra licença, fornecedor e ficha técnica ligados às entidades certas.
