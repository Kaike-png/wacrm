# `src/custom` — camada de produto (Custom Layer)

Primeira camada acima do core WACRM. Contém **só** o que é transversal ao
nosso produto e as costuras (seams) com o core:

| Caminho                            | Papel                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/server.ts`, `core/client.ts` | **Fachada do core** (anti-corruption layer). Só re-exports. O código do fork fora de `src/custom` acessa as APIs do core por aqui.                                                                                                            |
| `core-patches.ts`                  | Registro de toda alteração feita em arquivo do core (`FORK-PATCH(P-NNN)`).                                                                                                                                                                    |
| `i18n/`                            | Seam P-002: catálogos de strings do fork (`Custom`, `Br`, `Billing`, `Integrations`), mesclados sobre `messages/*.json`; overrides explícitos de chaves do core (marca).                                                                      |
| `brand/`                           | Identidade do produto (P-003): `config.ts` é o **único** leitor das variáveis de marca. Ver [`docs/BRANDING.md`](../../docs/BRANDING.md).                                                                                                     |
| `locale/`                          | Regional (P-004): formato/fuso/moeda por tenant, `format.ts` para toda data/número/valor, entrada `1.500,50`, CSV do Excel pt-BR. Ver [`docs/LOCALIZATION.md`](../../docs/LOCALIZATION.md).                                                   |
| `whatsapp/`                        | Credenciais do WhatsApp só no servidor (P-008): `config-store.ts` (service role), status/teste/log de conexão, redação de segredos nos logs. Ver [`docs/WHATSAPP_SAAS.md`](../../docs/WHATSAPP_SAAS.md).                                      |
| `tenancy/`                         | Acesso do tenant (P-009): organizações `suspended`/`cancelled` perdem acesso nos caminhos da service role (`access.ts`) e veem o aviso de suspensão (`tenant-access-gate.tsx`). Ver [`docs/PLATFORM_ADMIN.md`](../../docs/PLATFORM_ADMIN.md). |
| `architecture.test.ts`             | Guarda de camadas e de patches (roda no `npm test`/CI).                                                                                                                                                                                       |

Regras:

- Pode importar do core. Não pode importar `billing`, `modules` ou `integrations`.
- Nada de regra de negócio específica (BR, billing, integrações) aqui.
- Detalhes em [`docs/UPSTREAM_STRATEGY.md`](../../docs/UPSTREAM_STRATEGY.md).
