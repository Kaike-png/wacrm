# Auditoria da fundação do MVP (billing, planos, tenants, permissões, WhatsApp, admin)

> Data: 2026-10-06 · Escopo: tudo o que o fork adicionou até a etapa de
> inadimplência (migrations 900–911, `src/custom`, `src/billing`,
> `src/modules`, `src/integrations`, rotas `(fork)` e os patches P-001…P-014
> no core). Nenhuma funcionalidade de produto nova foi adicionada; as
> correções estão na migration **912** e em arquivos do fork.

## Resumo executivo

**Classificação geral: aceitável** (era *frágil* antes das correções desta etapa).

- **Isolamento entre tenants: sólido.** Nenhuma rota usa `account_id` vindo do
  corpo/query; toda consulta com service role filtra por `account_id` ou
  confere a posse antes; RLS + triggers de referência cruzada (903) + suíte
  pgTAP de 134 asserções. Nenhum P0 encontrado.
- **Billing tinha falhas reais de consistência**, todas corrigidas e cobertas
  por teste: limite de plano estourável por concorrência (demonstrado: 10
  automações com limite 5), confirmação de pagamento não atômica (falha no
  meio deixava o pagamento "pago" e o plano sem trocar, e o retry do gateway
  não corrigia), trial sem fim, máquina de estados da organização sem
  validação, webhook do gateway *mock* forjável em produção.
- **Pendências (P2/P3)** concentram-se no código do core (mensagens de erro
  cruas, segredos cifrados legíveis por qualquer membro) e em dívida de
  compatibilidade com o upstream. Nenhuma bloqueia o próximo módulo. As do
  webhook da Meta (F-19, F-20) foram resolvidas em seguida, antes do
  Embedded Signup.

## Separação de camadas

| Camada | Onde | Estado |
|---|---|---|
| WACRM core | todo o resto | alterado só via `FORK-PATCH` registrado (0 divergências marcador × registro) |
| Customizações de produto | `src/custom` (marca, i18n, locale, tenancy, whatsapp, export) | ok; teste de arquitetura impede imports proibidos |
| Billing / planos / uso | `src/billing` (`payments/`, `providers/`, `entitlements`, `usage`, `access-policy`) | ok; nenhum nome de gateway fora de `providers/` (teste) |
| Gateway Asaas | `src/integrations/payments/asaas` | ok; único lugar que fala com a API do Asaas |
| Tenant | `accounts` (status/trial) + `br_account_profiles` + `src/custom/tenancy` | ok |
| Administração | `src/modules/platform` + funções `platform_*` (service role) | ok |
| Meta / WhatsApp SaaS | `src/custom/whatsapp` + P-008 no core | **lógica inline demais no core** (`whatsapp/config/route.ts`, webhook) — ver UPSTREAM_STRATEGY §9 |
| Regras brasileiras | `src/modules/br` | ok |

Regras de plano: **nenhuma comparação com código de plano** no código
(`plan === 'pro'`); tudo passa por chave de recurso (`billing_feature_value`,
`assertWithinLimit`, `assertFeatureEnabled`, `UsageService.canUseFeature`) e
há teste que impede regressão. Plano novo = linhas em `billing_plans` /
`billing_plan_features`, sem código.

Regras de status: uma matriz (`access-policy.ts` ⇄ `account_status_blocks`)
para o que cada status bloqueia, e agora uma segunda (`ACCOUNT_STATUS_TRANSITIONS`
⇄ `account_status_transition_allowed`) para as transições — ambas com teste
de sincronia TS/SQL.

## Findings

Legenda de status: **Corrigido** (com teste) · **Pendente** · **Aceito** (decisão documentada).

