# Organizações (tenants) e isolamento

Cada cliente do SaaS é uma **organização**. Este documento descreve como
ela é modelada, como o isolamento entre organizações é garantido e como
isso é testado.

Migrations: `902_br_organization_profile.sql` (organização) e
`903_tenant_isolation_hardening.sql` (correções de isolamento). Testes:
`supabase/tests/database/tenant_isolation.test.sql`. Patch do core:
**P-006**.

---

## 1. A organização é a `accounts` do upstream

O projeto já tinha o conceito: **`accounts` é o tenant**. Toda tabela de
dados tem `account_id`, as policies RLS usam
`is_account_member(account_id, papel)`, e o usuário entra numa conta por
`profiles.account_id` + `profiles.account_role` (owner/admin/agent/viewer).
**Nenhuma entidade nova de organização foi criada.** O que faltava foi
acrescentado à própria `accounts` ou numa extensão 1:1 dela:

| Campo pedido | Onde está | Origem |
|---|---|---|
| nome | `accounts.name` | upstream |
| moeda | `accounts.default_currency` | upstream (021); padrão BRL (900) |
| timezone | `accounts.timezone` | fork (900) |
| idioma | `accounts.locale` (`pt-BR`) | fork (900). Ver a nota abaixo |
| **status** | `accounts.status` + `status_changed_at`, `trial_ends_at` | **902** |
| razão social, nome fantasia | `br_account_profiles.legal_name`, `.trade_name` | **902** |
| CPF/CNPJ | `br_account_profiles.person_type`, `.tax_id` (sem máscara, dígito verificador validado) | **902** |
| telefone, e-mail | `br_account_profiles.phone` (E.164), `.email` | **902** |
| CEP, endereço, cidade, UF | `br_account_profiles.postal_code`, `street`, `street_number`, `complement`, `district`, `city`, `state` | **902** |

- **Idioma:** `accounts.locale` já guarda o idioma/formato da organização. A
  interface ainda carrega um único catálogo por instalação
  (`docs/LOCALIZATION.md` §8). Quando o idioma por tenant existir, ele lê
  esta coluna, sem coluna nova.
- **Por que o status fica em `accounts`:** é o ciclo de vida do próprio
  tenant e será consultado em toda requisição (middleware, cobrança).
- **Por que os dados cadastrais ficam em `br_account_profiles`:**
  - formato fixo e validado;
  - mesmos validadores e componentes dos contatos (`br_contact_profiles`, 901);
  - não empilha colunas numa tabela do upstream.
- `br_account_profiles` não é outra entidade: a chave primária é o próprio
  `account_id`, e o registro some junto com a conta (`ON DELETE CASCADE`).

### Status

| Valor | Significado | Uso normal do produto (`isAccountOperational`) |
|---|---|:-:|
| `trial` | período de teste (padrão de **contas novas**) | ✔ |
| `active` | assinatura em dia (contas **existentes** na data da migration) | ✔ |
| `past_due` | pagamento em atraso (carência) | ✔ |
| `suspended` | suspensa | ✘ |
| `cancelled` | cancelada | ✘ |

- **Só a cobrança muda o status** (`service_role`). O banco recusa,
  vindo do cliente (`authenticated`/`anon`), alteração de `status`,
  `status_changed_at`, `trial_ends_at`, `owner_user_id` e `id` (trigger
  `accounts_guard_privileged_columns`).
- **Sem isso**, a policy `accounts_update` do upstream deixaria um admin
  colocar a própria conta como `active`, estender o trial ou trocar o dono
  sem passar por `transfer_account_ownership`.
- As RPCs SECURITY DEFINER do upstream continuam funcionando.
- `status_changed_at` é atualizado automaticamente.
- **Regras de transição** (`canTransition`, `src/billing/account-status.ts`):
  - trial → active, past_due, suspended, cancelled;
  - active → past_due, suspended, cancelled;
  - past_due → active, suspended, cancelled;
  - suspended → active, cancelled;
  - cancelled → active (reativação).

  O banco aceita qualquer um dos 5 valores vindos da `service_role`, para
  que um operador consiga corrigir um erro.
- **O que cada status bloqueia ainda não está aplicado.** Hoje o status é
  armazenado, protegido e exibido. O bloqueio (por exemplo, impedir envio
  com `suspended`) é decisão da cobrança e entra com ela, usando
  `isAccountOperational`.

### Tela

Configurações → **Organização**, nova seção no grupo “Espaço de trabalho”:

- situação (selo, descrição e dias restantes do trial);
- nome, salvo pelo `PATCH /api/account` do upstream, com a validação dele;
- moeda, idioma e fuso: só leitura, com link para **Região e moeda** (o
  editor fica num lugar só);
- dados cadastrais e endereço, com as mesmas máscaras e validações dos
  contatos (`docs/BRAZILIAN_CONTACTS.md`).

Membros leem. Só admin+ edita (RLS; a tela mostra o aviso).

Código: `src/modules/br/organization.ts` (modelo e validação),
`organization-settings.tsx` (tela) e `src/billing/account-status.ts`
(status). O rótulo da seção vem da camada nova de **additions** do i18n
(`src/custom/i18n/additions/`): chaves novas em namespaces do core, que
falham no CI se o upstream criar uma chave com o mesmo nome.

