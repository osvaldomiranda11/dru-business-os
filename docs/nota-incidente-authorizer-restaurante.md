# Nota de incidente — authorizer do Restaurante

## Sintoma

Todas as rotas do módulo Restaurante retornam `401 Unauthorized` ao carregar no Flutter, mesmo com o `idToken` correto enviado no header `Authorization`.

## Diagnóstico

A auditoria do backend revelou que o serviço Restaurante não está configurado com o mesmo authorizer Cognito User Pool usado pelos restantes serviços da plataforma.

### Comparação direta da configuração

Os outros serviços usam a configuração padrão:

```yaml
authorizer:
  name: CognitoAuthorizer
  type: COGNITO_USER_POOLS
  arn: ${cf:dru-bos-infra-${sls:stage}.CognitoUserPoolArn}
```

Exemplos:
- [services/auth/serverless.yml](../services/auth/serverless.yml)
- [services/documentos/serverless.yml](../services/documentos/serverless.yml)
- [services/stock/serverless.yml](../services/stock/serverless.yml)

O serviço Restaurante tinha as rotas com `cors: true` e sem authorizer. Isso foi identificado em:
- [services/restaurante/serverless.yml](../services/restaurante/serverless.yml)

## Causa raiz

O Flutter envia corretamente o token no formato:

```http
Authorization: Bearer <idToken>
```

Mas o API Gateway do Restaurante não valida esse token contra o User Pool correto antes de encaminhar para a Lambda. O resultado é um `401` genérico em todas as rotas protegidas.

## Correção aplicada

A configuração padrão do authorizer Cognito User Pool foi aplicada a todas as rotas do serviço Restaurante, alinhando-o com o restante da plataforma.

## O que a equipa Flutter deve assumir

- O token correto continua sendo `idToken`.
- O authorizer do Restaurante deve coincidir com o User Pool do Auth.
- A resposta `401` em todas as rotas do módulo não é um problema do ecrã, do payload ou do interceptor.
- Com a correção aplicada, a autorização deve passar a funcionar sem alterações no Flutter.

## Verificação recomendada

Depois do deploy do serviço Restaurante, confirmar este fluxo:

1. Login no Auth.
2. Obter `idToken`.
3. Chamada de teste para `GET /restaurante/caixas` com `Authorization: Bearer <idToken>`.
4. Confirmar `200` e não `401`.

## Observação importante

Ainda não se deve misturar `accessToken` e `idToken` em chamadas do frontend. O contrato atual do backend usa o `idToken` para autenticação da API Gateway.
