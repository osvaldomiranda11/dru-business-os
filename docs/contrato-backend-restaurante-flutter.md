# Contrato Backend — Restaurante / Flutter

## Contexto

Este documento responde às perguntas da equipa Flutter sobre o contrato de integração do serviço Restaurante e Documentos.

## Resumo executivo

O backend do restaurante já está funcional para o piloto de bar & restaurante. O Flutter pode avançar com os módulos de caixa, mesas, pedidos, cozinha, fecho de pedido, faturação, relatórios e documentos ligados.

Os pontos que não existem no backend atual devem ser tratados como requisitos de implementação a confirmar ou como backlog de evolução.

## 1) Existe GET /restaurante/pedidos?

Não existe no backend atual.

O serviço Restaurante expõe os endpoints de:
- abrir pedido
- adicionar linha
- alterar estado
- fechar pedido
- faturar pedido
- fila da cozinha
- relatórios de vendas

A listagem global de pedidos não está implementada hoje.

## 2) Estrutura de resposta das listas

### GET /restaurante/caixas

Envelope:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "empresaId": "empresa-uuid",
        "tipo": "caixa",
        "estado": "aberto",
        "abertoPor": "user-uuid",
        "fundoInicial": 50000,
        "totalEntradas": 50000,
        "totalSaidas": 0,
        "totalVendas": 0,
        "observacoes": "Turno da tarde",
        "createdAt": "2026-09-22T12:00:00.000Z",
        "updatedAt": "2026-09-22T12:00:00.000Z",
        "fechadoPor": null,
        "fechadoEm": null,
        "numerarioContado": null,
        "valorEsperado": null,
        "diferenca": null
      }
    ],
    "total": 1
  }
}
```

### GET /restaurante/mesas

Envelope:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "empresaId": "empresa-uuid",
        "tipo": "mesa",
        "nome": "Mesa 04",
        "zona": "Esplanada",
        "lugares": 4,
        "estado": "livre",
        "pedidoId": null,
        "createdAt": "2026-09-22T12:00:00.000Z",
        "updatedAt": "2026-09-22T12:00:00.000Z"
      }
    ],
    "total": 1
  }
}
```

### GET /restaurante/cozinha/fila

Envelope:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "pedidoId": "uuid",
        "mesaId": "uuid-ou-null",
        "tipo": "mesa",
        "estado": "em_preparacao",
        "linhas": [
          {
            "produtoId": "uuid",
            "nome": "Cerveja 33cl",
            "quantidade": 2,
            "precoUnitario": 800,
            "total": 1600
          }
        ],
        "observacoes": "Cliente prefere serviço rápido",
        "abertoEm": "2026-09-22T12:00:00.000Z"
      }
    ],
    "total": 1
  }
}
```

## 3) Resposta de POST /restaurante/caixas

O handler retorna o item da caixa completo dentro do envelope de sucesso.

Estrutura da resposta:

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "empresaId": "empresa-uuid",
    "tipo": "caixa",
    "estado": "aberto",
    "abertoPor": "user-uuid",
    "fundoInicial": 50000,
    "totalEntradas": 50000,
    "totalSaidas": 0,
    "totalVendas": 0,
    "observacoes": "Turno da tarde",
    "createdAt": "2026-09-22T12:00:00.000Z",
    "updatedAt": "2026-09-22T12:00:00.000Z"
  }
}
```

O saldo esperado do caixa não é persistido como campo. O cálculo do cliente deve ser:

```text
totalEntradas - totalSaidas
```

## 4) Estados oficiais da mesa

O backend usa os seguintes estados:
- livre
- ocupada

Regra de negócio:
- ao criar mesa, o estado inicial é livre
- ao abrir pedido com mesaId, a mesa passa para ocupada

Para o Flutter:
- livre = disponível
- qualquer outro valor = ocupada

## 5) POST /restaurante/pedidos/{pedidoId}/linhas

O schema exige `produtoId` obrigatório.

O backend não valida a existência do produto no stock ao adicionar a linha. O validation de stock acontece no fecho do pedido.

Conclusão prática:
- o produto pode entrar no pedido mesmo sem estar pré-cadastrado no stock,
- mas no fecho o sistema valida se há disponibilidade e devolve conflito se não houver.

## 6) Métodos de movimento

O backend aceita os seguintes tipos e métodos:

Tipos do movimento:
- entrada
- saida
- sangria
- reforco

