# Roadmap do piloto Bar & Restaurante

## Objetivo

Colocar o DRU Business OS a funcionar numa operação real de bar e restaurante, sem perder os diferenciais de faturação, controlo financeiro e gestão documental.

O piloto deve permitir que uma equipa abra o turno, registe pedidos, acompanhe a preparação, feche contas, receba pagamentos, controle stock e feche o caixa com auditoria completa.

## Ordem de entrega

### Fase 0 - Fundacao de producao

Antes de expor novos fluxos ao cliente:

- Corrigir idempotencia do webhook Multicaixa.
- Tornar o registo de pagamentos atomico e resistente a concorrencia.
- Adicionar testes de contrato para autorizacao, isolamento por empresa e estados invalidos.
- Confirmar alarmes CloudWatch, logs estruturados e notificacao de falhas de deploy.
- Separar ambientes dev e prod e restringir segredos, CORS e permissoes IAM.

**Saida:** pagamentos e eventos financeiros nao duplicam nem perdem dados sob retry.

### Fase 1 - Operacao diaria do restaurante (P0)

Criar um dominio de vendas com estes recursos:

- Produtos vendaveis, categorias, menus e opcoes.
- Mesas e zonas, com estados livre, ocupada, reservada e bloqueada.
- Pedido associado a mesa, balcao ou takeaway.
- Linhas de pedido com quantidade, observacoes e estado de preparacao.
- Estados do pedido: aberto, em_preparacao, pronto, entregue, fechado e cancelado.
- Pagamentos por numerario, cartao, Multicaixa e pagamentos mistos.
- Descontos e gorjetas com permissao apropriada.
- Fecho de conta e emissao da fatura a partir da venda.
- Auditoria de cancelamentos, descontos, alteracoes e reabertura de conta.

**Criterio de aceite:** um operador consegue abrir uma mesa, lancar itens, enviar o pedido para preparacao, fechar a conta e receber por dois metodos sem criar registos manuais duplicados.

Criar tambem o dominio de caixa:

- Abertura de turno com fundo inicial.
- Movimentos de entrada, saida e sangria.
- Totais esperados por metodo de pagamento.
- Fecho contado pelo operador e validacao pelo gestor.
- Diferenca justificada e registada na auditoria.

**Criterio de aceite:** no final do turno o gestor ve vendas, pagamentos, sangrias, valor esperado, valor contado e diferenca por operador.

### Fase 2 - Stock proprio para restauracao (P0/P1)

Evoluir o stock existente para consumo real:

- Ficha tecnica de prato/bebida com ingredientes e quantidades.
- Conversao de unidades, por exemplo caixa, garrafa, litro e dose.
- Baixa automatica de ingredientes quando a venda e fechada.
- Reposicao em cancelamento ou devolucao.
- Registo de desperdicio, quebra e consumo interno.
- Compras, fornecedores e rececao de mercadoria.
- Inventario fisico por armazem, bar e cozinha.
- Lotes e validade para produtos sensiveis.

**Criterio de aceite:** vender uma bebida ou prato reduz os ingredientes certos, impede stock negativo e deixa rastreio ate ao pedido e operador.

### Fase 3 - Cozinha, analise e controlo (P1)

- Vista de cozinha/KDS por estacao.
- Tempo de preparacao e atrasos.
- Relatorio de vendas por turno, operador, mesa, categoria e item.
- Ticket medio, margem estimada, cancelamentos e desperdicio.
- Itens mais vendidos e stock critico.
- Fecho diario automatico com resumo financeiro e documental.

### Fase 4 - Gestao documental diferenciadora (P1)

Usar o modulo documental ja existente como parte do fluxo operacional:

- Pasta por restaurante, fornecedor e area.
- Licencas, alvara, contratos e documentos sanitarios com validade.
- Fichas tecnicas e comprovativos ligados a produtos.
- Faturas de fornecedores ligadas a compras e entradas de stock.
- Aprovacao interna para despesas, compras e documentos sensiveis.
- Alertas de expiracao e pesquisa por OCR.
- Partilha controlada com contabilista, auditor ou parceiro.

**Diferencial:** o DRU nao guarda apenas documentos; relaciona cada documento com a operacao que o justifica e alerta antes de uma licenca ou contrato expirar.

## Modelo tecnico recomendado

- Criar tabelas ou agregados dedicados para vendas, pedidos e caixas, sem sobrecarregar a tabela de faturacao.
- Usar `TransactWrite` para fechar venda, gravar linhas, atualizar stock e criar o pagamento quando as operacoes partilham a mesma fronteira DynamoDB.
- Usar uma chave de idempotencia em cada comando externo e webhook.
- Publicar eventos de negocio atraves de outbox ou fila com retry e DLQ.
- Manter `empresaId` em todas as chaves e validar autorizacao no backend.
- Tratar o cliente Flutter como consumidor da API; nenhuma regra de dinheiro, stock ou permissao deve depender do frontend.
- Comecar com um restaurante, uma moeda e um armazem operacional no piloto; deixar multi-localizacao para depois da validacao.

## Backlog imediato

1. Fechar idempotencia e atomicidade dos pagamentos.
2. Definir contrato API de `vendas`, `pedidos`, `mesas` e `caixas`.
3. Implementar abertura/fecho de caixa e movimentos de caixa.
4. Implementar venda e pedido de mesa com pagamento misto.
5. Ligar venda fechada a faturacao e stock.
6. Criar testes de concorrencia, retry e isolamento multi-tenant.
7. Preparar seed de produtos, mesas e utilizadores para o restaurante piloto.

## Fora do primeiro piloto

Nao bloquear a primeira utilizacao com delivery, reservas avancadas, fidelizacao, multi-filial, contabilidade externa, AGT automatizada ou IA conversacional. Essas capacidades entram depois de a operacao de venda, caixa, stock e documentos estar comprovada em uso diario.