---

## 2. Revisão de RLS e isolamento

### Como estava

- RLS habilitado em **todas** as tabelas de `public`.
- Policies de leitura com `is_account_member(account_id)` ou `auth.uid()`.
- Escrita por papel (agent+/admin+).
- Os `UPDATE` sem `WITH CHECK` reaproveitam o `USING`, então mover uma
  linha para outro tenant já era barrado.
- `profiles` já protegia `account_id`/`account_role` contra UPDATE (034).

As brechas estavam **em volta** do RLS:

| # | Problema | Exploração | Correção (903) |
|---|---|---|---|
| 1 | Funções SECURITY DEFINER sem checagem de conta, **executáveis por `anon` e `authenticated`** | `record_webhook_failure(id, 1)` **desativa o webhook de outro tenant**; `claim_ai_reply_slot` esgota a IA de outro tenant; `_bcast_bump`/`recompute_broadcast_counts` adulteram métricas de campanha; `merge_duplicate_*` reescreve dados de todos | `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`; `GRANT … TO service_role`. Só o webhook e os engines chamam essas funções, sempre com `service_role` |
| 2 | Referências entre tenants: o RLS checa o `account_id` da linha, não o das linhas apontadas | negócio no contato de outro tenant; tag ou campo personalizado de outro tenant no próprio contato; resposta a mensagem alheia; contato alheio na campanha; **conversa atribuída a usuário de outro tenant, que recebia notificação com o nome do contato** | triggers `tenant_enforce_refs` em 16 tabelas exigem que cada referência seja da mesma conta. Valem também para a `service_role`, ou seja, para um id errado numa configuração de automação |
| 3 | `profiles` INSERT checava só `user_id = auth.uid()` | um usuário sem profile (bootstrap que falhou) podia se inserir em **qualquer conta como owner** | trigger `profiles_guard_client_insert`: o cliente só cria profile numa conta da qual é dono. O `handle_new_user` não é afetado |
| 4 | Storage: policies `SELECT` “… is publicly readable” nos buckets públicos | qualquer um, até sem login, **listava a mídia de todos os tenants** pela Storage API (documentos e fotos de clientes finais) | `SELECT` restrito à pasta da própria conta (`account-<id>/`) ou do próprio usuário. A URL pública continua funcionando, porque bucket público não passa por RLS no download |
| 5 | `GET /api/whatsapp/media/[id]` respondia `Cache-Control: public` | um cache compartilhado (CDN/proxy) poderia servir a mídia de um tenant para outro | `private` + `Vary: Cookie` (patch P-006) |
| 6 | admin alterava `accounts.owner_user_id` direto | troca de dono sem a RPC | guard do item 1.1 (902) |

**Detalhes das referências (item 2):**

- Para responsáveis (`conversations.assigned_agent_id`,
  `ai_configs.handoff_agent_id`, `deals.assigned_to`) a referência de outro
  tenant **é limpa (NULL) com WARNING**, em vez de erro. Assim, um handoff
  configurado para alguém que já saiu da conta ainda passa a conversa para
  “sem responsável”, em vez de abortar a atualização inteira (inclusive o
  desligamento da IA).
- Referências que não mudaram numa linha que não mudou de conta não são
  reavaliadas: dados antigos não travam edições. Para revisar dados
  antigos, use `select * from tenant_cross_reference_report()` (service
  role). No banco local, 0 linhas.

### Como está agora

| Vetor | Situação |
|---|---|
| Tabelas `public` | RLS em todas, leitura sempre por membership ou `auth.uid()` (testado) |
| Funções SECURITY DEFINER | só as revisadas são executáveis por clientes (lista no teste) |
| Referências entre linhas | mesma conta obrigatória (triggers) |
| `profiles` | não aponta para conta alheia, nem por INSERT nem por UPDATE |
| `accounts` | status, trial, dono e id fora do alcance do cliente |
| Storage | sem listagem cruzada. URL pública de mídia ainda é acessível a quem a tiver (§3) |
| Realtime | respeita RLS (`postgres_changes`) |
| Service role (API v1, webhook, engines) | queries filtram `account_id` no código; as triggers de referência são a rede de segurança no banco |

---

## 3. Riscos que continuam (decisões para depois)

> WhatsApp: credenciais por tenant, segredos fora do navegador e webhook
> conferindo a WABA estão em [`WHATSAPP_SAAS.md`](./WHATSAPP_SAAS.md).

- **URL pública de mídia.** `chat-media`/`flow-media` continuam buckets
  públicos, porque a Meta busca a mídia por URL no envio. Quem tiver a URL
  (`account-<uuid>/<timestamp>-<nome>`) baixa o arquivo. A listagem foi
  fechada, mas a URL não é secreta o bastante para documentos de clientes
  finais (LGPD). Solução: bucket privado + URL assinada de curta duração
  para a Meta e para a interface. Mexe no upload, no espelho de mídia e na
  exibição.
