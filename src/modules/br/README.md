# `src/modules/br` — funcionalidades específicas do Brasil

Módulo de domínio para regras brasileiras (ex.: normalização de telefone
BR com DDD/9º dígito, CPF/CNPJ, feriados nacionais, horário comercial em
`America/Sao_Paulo`, textos pt-BR do produto).

Regras:

- Pode importar: core **via** `@/custom/core/*`, `@/custom/*`, `@/billing/*`,
  componentes/hooks/tipos de UI do core.
- Não pode importar: `@/lib/**` diretamente, `@/integrations/*`.
- Strings: namespace `Br.*` em `src/custom/i18n/messages/*.json`.
- Tabelas: prefixo `br_` em migrations `9NN_br_*.sql`.
- Se uma regra BR precisar mudar comportamento do core, registre um patch
  (`src/custom/core-patches.ts`) e prefira uma função pura daqui chamada
  por uma linha marcada no core.

## Conteúdo

| Arquivo                                                                   | O quê                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `documents.ts`                                                            | CPF/CNPJ (inclusive alfanumérico): validação, máscara, forma sem máscara                                            |
| `phone.ts`                                                                | telefone brasileiro → E.164, DDDs, máscara de exibição                                                              |
| `address.ts`                                                              | CEP, UFs, contrato `CepLookupProvider` (sem integração)                                                             |
| `profile.ts`                                                              | modelo de `br_contact_profiles` (migration 901): formulário ↔ linha, validação                                      |
| `organization.ts`, `organization-fields.tsx`, `organization-settings.tsx` | dados cadastrais da organização (`br_account_profiles`, migration 902) e a tela Configurações → Organização (P-006) |
| `use-br-profile.ts`, `contact-fields.tsx`                                 | hook e UI usados pelo formulário e pelo detalhe do contato (P-005)                                                  |

Decisões em [`docs/BRAZILIAN_CONTACTS.md`](../../../docs/BRAZILIAN_CONTACTS.md).