Métodos:
- numerario
- cartao
- multicaixa
- transferencia
- outro

## 7) Fecho do pedido e erros operacionais

### Sucesso

```json
{
  "success": true,
  "data": {
    "pedidoId": "uuid",
    "estado": "fechado",
    "stockAplicado": true,
    "total": 2500
  }
}
```

### Conflito

```json
{
  "success": false,
  "error": "Stock insuficiente ou pedido ja fechado",
  "details": {}
}
```

Também pode acontecer conflito quando o pedido ainda não está entregue.

## 8) Faturação idempotente

Sim, a faturação do pedido é idempotente por pedido.

Comportamento:
- se o pedido já tem fatura associada, a chamada repete a mesma fatura
- não duplica a fatura

## 9) Estrutura exata da resposta de faturação

```json
{
  "success": true,
  "data": {
    "pedidoId": "uuid",
    "faturaId": "uuid",
    "numero": "FT 2026/000001",
    "subtotal": 2000,
    "totalIva": 280,
    "total": 2280,
    "moeda": "AOA"
  }
}
```

A estrutura interna da fatura também inclui `dataEmissao`, mas o handler de faturação não devolve esse campo no payload da resposta.

## 10) Autorização e condições de negócio

A autorização não depende apenas do role do utilizador.

Também existem regras de negócio:
- caixa só abre para não viewer
- caixa só fecha para gestores
- pedido só fecha se estiver entregue
- pedido só fatura se estiver fechado e com stock aplicado
- stock insuficiente devolve conflito operacional

## 11) Disponibilidade em dev/prod

Sim, o serviço Restaurante já está publicado em ambiente produtivo.

A API pública foi confirmada como parte do stack do serviço.

O endereço base é obtido a partir da API Gateway do stack publicado:

```text
https://{apiId}.execute-api.af-south-1.amazonaws.com/prod
```

O serviço não exporta um campo `ServiceEndpoint` fixo no CloudFormation; a forma correta para o app é carregar a URL por ambiente.

## 12) Paginação, ordenação e filtros

No backend atual:
- não há paginação obrigatória para as listas do restaurante
- GET /restaurante/caixas usa limit 100
- GET /restaurante/mesas usa query sem paginação explícita
- GET /restaurante/cozinha/fila carrega todos os pedidos e ordena por data de criação

Para o piloto, o Flutter deve tratar as listas como conjuntos operacionais locais e não depender de paginação server-side.

## 13) Datas e timezone

O backend usa strings ISO e compara datas por texto.

O relatório recebe:
- inicio: AAAA-MM-DD
- fim: AAAA-MM-DD

A comparação é inclusiva.

A lógica atual usa `toISOString`, portanto o timezone implícito é UTC. Isso não foi formalizado como Africa/Luanda no código.

## 14) Entidades aceites em Documentos

No módulo Documentos, o tipo de entidade é genérico e validado em snake_case.

Os tipos recomendados para o restaurante são:
- fornecedor
- licenca
- produto
- compra
- pedido
- mesa

## 15) Campos de validade no módulo Documentos

### Documento

```json
{
  "dataValidade": "2026-12-31",
  "ocrStatus": "pendente",
  "ultimoNivelAlertaEnviado": "aviso"
}
```

Valores possíveis:
- dataValidade: string AAAA-MM-DD
- ocrStatus: pendente | concluido | falhou | nao_suportado
- ultimoNivelAlertaEnviado: aviso | atencao | critico | expirado

Também existem campos auxiliares:
- dataValidadeSugerida
- dataValidadeSugeridaTexto
- dataValidadeSugeridaIgnorada

## Conclusão para o Flutter

O contrato atual é suficientemente estável para o piloto:
- autenticação via Cognito
- token no header Authorization
- envelope success/data
- respostas 400/401/403/404/409/500 tratadas corretamente
- módulos de caixa, mesas, pedidos, cozinha, stock, faturação, relatórios e documentos já disponíveis no backend
- a ausência de GET /restaurante/pedidos é uma diferença clara de contrato e deve ser tratada no backend se o app precisar de listar pedidos.

## Recomendação de implementação no Flutter

- usar entidade de negócio local para os itens retornados
- diferenciar erro operacional (409) de erro genérico
- tratar `401` como sessão expirada e renovar token
- não fazer retry automático em operações de escrita
- manter payloads e estados do backend como fonte da verdade