| ID | Área | Sev. | Problema | Recomendação | Status |
|---|---|---|---|---|---|
| F-01 | Limites / concorrência | **P1** | Os triggers de limite contavam sem lock: N requisições simultâneas criando "o último item" passavam todas (medido: 6 inserts simultâneos com 4 automações e limite 5 → 10; 3 convites com 1 vaga → 4). | Lock transacional por organização+recurso antes de contar | **Corrigido** (912 `_billing_limit_lock`; `npm run test:db:race`, também no CI) |
| F-02 | Billing / transações | **P1** | `applyEffects` gravava pagamento, assinatura e status em 3 chamadas. Falha após gravar o pagamento como pago ⇒ webhook 500 ⇒ retry visto como reentrega (`prev === status`) ⇒ plano nunca trocado. | Uma função SQL transacional | **Corrigido** (912 `billing_apply_effects`) |
| F-03 | Billing / concorrência | **P1** | Dois eventos *diferentes* do mesmo pagamento (CONFIRMED + RECEIVED) processados ao mesmo tempo liam `prev = pending` e ambos estendiam o período. | Checagem otimista: status anterior do pagamento e `updated_at` da assinatura; divergência ⇒ 40001 ⇒ 500 ⇒ gateway reenvia e a regra decide de novo | **Corrigido** (912 + `BillingConflictError`; pgTAP 10× replay) |
| F-04 | Estados da organização | **P1** | `canTransition` existia só em TS, não era usado, e divergia do comportamento real (reativação restaura `trial`/`past_due`). O banco aceitava qualquer salto (ex.: `active → trial`, `cancelled → past_due`). | Máquina de estados única TS⇄SQL, trigger para qualquer escritor | **Corrigido** (912 `accounts_guard_status_transition`; teste de sincronia) |
| F-05 | Trial | **P1** | `trial_ends_at` nunca era preenchido e nada encerrava o trial: plano START grátis para sempre; só a UI olhava a data. | Data de fim no cadastro + expiração no backend | **Corrigido** (912: `billing_plans.trial_days` = 14 no plano padrão; `billing_expire_trials()` no cron diário ⇒ `past_due` ⇒ carência ⇒ `suspended`; trials existentes ganham 14 dias a partir de hoje) |
| F-06 | Gateway mock | **P1** | `POST /api/billing/webhooks/mock` funcionava em produção (o guard só valia para o provider *padrão*) e o segredo padrão é público. Qualquer registro `provider='mock'` (staging, dados antigos) podia ser marcado como pago. | Recusar mock em produção também por nome; nunca usar o segredo padrão em produção | **Corrigido** (`mockAllowed`, `mockWebhookSecret`; teste) |
| F-07 | Dependências | **P1** | `next` 16.3.5 com GHSA-vcvr-r3jv-pc5j (RCE em `next/og` `ImageResponse`), usado pelo favicon da marca. | Patch 16.3.8 | **Corrigido** (`next`/`eslint-config-next` 16.3.8, build ok) |
| F-08 | Pagamentos | P2 | Um `upsert` (ex.: `subscribe` gravando a 1ª cobrança depois de um webhook rápido) podia voltar um pagamento `paid` para `pending`. | Backstop no banco | **Corrigido** (912 `billing_payments_keep_paid`) |
| F-09 | Asaas | P2 | Falha após criar a assinatura no Asaas (sem 1ª cobrança, erro de rede, falha ao gravar no banco) deixava uma assinatura órfã que o Asaas cobraria. | Remover a assinatura recém-criada antes de propagar o erro | **Corrigido** (`createSubscription` e `BillingService.subscribe`) |
| F-10 | Asaas | P2 | `ASAAS_WEBHOOK_VERIFY=false` desligava a reconfirmação pela API também em produção (o token não assina o corpo). | Ignorar em produção | **Corrigido** |
| F-11 | Suspensão | P2 | 911 só protegia INSERT: suspenso podia reativar API key revogada (UPDATE direto via PostgREST), trocar o número do WhatsApp e ligar a resposta automática de IA. | Guardas também nos UPDATEs que recriam integração/automação | **Corrigido** (912 §7; pgTAP) |
| F-12 | Admin / reativação | P2 | Reativar uma suspensão **por cobrança** restaurava o status de uma suspensão antiga *da equipe* (podia voltar a `trial`). | Considerar a última suspensão de qualquer origem | **Corrigido** (912 `platform_set_account_status`; pgTAP) |
| F-13 | Logs / LGPD | P2 | Redação global cobria segredos, mas não CPF/CNPJ, e-mail e telefone; chaves como `webhookToken`/`asaas_api_key` escapavam. Ex.: `send-message.ts:448` loga telefone; erros 23505 do Postgres trazem `Key (phone)=(…)`. | Máscara de dados pessoais no console + chaves secretas com prefixo | **Corrigido** (`maskPersonalData` só na saída de console; teste) |
| F-14 | Webhook gateway | P3 | Limite de 512 KB só pelo `Content-Length`; corpo *chunked* era lido inteiro. | Leitura com contador | **Corrigido** (testado: 700 KB chunked ⇒ 413) |
| F-15 | Admin | P3 | Mutação do painel sem `Origin` passava sem checagem de origem. | Recusar quando o navegador marca `Sec-Fetch-Site` cross-site | **Corrigido** (+ testes de autorização do painel) |
| F-16 | Onboarding | P3 | "Pular tudo" ou `?step=done` marcava o onboarding como concluído sem o passo obrigatório (organização). | `finish()` só conclui com os passos obrigatórios | **Corrigido** (teste) |
| F-17 | Onboarding | P3 | Usuário sem organização (trigger de signup falhou) ficava num spinner infinito em `/onboarding`. | Mensagem com saída | **Corrigido** (`unlinked`) |
| F-18 | Repositório | P2 | `supabase/.temp/` (o CLI guarda `docker.env` com chaves — hoje as chaves demo públicas), `supabase/.branches/`, `.idea/` não ignorados: um `git add .` os commitaria. | `.gitignore` | **Corrigido** |
| F-19 | WhatsApp / multi-tenant | P2 | Status da Meta eram aplicados só pelo `wamid`, em todos os tenants, antes de identificar o tenant; o fan-out pegava `.limit(1)` sem ordem. Um agente podia gravar via RLS o wamid de outro tenant e receber o `message.status_updated` dele. | Rotear a entrega primeiro e escopar as escritas pelo tenant | **Corrigido**: `src/custom/whatsapp/routing.ts` resolve o tenant (phone_number_id + WABA) antes de status e mensagens; `messages` filtradas por `conversations.account_id`, `broadcast_recipients` por `broadcasts.account_id`, fan-out só para o tenant roteado. Testes: unidade da rota, integração em banco real (wamid igual em A e B), E2E HTTP assinado no dev server |
| F-20 | WhatsApp / multi-tenant | P2 | A conferência de WABA (`entry.id`) era pulada quando o tenant não salvou `waba_id`. | Nenhuma entrega sem WABA conferida | **Corrigido**: `entry.id` obrigatório; sem `waba_id` salvo, a WABA da entrega é confirmada na Meta com o token do próprio tenant e então gravada (`waba_id` único); falha, erro da Meta ou WABA de outro tenant → descartada com log técnico (só ids) + `webhook_rejected`; recusas em cache 10 min |
| F-21 | Planos | P2 | Organização sem linha em `billing_subscriptions` cai nos padrões do catálogo (ilimitado). Acontece em contas criadas antes da 907 (2 no banco local) e se não houver plano padrão ativo. | Decisão de produto: atribuir plano às contas antigas pelo painel (o painel mostra) ou backfill explícito | **Aceito** (decisão da 907: nunca impor plano restritivo em silêncio) |
| F-22 | Cadastro (core) | P2 | O trigger de signup do upstream (017) engole qualquer erro (`EXCEPTION WHEN OTHERS`) e cria usuário sem organização. | Propor upstream; a UI agora mostra o estado (F-17) | **Pendente** (core) |
| F-23 | Segredos | P3 | `ai_configs.api_key`, `ai_configs.embeddings_api_key` e `webhook_endpoints.secret` (cifrados) são legíveis por qualquer membro (inclusive viewer) via PostgREST; `whatsapp_config` já foi corrigido na 905. | Mesmo padrão da 905 (privilégio por coluna + `has_*`) | **Pendente** |
| F-24 | Erros | P3 | ~25 rotas do core devolvem `error.message` cru do Postgres/bibliotecas (automations, flows, quick-replies, templates, verify-registration). Sem stack trace nem token, mas expõe nomes de coluna/constraint; tenant suspenso ativando flow recebe 500 `tenant_restricted` em vez do 403 amigável. | Passar por `toErrorResponse` | **Pendente** (core, P-001 já toca esses arquivos) |
| F-25 | Suspensão (defesa em profundidade) | P3 | Sem `assertTenantCan` na rota em: criar/ativar flow, PATCH `is_active` de automação, retomar broadcast, salvar config de IA. O trigger do banco recusa (backstop), mas com 500. | Adicionar a chamada nas rotas | **Pendente** |
| F-26 | WhatsApp | P3 | `GET whatsapp/config` e `verify-registration` sem checagem de papel nem rate limit (viewer dispara chamadas à Graph com o token do tenant); proxy de mídia não valida `mediaId` nem o host da URL retornada; verify token comparado com `===` e carregando todos os tenants. | `requireRole('admin')` + rate limit; validar `^\d+$` e host `*.fbsbx.com`; verify token global com `timingSafeEqual` | **Pendente** (core) |
| F-27 | Criptografia | P3 | AES-256-GCM com IV aleatório: ok. Sem versão/ID de chave no ciphertext (rotacionar `ENCRYPTION_KEY` invalida todos os tokens), sem AAD (ciphertext pode ser trocado entre linhas por quem tem escrita no banco), CBC legado sem MAC ainda aceito. | Prefixo `v1:` + keyring, `account_id` como AAD, migrar e remover CBC | **Pendente** (documentado; nenhuma descriptografia no frontend) |
| F-28 | Status (cache) | P3 | Política de status com cache de ~10 s e *fail open*: um tenant recém-suspenso ainda envia por até 10 s; se a consulta de status falhar continuamente, envia sem limite (o envio à Meta acontece antes de qualquer escrita, então trigger não segura). | Aceitável; monitorar erros `[tenancy]` no log | **Aceito** |
| F-29 | Assinatura | P3 | Dois `subscribe` simultâneos da mesma organização criam duas assinaturas no gateway; a primeira fica órfã. | Lock por organização no `subscribe` (advisory lock via RPC) ou idempotency key | **Pendente** |
| F-30 | Painel | P3 | `platform_set_plan` troca o plano sem mexer na assinatura do gateway (cliente continua pagando o preço antigo); `platform_set_plan(NULL)` apaga a linha e perde `external_id`. | Decidir: plano manual só para contas sem assinatura ativa, ou cancelar/criar no gateway | **Pendente** (decisão de produto) |
| F-31 | Audit log | P3 | O log registra ator, ação, organização, motivo, IP, data — e só existe quando a ação **teve sucesso** (mesma transação). Tentativas recusadas ficam só no log do servidor. | Se precisar de "resultado = falhou", gravar tentativas fora da transação | **Aceito** |
| F-32 | Dependências | P3 | `shadcn` em `dependencies` puxa a maioria dos alertas restantes do `npm audit` (express, @modelcontextprotocol/sdk, proxy-addr…), mas só é usado em `globals.css` no build; `sharp` < 0.35.5 (via next). Nenhuma dependência nova do fork. | Mover `shadcn` para `devDependencies` depois de checar o Dockerfile | **Pendente** |
| F-33 | Compatibilidade upstream | P2 | 89 arquivos do core alterados **sem commit**; `is_account_member` redefinida na 906 e na 911 (no-op líquido) sobrescreveria uma reescrita futura do upstream; 903 revoga EXECUTE de funções que o upstream pode re-grantar. | Ver `UPSTREAM_STRATEGY.md` §4 (patches `db`) e §9 | **Pendente** |
| F-34 | Cron | P3 | `BILLING_CRON_SECRET` cai para `AUTOMATION_CRON_SECRET` (um segredo para 3 crons); comparação revela o tamanho. | Exigir segredo próprio em produção | **Pendente** |

