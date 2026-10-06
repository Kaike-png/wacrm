# Estratégia de compatibilidade com o upstream

> Objetivo: continuar recebendo correções e features do
> [`ArnasDon/wacrm`](https://github.com/ArnasDon/wacrm) enquanto o produto
> (SaaS BR) cresce. A ideia é que cada merge do upstream seja uma operação
> **previsível e pequena**.
>
> Estado em 2026-10-05: o fork está exatamente **1 commit à frente** do
> upstream (`45e80ad`, 0 commits atrás). É o melhor momento para fixar as regras.

---

## 1. Diagnóstico: onde o projeto real permite extensão

O WACRM é um template. Ele **não tem sistema de plugins**, nem registro de
módulos, nem barramento de eventos interno. A estrutura sugerida
(`src/custom`, `src/modules/br`, `src/integrations`, `src/billing`) precisa ser
adaptada a três restrições do projeto real:

1. **O Next.js exige que rotas e páginas fiquem em `src/app/`.** Código de
   domínio pode viver fora, mas cada endpoint ou página precisa de um arquivo
   em `src/app`. Daí a convenção do route group `(fork)` (ver §3.3).
2. **Boa parte da lógica roda no navegador direto contra o Supabase** (CRUD de
   pipelines, deals, contatos e criação de broadcasts). Nesses casos a extensão
   natural é **no banco** (tabelas novas, RLS, triggers, views), não em TS.
3. **Os pontos “quentes” do core** (`webhook/route.ts`, `send-message.ts`,
   engines, `messages/*.json`, migrations) são justamente os que o upstream mais
   altera. Qualquer edição neles vira conflito recorrente.

### 1.1 Pontos de extensão que já existem (custo zero de conflito)

| Ponto | Como usar | Toca o core? |
|---|---|---|
| **Webhooks de saída** (`message.received`, `message.status_updated`, `conversation.created`) assinados com HMAC | integrações fora do processo (worker, n8n, serviço próprio) | Não |
| **API pública `/api/v1`** + API keys com scopes | integrações e automações externas; MCP server | Não |
| **Rotas novas** do App Router (arquivos novos) | endpoints e páginas do fork em `src/app/**/(fork)/` | Não (arquivos novos) |
| **Route group dentro de `(dashboard)`** | página nova herda `DashboardShell`/layout automaticamente | Não |
| **Banco**: tabelas/views/funções novas, `is_account_member()` para RLS, triggers em tabelas do core | billing, BR, auditoria, quotas, relatórios | Não (migrations novas) |
| **Supabase Realtime** nas tabelas publicadas | UI reativa do fork | Não |
| **Variáveis de ambiente** | configuração por deploy | Não |
| **Componentes/hooks do core** (`@/components/ui/*`, `useAuth`, `useCan`) | UI do fork reaproveita o design system | Não (só importa) |
| **Engines de automação/flows** via `send_webhook` | integrações acionadas por automação | Não |

### 1.2 Pontos de extensão que **não** existem (precisarão de patch mínimo quando o primeiro módulo pedir)

| Necessidade futura | Arquivo do core | Patch previsto |
|---|---|---|
| Item no menu lateral | `src/components/layout/sidebar.tsx` (`navItems`) | 1 import + spread `...forkNavItems` |
| Seção em Settings | `src/components/settings/settings-sections.ts` + `settings/page.tsx` | registro de seções do fork |
| Proteção de páginas novas no middleware | `src/middleware.ts` (`protectedPaths`) | concatenar `FORK_PROTECTED_PATHS` |
| Hook interno em eventos (ex.: contar uso para billing) | `src/lib/webhooks/deliver.ts` (`dispatchWebhookEvent`) | 1 chamada a `emitForkEvent(...)` |
| Quota antes de enviar/broadcast/IA | `send-message.ts`, `broadcast-core.ts`, `ai/auto-reply.ts` | 1 chamada `await assertQuota(...)` por ponto |
| Normalização de telefone BR | `src/lib/whatsapp/phone-utils.ts` (`phonesMatch`) | delegar para `@/modules/br` **ou** enviar a correção ao upstream (preferível) |

Regra: **nenhum desses patches é criado antecipadamente.** Cada um entra junto
com a primeira funcionalidade que precisa dele, segue o formato da §4 e,
quando fizer sentido, vira PR para o upstream (um “extension point” genérico
tem boa chance de ser aceito).

---

## 2. Camadas adaptadas ao projeto

```
┌───────────────────────────────────────────────────────────────┐
│ fork-app      src/app/**/(fork)/…   rotas e páginas do fork     │  composição
├───────────────────────────────────────────────────────────────┤
│ integrations  src/integrations/<x>  Asaas, RD, Bling, Meta ES…  │  mais externo
├───────────────────────────────────────────────────────────────┤
│ modules       src/modules/br        regras brasileiras          │
├───────────────────────────────────────────────────────────────┤
│ billing       src/billing           planos, assinaturas, quotas │
├───────────────────────────────────────────────────────────────┤
│ custom        src/custom            fachada do core, seams,     │  camada de produto
│                                     i18n do fork, guarda        │
├───────────────────────────────────────────────────────────────┤
│ core          todo o resto (upstream WACRM)                     │
└───────────────────────────────────────────────────────────────┘
```

Diferenças em relação ao esboço inicial, e por quê:

- **Billing fica abaixo dos módulos e integrações, não ao lado.** Módulos BR e
  integrações precisam consultar plano/quota; o billing não deve conhecer nenhum
  dos dois. Os **gateways de pagamento são integrações** (`src/integrations/payments/*`)
  que implementam uma interface definida em `src/billing`.
- **`src/modules/` em vez de `src/br/`.** Deixa lugar para outros módulos de
  produto (ex.: `modules/helpdesk`) com as mesmas regras.
- **`fork-app` é uma camada própria.** As rotas do fork precisam morar em
  `src/app`; o route group `(fork)` as identifica sem mudar URLs.
- **`src/custom` não contém feature nenhuma.** Contém só o que liga o fork ao
  core: a fachada, os seams, o registro de patches e o i18n do fork.

### 2.1 Regras de dependência (verificadas no CI)

| De ↓ / pode importar → | core | custom | billing | modules | integrations | fork-app |
|---|---|---|---|---|---|---|
| **core** | ✅ | só seams registrados | ❌ | ❌ | ❌ | ❌ |
| **custom** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **billing** | via fachada | ✅ | ✅ | ❌ | ❌ | ❌ |
| **modules** | via fachada | ✅ | ✅ | ✅ | ❌ | ❌ |
| **integrations** | via fachada | ✅ | ✅ | ✅ | ✅ | ❌ |
| **fork-app** | via fachada | ✅ | ✅ | ✅ | ✅ | ✅ |

“Via fachada” quer dizer que, fora de `src/custom`, código do fork **não importa
`@/lib/**` nem `@/app/**`** do core; usa `@/custom/core/server` ou
`@/custom/core/client`. Exceções liberadas (presentacionais, mudam pouco):
`@/components/**`, `@/hooks/**`, `@/types`, `@/lib/utils`.

Quem garante isso é o teste `src/custom/architecture.test.ts`, que roda em
`npm test` e no CI (`ci.yml`) sem nenhuma configuração extra. Confirmei que ele
falha com arquivos de prova em quatro casos: core importando o fork, módulo
importando integração, módulo importando `@/lib` direto e marcador
`FORK-PATCH` não registrado.

### 2.2 Fachada do core (anti-corruption layer)

`src/custom/core/server.ts` e `src/custom/core/client.ts` **só re-exportam** APIs
do core: auth/tenancy (`getCurrentAccount`, `requireRole`, `requireApiKey`),
clientes Supabase (`createServerSupabase`, `supabaseAdmin`,
`createBrowserSupabase`), `getT`, rate limit, `useAuth`, `useCan`.

- Quando um merge do upstream renomear ou mover algo (ex.: o upstream unificar
  as cinco cópias de `supabaseAdmin`), o conserto é **uma linha na fachada**, não
  um grep em todo o fork.
- Exports novos entram quando um módulo precisar deles pela primeira vez.
- Nenhuma lógica na fachada. Adaptações com semântica própria viram módulo com teste.

### 2.3 Duplicação

- O core tem duplicações conhecidas: cinco helpers `supabaseAdmin()`, três
  caminhos de envio, duas engines. **O fork não as corrige no core**, porque
  cada correção abriria pontos de conflito. Elas entram como candidatas a PR
  upstream (§6).
- **O fork não cria cópias novas.** Todo acesso passa pela fachada, que aponta
  para uma única implementação do core (`@/lib/flows/admin-client` no caso do
  admin client). Se o fork precisar de comportamento diferente, ele vai para um
  módulo, nunca para uma cópia modificada de arquivo do core.

---

## 3. Convenções por tipo de artefato

### 3.1 Código TypeScript

| O quê | Onde |
|---|---|
| Configuração e seams transversais do produto | `src/custom/` |
| Domínio BR | `src/modules/br/` |
| Planos, assinatura, quota | `src/billing/` |
| Adapter de terceiro | `src/integrations/<categoria>/<nome>/` |
| Rotas e páginas | `src/app/**/(fork)/` |

### 3.2 Banco de dados (migrations)

- **Nunca editar** migration do upstream (`001`–`0NN`).
- Migrations do fork: **`supabase/migrations/9NN_<camada>_<nome>.sql`**
  (`900_custom_*`, `910_billing_*`, `920_br_*`, `930_integrations_*`…).
  - O Supabase CLI aplica em ordem de nome de arquivo. Com o prefixo `9`, num
    banco novo o core inteiro é aplicado **antes** do fork, a ordem natural de
    camadas.
  - Num banco existente, migrations novas do upstream (`043`, `044`…) chegam
    depois das `9NN` já aplicadas. O CLI avisa sobre versões fora de ordem;
    use `supabase db push --include-all`. Isso é seguro porque **todas as
    migrations do upstream e do fork são idempotentes** (convenção do projeto:
    `IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `ON CONFLICT`). O fork precisa
    manter essa convenção.
  - Uma migration do fork **não pode depender de alterações futuras do upstream**
    e deve tolerar ser reaplicada depois delas.
- Tabelas do fork ficam em `public` com prefixo da camada (`billing_*`, `br_*`,
  `int_*`), `account_id NOT NULL REFERENCES accounts ON DELETE CASCADE` e
  RLS com `is_account_member(account_id, …)`, igual ao core. Schema separado
  exigiria expor o schema no PostgREST e duplicar helpers; não vale o custo agora.
- **Alterar tabela do core** (coluna nova, trigger) é permitido numa migration
  `9NN`, mas conta como patch do core: registrar na §4 com o tipo `db`.
- O CI `migrations.yml` já faz replay de tudo num banco limpo; ele valida a
  ordem core → fork em todo PR que mexer em `supabase/**`.

### 3.3 Rotas e páginas

- API: `src/app/api/(fork)/<camada>/<recurso>/route.ts` → URL `/api/<camada>/<recurso>`
  (ex.: `/api/billing/checkout`, `/api/br/cep`). O route group não aparece na URL.
- Páginas autenticadas: `src/app/(dashboard)/(fork)/<pagina>/page.tsx` → herdam o
  shell do dashboard.
- Prefixos de URL por camada evitam colisão com rotas futuras do upstream. Se
  houver colisão mesmo assim, o build do Next falha (“conflicting routes”), ou
  seja, ela aparece no merge, não em produção.
- O arquivo de rota é só composição: valida input, chama o módulo, responde.

### 3.4 Strings (i18n): seam P-002, já implementado

- Strings do fork vão em `src/custom/i18n/messages/{en,pt}.json`, **nunca** em
  `messages/*.json` (o upstream edita esses arquivos em quase todo release).
- Namespaces reservados: `Custom`, `Br`, `Billing`, `Integrations`. Os testes
  garantem namespace válido, ausência de colisão com o core, paridade en↔pt e
  que o merge não altera nenhuma chave do core.
- Uso igual ao core: `useTranslations('Br.phone')` nos componentes, `getT('Billing')` no servidor.
- O inglês é o fallback por chave para o fork (mesma regra do core).
- Os dois catálogos do fork (en e pt) entram no bundle do cliente via
  `translate.ts`. Com os arquivos pequenos isso é aceitável; revisar se crescerem.
- **Mudar textos do core** (rebranding, termos BR): só pelo mecanismo
  explícito de **overrides** (`src/custom/i18n/overrides/<locale>.json`),
  implementado com a marca (P-003). Cada chave sobrescrita precisa existir no
  core e fica presa ao texto em inglês que substitui (baseline no teste), então
  uma mudança do upstream nessa chave falha o CI para revisão. A palavra
  `wacrm` em textos do core é trocada pelo nome da marca automaticamente.
  Detalhes em [`docs/BRANDING.md`](./BRANDING.md) §3.

### 3.5 Configuração

- Env vars do fork com prefixo próprio (`SAAS_*`, `BILLING_*`, `BR_*`) e
  documentadas em `.env.local.example` **num bloco no fim do arquivo** (reduz o
  conflito com o upstream).
- Configuração por tenant: tabelas do fork (`billing_*`, `br_*`), nunca colunas
  novas em `accounts`/`profiles` sem registrar como patch `db`.

---

## 4. Registro de alterações no core

Todo arquivo do upstream alterado pelo fork precisa ter:

1. uma entrada em `src/custom/core-patches.ts` (id, arquivos, seams, status upstream);
2. um comentário `// FORK-PATCH(P-NNN): motivo` em cada trecho alterado;
3. uma linha na tabela abaixo.

O teste de arquitetura falha se houver marcador sem registro, registro sem
marcador ou import do core para o fork fora de um seam registrado.
`scripts/fork/core-diff.sh` lista tudo o que difere do upstream.

| ID | Tipo | Arquivos | Motivo | Status upstream |
|---|---|---|---|---|
| **P-001** | código + i18n (em massa, sem marcadores) | 104 arquivos do commit `fbabe3f` (lista abaixo) | i18n das strings hardcoded de UI, validadores e API | **propor upstream**: é a maior fonte de conflito hoje |
| **P-002** | seam | `src/i18n/request.ts` (2 linhas), `src/lib/i18n/translate.ts` (3 trechos) | carregar o catálogo i18n do fork sobre o do core | fork-only |
| **P-003** | seam + infra | `src/app/layout.tsx`, `src/app/icon.tsx`, `src/components/layout/sidebar.tsx`, `src/app/(auth)/layout.tsx`, `src/app/join/layout.tsx`, `src/app/api/account/invitations/route.ts`, `src/lib/whatsapp/meta-error-explain.ts`, `Dockerfile`, `docker-compose.yml`, `.env.local.example` | identidade do produto via `src/custom/brand/config.ts` ([`BRANDING.md`](./BRANDING.md)) | fork-only (o fallback `https://wacrm.tech` do convite poderia ir upstream) |
| **P-004** | seam + call sites | loaders i18n, `vitest.config.ts`, `dashboard-shell`, `settings/page`, `lib/automations/engine.ts`, `lib/currency.ts`, `lib/contacts/parse-contact-csv.ts` e ~35 componentes com datas/números/valores (lista em `core-patches.ts`) | PT-BR padrão, locale/fuso/moeda por tenant (migration 900), formatação via `src/custom/locale/format.ts`, entrada `1.500,50`, CSV do Excel pt-BR ([`LOCALIZATION.md`](./LOCALIZATION.md)) | **propor upstream** a parte de bugs (`en-US` fixo, padrões do `date-fns` em inglês, fuso do servidor no `time_of_day`); o padrão pt-BR é fork-only |
| **P-005** | seam | `contact-form.tsx`, `contact-detail-view.tsx`, `lib/whatsapp/wa-identity.ts` (`contactHandle`), `lib/contacts/parse-contact-csv.ts`, `contacts/page.tsx`, `inbox/conversation-list.tsx` | CPF/CNPJ, razão social e endereço (`br_contact_profiles`, migration 901), telefone brasileiro → E.164, máscara `+55 (21) …` ([`BRAZILIAN_CONTACTS.md`](./BRAZILIAN_CONTACTS.md)) | fork-only |
| **P-006** | seam | `components/settings/settings-sections.ts`, `settings/page.tsx`, `api/whatsapp/media/[mediaId]/route.ts` | seção “Organização” (organização = `accounts`; status + `br_account_profiles`, migration 902) e `Cache-Control: private` na mídia autenticada; correções de isolamento em SQL na migration 903 ([`TENANCY.md`](./TENANCY.md)) | **propor upstream** a 903 (RPCs expostas, referências entre tenants, storage listável) e o cache; a organização é fork-only |
| **P-007** | seam | `src/middleware.ts` (`/onboarding` protegido), `dashboard-shell.tsx` (`OnboardingGate`) | assistente de configuração inicial em `/onboarding` (`onboarding_progress`, migration 904) ([`ONBOARDING.md`](./ONBOARDING.md)) | fork-only |
| **P-008** | seam + call sites | `instrumentation.ts` (novo), `api/whatsapp/{config,config/verify-registration,broadcast,media,react,templates/*,webhook}`, `lib/whatsapp/{broadcast-core,broadcast-resume,send-message}.ts`, `settings/whatsapp-config.tsx`, `inbox/page.tsx`, `settings/page.tsx`, `types/index.ts` | segredos do WhatsApp só no servidor (privilégio por coluna, migration 905), Business ID/PIN, log de conexão, WABA conferida no webhook, card de status, redação de logs ([`WHATSAPP_SAAS.md`](./WHATSAPP_SAAS.md)) | **propor upstream** a exposição de ciphertext e a checagem de WABA |
| **P-009** | seam + call sites | `middleware.ts` (`/platform`), `(dashboard)/layout.tsx` (aviso de suspensão), `lib/auth/api-context.ts`, `lib/{automations,flows}/meta-send.ts`, `api/whatsapp/webhook` | suspensão efetiva (RLS via `is_account_member` na 906 + caminhos da service role via `src/custom/tenancy`) e painel `/platform` ([`PLATFORM_ADMIN.md`](./PLATFORM_ADMIN.md)) | fork-only |
| **P-010** | seam + call sites | `lib/auth/{account,api-context}.ts`, `lib/ai/config.ts`, `lib/api/v1/contacts.ts`, `api/account/{invitations,api-keys}`, `api/automations` (+`duplicate`), `api/whatsapp/config`, `contacts/{contact-form,import-modal}.tsx`, `settings/page.tsx`, `agents/page.tsx` | planos SaaS: limites e recursos lidos por chave do banco via `src/billing/entitlements` (migration 907), 403 padronizado ([`PLANS.md`](./PLANS.md)) | fork-only |
| **P-011** | seam | `(dashboard)/contacts/page.tsx`, `(dashboard)/automations/page.tsx` | aviso de limite atingido com sugestão de upgrade (`UsageService`, migration 908 — [`USAGE.md`](./USAGE.md)) | fork-only |
| **P-012** | seam | `.env.local.example` | variáveis `BILLING_*` da abstração de pagamentos (`BillingProvider`, gateway mock, migration 909 — [`BILLING.md`](./BILLING.md)); nenhum código do core alterado | fork-only |
| **P-013** | seam | `.env.local.example` | variáveis `ASAAS_*` do primeiro gateway real (adaptador em `src/integrations/payments/asaas`, migration 910 — [`ASAAS.md`](./ASAAS.md)); nenhum código do core alterado | fork-only |
| **P-014** | seam | `meta-api.ts`, `send-message.ts`, `broadcast-core.ts`, `automations/{engine,meta-send}.ts`, `flows/meta-send.ts`, `auth/account.ts`, `api/v1/respond.ts`, rotas `whatsapp/{webhook,broadcast,react,config}`, `automations` (+duplicate), `account/api-keys`, `v1/webhooks`, `(dashboard)/layout.tsx`, `.env.local.example` | política de inadimplência: só chamadas a `assertTenantCan`/`tenantCan`/`assertPhoneCan` e o mapeamento da recusa para 403 ([`DELINQUENCY.md`](./DELINQUENCY.md)); substitui o bloqueio total do P-009, que ficou só no `middleware.ts` | fork-only |
| — | infra (sem marcador) | `package.json` (`test:db`), `.github/workflows/fork-db-tests.yml` (arquivo novo), `supabase/tests/` | testes pgTAP de isolamento (`npm run test:db`) | n/a |
| — | ferramenta | `AGENTS.md` | reescrito automaticamente pelo `next dev` (o próprio arquivo pede que seja commitado) | n/a |

### P-001: arquivos (commit `fbabe3f`, 104 arquivos, +3771/−812)

Contexto: troca strings literais por `getT()`/`useTranslations` e adiciona
`src/lib/i18n/translate.ts`. **Muda o texto de respostas de API** (ex.:
`rateLimitResponse`), que passam a seguir o locale do deploy. Isso precisa ser
dito no PR upstream.

<details>
<summary>Lista completa</summary>

- `messages/en.json`, `messages/es.json`, `messages/ko.json`, `messages/pt.json` (~700 linhas cada)
- `src/app/layout.tsx`
- `src/app/(dashboard)/`: `automations/page.tsx`, `broadcasts/[id]/page.tsx`, `broadcasts/new/page.tsx`, `broadcasts/page.tsx`, `contacts/page.tsx`, `flows/page.tsx`, `pipelines/page.tsx`
- `src/app/api/account/`: `api-keys/[id]/route.ts`, `api-keys/route.ts`, `invitations/[id]/route.ts`, `invitations/route.ts`, `members/[userId]/route.ts`, `members/route.ts`, `route.ts`, `transfer-ownership/route.ts`
- `src/app/api/ai/`: `autoreply/[conversationId]/route.ts`, `config/route.ts`, `draft/route.ts`, `knowledge/[id]/route.ts`, `knowledge/reindex/route.ts`, `knowledge/route.ts`, `playground/route.ts`, `test/route.ts`, `usage/route.ts`
- `src/app/api/automations/`: `[id]/duplicate/route.ts`, `[id]/route.ts`, `route.ts`
- `src/app/api/contacts/[id]/tags/route.ts`
- `src/app/api/flows/`: `[id]/activate/route.ts`, `[id]/route.ts`, `[id]/runs/route.ts`, `route.ts`, `templates/route.ts`
- `src/app/api/invitations/[token]/redeem/route.ts`
- `src/app/api/quick-replies/`: `[id]/route.ts`, `route.ts`
- `src/app/api/whatsapp/`: `broadcast/[id]/resume/route.ts`, `broadcast/route.ts`, `config/route.ts`, `config/verify-registration/route.ts`, `media/[mediaId]/route.ts`, `react/route.ts`, `send/route.ts`, `templates/[id]/route.ts`, `templates/submit/route.ts`, `templates/sync/route.ts`
- `src/components/`: `automations/automation-builder.tsx`, `broadcasts/step2-select-audience.tsx`, `broadcasts/step3-personalize.tsx`, `contacts/contact-detail-view.tsx`, `contacts/contact-form.tsx`, `contacts/import-modal.tsx`, `dashboard/response-time-chart.tsx`, `flows/flow-editor-state.tsx`, `flows/forms/node-config-form.tsx`, `inbox/message-bubble.tsx`, `inbox/message-composer.tsx`, `inbox/message-thread.tsx`, `inbox/template-picker.tsx`, `interactive/interactive-builder.tsx`, `pipelines/pipeline-settings.tsx`, `settings/appearance-panel.tsx`, `settings/invite-member-dialog.tsx`, `settings/password-form.tsx`, `settings/profile-form.tsx`, `settings/quick-replies-manager.tsx`, `settings/sessions-card.tsx`, `settings/template-manager.tsx`, `settings/whatsapp-config.tsx`, `ui/dialog.tsx`, `ui/gated-button.tsx`, `ui/sheet.tsx`
- `src/hooks/use-broadcast-sending.ts`
- `src/lib/`: `ai/embeddings.ts`, `ai/providers/anthropic.ts`, `ai/providers/openai.ts`, `ai/providers/shared.ts`, `auth/account.ts`, `automations/engine.ts`, `automations/meta-send.ts`, `automations/templates.ts`, `automations/validate.ts`, `contacts/tag-write.ts`, `currency.ts`, `dashboard/queries.ts`, `flows/meta-send.ts`, `flows/templates.ts`, `flows/validate.ts`, `i18n/translate.ts` (novo), `i18n/translate.test.ts` (novo), `media/download.ts`, `rate-limit.ts`, `storage/upload-media.ts`, `template-status.ts`, `whatsapp/conversation-scope.ts`, `whatsapp/meta-api.ts`, `whatsapp/template-header-handle.ts`, `whatsapp/template-send-builder.ts`, `whatsapp/template-validators.ts`

</details>

---

## 5. Como fazer merge do upstream

### 5.1 Configuração única (já feita neste clone)

```bash
git remote add upstream https://github.com/ArnasDon/wacrm.git
git config rerere.enabled true      # reaproveita resoluções de conflito repetidas
git config merge.conflictstyle zdiff3
```

### 5.2 Cadência

- **Pelo menos a cada 2 semanas**, e **imediatamente** quando sair release ou
  correção de segurança no upstream (acompanhar Releases/Watch do repositório).
  Merges pequenos e frequentes custam bem menos que merges grandes e raros.
- O upstream não publica tags hoje. Registrar o SHA mergeado na mensagem do commit.

### 5.3 Procedimento

```bash
git fetch upstream
git switch main && git pull --ff-only origin main

# 1. Prever conflitos antes de começar
scripts/fork/core-diff.sh                 # seção "touched by BOTH sides"
git log --oneline HEAD..upstream/main     # o que está chegando
git diff HEAD...upstream/main --stat -- supabase/migrations   # migrations novas?

# 2. Merge (não rebase: preserva o histórico já publicado do fork)
git switch -c sync/upstream-$(date +%Y%m%d)
git merge --no-ff upstream/main -m "sync: merge upstream/main @ $(git rev-parse --short upstream/main)"

# 3. Resolver conflitos (§5.4), depois validar
npm ci
npm run lint && npm run typecheck
TZ=UTC npm test           # inclui o teste de arquitetura e o de i18n do fork
npm run build
scripts/fork/core-diff.sh # confirmar que só sobraram os patches registrados

# 4. Banco: aplicar em staging antes de produção
supabase db push --include-all            # migrations novas do upstream são idempotentes

# 5. PR sync/* → main, smoke test manual (inbox, envio, webhook, broadcast)
```

O merge acontece **numa branch `sync/*`** de propósito: é a única exceção ao
fluxo direto em `main`, porque um merge do upstream pode precisar de vários
commits de ajuste antes de ficar verde.

### 5.4 Resolvendo conflitos

| Onde | Regra |
|---|---|
| `src/custom`, `src/billing`, `src/modules`, `src/integrations`, `(fork)`, `9NN_*.sql` | não deveriam conflitar; se conflitarem, alguém quebrou a convenção |
| Arquivo com `FORK-PATCH` | aceitar a versão do upstream e **reaplicar** o patch (o registro diz exatamente o quê e por quê) |
| `messages/*.json` (P-001) | aceitar as chaves novas do upstream e manter as traduções do fork; depois rodar `src/i18n/messages.test.ts` (paridade) |
| Arquivos do P-001 | preferir o código do upstream; reaplicar só a troca de string por `t()` |
| `package.json` / `package-lock.json` | aceitar o upstream e regenerar o lock com `npm install`; o fork não adiciona dependências sem registrar |
| Fachada quebrada (export sumiu ou mudou) | corrigir **só** `src/custom/core/*`; o typecheck aponta |
| Teste de arquitetura falhando | o upstream pode ter criado um arquivo que casa com uma convenção do fork; renomear do lado do fork |

### 5.5 Quando o upstream mudar algo estrutural

Exemplos: membership N:N, vários números por conta, fila de envio. Abrir uma
issue interna, ler o diff inteiro e ajustar a fachada e os módulos **antes** do
merge, numa branch própria. Nunca resolver isso “no meio” do conflito.

---

## 6. Contribuir de volta (reduz o fork)

Cada mudança mandada e aceita no upstream é um patch a menos para manter.
Candidatos, por ordem:

1. **Correções de segurança** do `docs/SAAS_BR_ANALYSIS.md` §25 (funções DEFINER
   expostas a `anon`, storage público, cache da mídia): seguir `.github/SECURITY.md`.
2. **P-001 (i18n)**: dividir em PRs por área para facilitar a revisão.
3. **Matching de telefone** (`phonesMatch` com últimos 8 dígitos): é bug, não
   regra BR; tem boa chance de ser aceito com testes de DDD/9º dígito.
4. **Extension points genéricos** (§1.2): registro de itens de navegação, de seções
   de settings, `protectedPaths` extensível, hook de evento interno.
5. **Unificar `supabaseAdmin()`** e os testes independentes de TZ/locale.

Ao ser aceito, remover o patch do registro e do código do fork no merge seguinte.

---

## 7. Checklist para todo PR do fork

- [ ] Código novo está numa camada do fork (`src/custom`, `src/billing`, `src/modules/*`, `src/integrations/*`, `(fork)`)?
- [ ] Mexeu em arquivo do core? → `FORK-PATCH(P-NNN)` + `core-patches.ts` + tabela da §4. Dá para virar PR upstream?
- [ ] Imports do core passam pela fachada (`@/custom/core/*`)?
- [ ] Strings novas em `src/custom/i18n/messages/*.json` (namespaces do fork), em en e pt?
- [ ] Migration nova `9NN_*`, idempotente, com RLS `is_account_member`?
- [ ] Toda query com `supabaseAdmin()` filtra por `account_id`?
- [ ] `npm run lint && npm run typecheck && TZ=UTC npm test && npm run build` passam?

---

## 8. O que foi implementado nesta etapa

Estrutura mínima, sem funcionalidade nova e sem mudança de comportamento:

| Arquivo | Tipo | Conteúdo |
|---|---|---|
| `src/custom/README.md`, `src/billing/README.md`, `src/modules/br/README.md`, `src/integrations/README.md` | novo | propósito e regras de cada camada |
| `src/custom/core/server.ts`, `src/custom/core/client.ts` | novo | fachada do core (só re-exports) |
| `src/custom/core-patches.ts` | novo | registro P-001, P-002 |
| `src/custom/architecture.test.ts` | novo | guarda de camadas, fachada e patches |
| `src/custom/i18n/merge.ts` + `merge.test.ts` + `messages/{en,pt}.json` (vazios) | novo | seam de i18n do fork |
| `src/i18n/request.ts` | **core, P-002** | `withCustomMessages(locale, messages)` |
| `src/lib/i18n/translate.ts` | **core, P-002** | o mesmo, mesclado uma vez por processo |
| `scripts/fork/core-diff.sh` | novo | diff do core vs upstream, marcadores e conflitos prováveis |
| `docs/UPSTREAM_STRATEGY.md` | novo | este documento |
| remote `upstream` + `rerere` | config git local | §5.1 |

**Comportamento:** com os catálogos do fork vazios, `withCustomMessages`
devolve o próprio objeto do core (um teste garante que todas as chaves do core
ficam idênticas nos 4 locales). As outras peças são arquivos novos que nada
importa ainda.

Deliberadamente **não** foi criado: patches de navegação, settings, middleware,
eventos internos e quota (§1.2). Eles entram com a primeira feature que precisar.