- **Status sem efeito.** `suspended`/`cancelled` ainda não bloqueiam nada (§1).
- **Membership 1:1.** Um usuário pertence a uma conta por vez
  (`profiles.account_id`). Um usuário em várias organizações exige uma
  tabela de vínculos e mexe no `is_account_member`.
- **Upstream recriando funções.** Uma migration futura que faça
  `DROP FUNCTION` + `CREATE` de uma função DEFINER volta a dar EXECUTE
  público. O teste de “SECURITY DEFINER não revisada” pega isso no CI.

---

## 4. Testes de isolamento

`supabase/tests/database/tenant_isolation.test.sql`: **115 testes pgTAP**,
numa transação que é desfeita no fim.

1. **Seed:** cria quatro usuários reais (`auth.users`, que dispara o
   `handle_new_user`): dono de A, viewer de A, dono de B e um usuário sem
   profile. Grava **uma linha em cada tabela de tenant** para A e para B.
2. **Execução:** cada verificação roda com o **papel real do cliente**
   (`authenticated` com as claims do JWT, ou `anon`), exatamente como
   PostgREST e Realtime.
3. **Cobertura:** onde possível, as verificações são **genéricas**: toda
   tabela com `account_id` é coberta, inclusive tabelas futuras.

O que é verificado:

- **Esquema:**
  - RLS ligado em toda tabela;
  - toda tabela tem policy, salvo a lista revisada de tabelas só de servidor;
  - nenhuma policy é `true`;
  - toda policy de leitura de tabela de tenant usa membership ou `auth.uid()`;
  - nenhuma função SECURITY DEFINER não revisada é executável por clientes.
- **Leitura:**
  - A (dono e viewer), `anon` e o usuário sem profile não veem **nenhuma
    linha de B** em nenhuma tabela com `account_id`, nem nas tabelas filhas
    (mensagens, reações, tags do contato, valores de campo, etapas,
    destinatários, passos, blocos, eventos);
  - também não veem storage de B, nem resultados de B via
    `filter_contacts_by_tags` e `match_ai_knowledge_fts`.
  - Um teste de sanidade garante que B vê os próprios dados, para que os
    testes acima não passem por estarem vazios.
- **Escrita:**
  - A não insere em B;
  - `UPDATE`/`DELETE` em linhas de B não afetam nada, em **todas** as
    tabelas com `account_id`;
  - A não move uma linha sua para B.
- **Referências:** negócio, etapa, tag, campo, resposta, campanha, anotação
  e conversa com ids de B são recusados; uma atribuição a usuário de B é
  limpa e não gera notificação; a `service_role` também não liga tenants.
- **RPCs:**
  - webhook, IA, contadores, merge global e `tenant_account_of` estão fora
    do alcance do cliente;
  - A não muda o papel nem remove membros de B;
  - o webhook de B continua ativo.
- **Profiles:**
  - A não move o próprio profile para B;
  - o viewer não se promove a dono;
  - o usuário sem profile não se coloca em B como dono.
- **Organização:**
  - o dono renomeia a própria organização;
  - o dono **não** muda status, trial nem dono;
  - o dono edita os dados cadastrais; CNPJ inválido e telefone fora do
    E.164 são recusados; o perfil não muda de conta;
  - o viewer lê, mas não edita;
  - a `service_role` muda o status e `status_changed_at` é registrado;
  - um status fora dos 5 valores é recusado.

**Prova de que os testes pegam o problema:** rodei a mesma suíte com as
proteções da 903 e do guard da 902 desfeitas (dentro da transação). Ela
reprovou **23 testes**: funções expostas, listagem de storage, as 8
referências cruzadas, a notificação para o usuário de B, o webhook de B
desativado, o profile em B como dono, status/trial/dono alterados pelo
cliente. Com as migrations, passam **115/115**.

### Rodar

```bash
npm run test:db              # banco local do `supabase start` (via docker) ou $DATABASE_URL
supabase test db             # alternativa pelo CLI (pg_prove)
```

- **CI:** `.github/workflows/fork-db-tests.yml`, arquivo do fork, separado
  do `migrations.yml` do upstream para não conflitar. Aplica todas as
  migrations num Postgres limpo e roda a suíte.
- **Unitários (vitest):**
  - `src/billing/account-status.test.ts`: estados, transições, trial;
  - `src/modules/br/organization.test.ts`: dados cadastrais sem máscara,
    validação, telefone internacional e CPF;
  - `src/custom/i18n/merge.test.ts`: additions.

### Ao criar uma tabela nova (fork ou merge do upstream)

1. `account_id NOT NULL` + RLS com `is_account_member`, como no upstream.
2. Se ela referencia linhas de outras tabelas de tenant, acrescente a
   tabela em `tenant_enforce_refs` (nova migration com o mesmo `DO` da 903)
   e, se for o caso, o tipo em `tenant_account_of`.
3. Se for só de servidor (sem policies), coloque-a na lista revisada do
   teste com um comentário do porquê.
4. Função SECURITY DEFINER nova: ou checa `auth.uid()`/membership e entra
   na lista revisada do teste, ou recebe
   `REVOKE … FROM PUBLIC, anon, authenticated`.
5. Rode `npm run test:db`.