## Multi-tenancy (P0) — como cada entidade identifica o tenant

| Entidade | Tenant | Proteção | Prova |
|---|---|---|---|
| organizações (`accounts`) | `id` | RLS membro; status/trial/dono só service role (trigger 902); transições válidas (912) | pgTAP tenancy + foundation |
| usuários (`profiles`) | `account_id` | RLS; inserção de profile guardada (903); limite de assentos (907/912) | pgTAP |
| contatos, conversas, mensagens, deals, tags… | `account_id` | RLS `is_account_member` + `tenant_enforce_refs` (referência para outro tenant recusada) | pgTAP genérico por tabela (leitura, update, delete, mover linha) |
| WhatsApp (`whatsapp_config`) | `account_id`; `phone_number_id` e `waba_id` únicos globais | segredos só service role (905); webhook roteia por `phone_number_id` + WABA obrigatória e escopa os status pelo tenant (F-19/F-20) | pgTAP `whatsapp_secrets`, `routing*.test.ts` |
| planos / features | catálogo global | leitura para autenticados, escrita só pelo painel (DEFINER) | pgTAP billing_plans |
| `billing_subscriptions` | `account_id` (PK) | cliente lê colunas não sensíveis; escrita só service role | pgTAP |
| `billing_payments` | `account_id` | leitura só admin da organização; escrita só service role (`billing_apply_effects` confere `account_id` do payload) | pgTAP |
| `billing_webhook_events`, `billing_customers`, `billing_delinquency` | `account_id` | sem acesso de cliente | pgTAP |
| uso (`billing_usage_report`) | `account_id` | cliente só via `billing_my_usage()` (escopo `auth.uid()`) | pgTAP usage |
| API keys | `account_id` | hash único; admin; `api_enabled`; suspensão (insert e un-revoke) | pgTAP + 912 |
| automações, flows, campanhas | `account_id` | RLS + limites + guardas de suspensão | pgTAP delinquency |
| logs (`whatsapp_connection_events`, `automation_logs`) | `account_id` | RLS membro; escrita servidor | pgTAP |
| painel (`platform_*`, `platform_audit_log`) | — | sem acesso de cliente; DEFINER só service role; 404 para não-admin | pgTAP platform + `auth.test.ts` |

