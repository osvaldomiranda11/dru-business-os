# Incidente 500 — gravação de auditoria do Restaurante

## Diagnóstico confirmado

As Lambdas de escrita do Restaurante chamam `registarAuditoria()` depois de persistirem a operação. Em produção, `AUDITORIA_TABLE` não estava definida no ambiente da Lambda. A camada partilhada usa essa variável como nome da tabela DynamoDB; o CloudWatch registou:

```text
ValidationException: Value null at 'tableName' failed to satisfy constraint: Member must not be null
```

A tabela existe (`dru-bos-prod-auditoria`) e o role IAM do serviço já tem acesso. A falha era a ausência da variável de ambiente, não uma permissão IAM nem um payload Flutter.

## Efeito importante para o Flutter

Algumas operações gravam a alteração principal antes de tentar gravar a auditoria. Por isso, um `500` não garante que nada aconteceu: o movimento, pedido, alteração de estado, fecho/baixa de stock ou fatura pode já ter sido persistido.

**Não repetir automaticamente uma escrita depois de `500`.** Antes de tentar de novo:

1. Atualizar a leitura da entidade afetada.
2. Verificar se a operação já aparece refletida.
3. Se o estado não puder ser determinado com segurança, parar e pedir verificação ao suporte/backend.

Exemplos de leitura de estado incluem consultar caixas e totais, mesas, fila da cozinha e `GET /restaurante/pedidos`.

## Alteração no backend

O serviço Restaurante passa a receber:

```yaml
AUDITORIA_TABLE: ${cf:dru-bos-infra-${sls:stage}.AuditoriaTableName}
```

A role IAM já inclui `dynamodb:PutItem` e a tabela de auditoria. O guard do CI também foi ampliado para falhar se um serviço que chama `registarAuditoria()` não declarar a tabela de auditoria do stage.

## Orientação para a equipa Flutter

- Não alterar `ApiClient`, token, authorizer ou payloads por causa deste incidente.
- Não fazer retry automático de operações `POST` após resposta `500`.
- Mostrar a mensagem de erro, atualizar os dados visíveis e evitar submissão duplicada.
- Para movimentos e fechos, informar o utilizador que o resultado pode estar pendente de confirmação; pedir verificação antes de tentar novamente.
- Após o deploy do backend, repetir apenas uma operação de teste controlada e confirmar o estado atualizado.

## Verificação pós-deploy

1. Confirmar em `get-function-configuration` que as Lambdas Restaurante têm `AUDITORIA_TABLE` apontando para `dru-bos-{stage}-auditoria`.
2. Fazer uma escrita controlada.
3. Confirmar resposta de sucesso e registo correspondente na tabela de auditoria.
4. Confirmar que não há `ValidationException` no CloudWatch.

## Reconciliação operacional — 2026-10-04

Na empresa de teste, foram encontrados pedidos sem linhas e total zero criados durante falhas condicionais ao ocupar uma mesa, além de mesas ocupadas por pedidos cancelados ou impossíveis de fechar. Os registos foram preservados e reconciliados por transações condicionais com auditoria: os pedidos vazios foram marcados como cancelados e as mesas correspondentes ficaram livres. Não foram alterados pedidos com linhas, valor ou fatura.

Mesa 2 e Mesa 3 estavam associadas a pedidos `entregue`, mas sem linhas/valor/fatura; foram igualmente preservadas como pedidos cancelados e as mesas libertadas, pois o fluxo de fecho rejeita pedidos sem linhas.

O código em preparação torna abertura de pedido/ocupação de mesa atómicos, liberta mesa no cancelamento e fecho, inclui auditoria nas mesmas transações e acrescenta `GET /restaurante/pedidos`. **As escritas continuam suspensas até este código passar CI e ser deployado.** Depois do deploy, fazer uma única operação controlada e confirmar resposta, estado e auditoria antes de retomar o uso normal.
