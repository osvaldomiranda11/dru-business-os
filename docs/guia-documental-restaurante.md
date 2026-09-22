# Gestão documental do restaurante

O módulo Documentos já é transversal. Para o restaurante, os documentos são ligados às entidades operacionais através dos endpoints existentes, sem duplicar dados no serviço Restaurante.

## Tipos de ligação

| Tipo | Uso | Categoria recomendada |
| --- | --- | --- |
| `fornecedor` | Contratos, NIF, dados bancários e documentos comerciais | `contrato`, `identificacao` |
| `licenca` | Alvará, licença sanitária e certificados de funcionamento | `licenca` |
| `produto` | Ficha técnica, informação de alergénios e documentação do produto | `ficha_tecnica` |
| `compra` | Faturas e comprovativos de compra de mercadoria | `comprovativo`, `fatura_anexo` |
| `pedido` | Comprovativos, reclamações ou documentos associados a uma venda | `comprovativo`, `outro` |
| `mesa` | Reservas ou documentação operacional específica | `outro` |

## Fluxo recomendado

1. Criar a metadata do documento através de `POST /documentos`.
2. Definir `categoria`, `tags` e `dataValidade` quando aplicável.
3. Ligar o documento através de `POST /documentos/{id}/ligar`.
4. Usar `tipoEntidade`, `entidadeId` e `entidadeNome` no corpo da ligação.
5. Consultar os documentos através de `GET /documentos/entidade/{tipoEntidade}/{entidadeId}`.
6. Confirmar ou rejeitar sugestões de validade detectadas pelo OCR.
7. Usar os alertas automáticos para licenças, contratos e certificados próximos do vencimento.

## Exemplos de ligações

```json
{
  "tipoEntidade": "fornecedor",
  "entidadeId": "fornecedor-uuid",
  "entidadeNome": "Fornecedor de bebidas"
}
```

```json
{
  "tipoEntidade": "licenca",
  "entidadeId": "licenca-alvara-principal",
  "entidadeNome": "Alvará de funcionamento 2026"
}
```

## Regras de produto

- Documentos de validade devem guardar `dataValidade` em `AAAA-MM-DD`.
- A validade sugerida pelo OCR exige confirmação do utilizador.
- Faturas de fornecedores devem ligar-se à compra, não apenas ao produto.
- O Flutter deve mostrar documentos ligados à entidade actual, mas a autorização continua no backend.
- Partilhas externas devem ser usadas apenas quando necessárias e sempre com expiração.

## Diferencial do DRU

O restaurante não terá apenas uma pasta de ficheiros. Cada licença, contrato, ficha técnica ou comprovativo fica relacionado com a entidade operacional certa, pesquisável por OCR e acompanhado por alertas de validade.