Cenário "Tenant A pede `/…/{id-do-B}`": todas as rotas derivam `account_id`
da sessão (ou da API key) e filtram por ele; nenhuma aceita `tenantId` do
frontend (auditoria das 67 rotas). `billing/payments/[id]` e
`billing/mock/payments/[id]` filtram `id + account_id` ⇒ 404 para id de outro
tenant.

### RLS

- Nenhuma política `USING (true)` fora do catálogo de planos (revisado e na allow-list da suíte).
- Toda política de leitura de tabela de tenant passa por `is_account_member` ou `auth.uid()` (meta-teste).
- `platform_admin` **não** é um bypass de RLS: é uma tabela sem acesso de cliente; o painel usa funções DEFINER chamadas pela service role, que conferem o ator. Bypass administrativo existente = **service role** (servidor) e as funções `platform_*` (auditadas).
- Funções DEFINER executáveis por cliente: só as da allow-list revisada (`billing_my_*`, membros/convites do upstream).

### Permissões (usuário comum × admin da organização × platform admin)

Um usuário comum ou admin da organização **não consegue**: alterar plano,
assinatura ou limites (sem grant; funções só service role), acessar o painel
(404), suspender organização, ler billing interno (customers, webhook events,
delinquency), ler tokens (privilégio por coluna) nem dados de outra
organização. Provas: `platform_admin.test.sql`, `billing_plans.test.sql`,
`billing_payments.test.sql`, `whatsapp_secrets.test.sql`,
`src/modules/platform/server/auth.test.ts` (novo).

## Billing

- **Camadas**: rota → `BillingService` → `rules.ts` (puro) → `billing_apply_effects` (SQL) / `BillingProvider` ← mock | Asaas. Nada fora de `providers/` e `integrations/` conhece o Asaas (teste).
- **Asaas**: timeout de 15 s; sem retry automático em POST (evita cobrança duplicada); 429/5xx marcados como *retryable*; chave só no header, nunca em log/erro/URL (teste com espião no console); IDs externos guardados com `UNIQUE (provider, external_id)`; cartão sem dados na aplicação (fatura hospedada); webhook com token comparado em tempo constante, conta opcional fixada e **estado relido da API**.
- **Idempotência do webhook**: claim atômico por `(provider, event_id)` (910) + checagem otimista na aplicação dos efeitos (912). Provado: 1×, 2×, 10× ⇒ um pagamento, um processamento, nenhum período estendido duas vezes (`foundation_hardening.test.sql`, `billing_webhooks.test.sql`, fluxo comercial).
- **Fora de ordem**: pagamento `paid` nunca volta a `pending/overdue` (regra + trigger); assinatura só vai a `past_due` se estava `active`; status da organização muda condicionalmente (`WHERE status = from`), então uma suspensão aplicada no meio nunca é sobrescrita; com Asaas o estado vem da API.
- **Assinatura (gateway)**: `manual | pending | active | past_due | canceled` (a grafia `canceled` foi mantida — `cancelled` já significa o status da organização). Transições decididas só em `rules.ts`.
- **Organização**: `trial → active | past_due | suspended | cancelled`; `active → past_due | suspended | cancelled`; `past_due → active | suspended | cancelled`; `suspended → active | trial | past_due | cancelled`; `cancelled → active`. Ninguém volta para `trial` a partir de `active`/`past_due`.

## Suspensão e reativação

Suspenso mantém login, leitura/escrita de dados, exportação e billing; perde
envio, campanhas, automações (incl. IA) e novas integrações — no banco
(triggers) e no servidor (choke points), não só na UI. Reativação por
pagamento: `past_due → suspended → (pagamento) → active`, testada de ponta a
ponta: envio volta, automação volta, limites continuam valendo, configuração
do WhatsApp preservada, nada apagado. A UI lê o status a cada render (cache
de 10 s no servidor, limpo na mudança).

## Trial

- Início: no cadastro (`trial_ends_at = now() + trial_days` do plano padrão; 14).
- Fim: `GET /api/billing/cron` (diário) ⇒ `billing_expire_trials()` ⇒ `past_due` (aviso + pagamento) ⇒ após `BILLING_GRACE_DAYS` (7) ⇒ `suspended`. Nada é apagado.
- Conversão: pagar qualquer plano durante o trial ou depois ⇒ `active`.
- O frontend só exibe; quem decide é o banco/cron.
- Mudar a duração: `UPDATE billing_plans SET trial_days = N WHERE is_default` (ainda não editável no painel).

## Onboarding

Fluxo: conta → organização → dados → equipe → WhatsApp (plano = padrão do
cadastro; troca de plano é na tela de assinatura). Retomável (passo salvo em
`onboarding_progress`). Corrigido: conclusão sem passo obrigatório (F-16) e
usuário sem organização (F-17). Pendente: o trigger do upstream que engole
erros (F-22).

## Transações

| Operação | Atômica? |
|---|---|
| criar organização + assinatura padrão + fim do trial | sim (triggers na mesma transação do signup) |
| confirmar pagamento + assinatura + status | **sim (912)** |
| suspender/reativar + audit log | sim (função `platform_set_account_status`) |
| suspensão automática + audit log | sim (`billing_enforce_delinquency`) |
| criar assinatura no gateway + gravar no banco | não é possível (sistema externo); compensação: remove a assinatura do gateway se a gravação falhar (F-09) |

## Banco de dados

- Únicos já existentes e conferidos: `(provider, event_id)` dos eventos, `(provider, external_id)` de pagamentos/clientes/assinaturas, `phone_number_id` e `waba_id`, hash da API key.
- Índices novos: nenhum (as consultas novas usam PK/únicos existentes).
- Cascatas: dados financeiros (`billing_payments`, `billing_customers`) caem com a organização (`ON DELETE CASCADE`), mas **organizações nunca são apagadas pelo app** (cancelamento é status). O audit log não tem FK de propósito e é imutável. `billing_webhook_events.account_id` vira NULL. Apagar usuário dono de organização é bloqueado pela FK do upstream (`accounts_owner_user_id_fkey`), o que é o comportamento desejado.

## Performance

Sem N+1 nos caminhos auditados. Uso é calculado sob demanda por `count(*)`
indexado por `account_id` (sem contadores no caminho quente do webhook).
O lock de limite só é tomado quando o recurso é limitado. O painel calcula
contagens só para a página exibida. Ponto de atenção: o Asaas relê cada
evento na API **antes** do claim, então 10 reentregas = 10 GETs (cota da API).

## Testes

| Suíte | Antes | Depois |
|---|---|---|
| vitest | 1354 | 1380 (+ 14 de integração, opt-in) — inclui F-19/F-20 |
| pgTAP | 357 em 8 arquivos | 395 em 9 arquivos (`foundation_hardening`: 38) |
| concorrência | — | `npm run test:db:race` (2 cenários; falha sem a 912) |
| fluxo comercial | — | `npm run test:flow` (17 passos do pedido, banco real + mock) |

Provado que os testes novos "mordem": sem os triggers da 912, 5 asserções do
pgTAP falham; sem o lock, o teste de concorrência acusa 10/5 e 4/2.

Não coberto por teste automatizado: navegador (UI) dos fluxos alterados;
Asaas sandbox real (só o fake HTTP); webhook real da Meta.

## Como rodar

```bash
TZ=UTC npm test              # unidade + guardas
npm run test:db              # pgTAP (isolamento, billing, painel, 912)
npm run test:db:race         # limites sob concorrência (cria e apaga uma org)
npm run test:flow            # integração no Supabase local: fluxo comercial + roteamento do webhook (F-19/F-20)
```
