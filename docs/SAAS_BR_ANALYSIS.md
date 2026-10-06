# WACRM — Auditoria técnica para o fork SaaS BR

> **Escopo:** leitura do código, das 42 migrations e do banco local de dev
> (`supabase_db_wacrm`, com as 42 migrations aplicadas). **Nenhum código foi
> alterado.** Os achados marcados como **[verificado]** foram confirmados por
> consulta SQL somente leitura no Postgres local ou pela execução de
> testes/typecheck. Os marcados como **[inferido]** vêm da leitura do código e
> não foram explorados em ambiente real.
>
> - Base: `origin/main` em `fbabe3f` (1 commit do fork — i18n, 104 arquivos —
>   sobre o upstream `ArnasDon/wacrm` v0.8.0, `45e80ad`).
> - Tamanho: ~82 mil linhas TS/TSX em `src/`, 5,4 mil linhas SQL, 92 arquivos de teste.
> - `npx tsc --noEmit`: **ok**.
> - `npx vitest run`: **1069/1074 passam**. As 5 falhas dependem do ambiente
>   (`currency.test.ts` sob `LANG=pt_BR`, `date-utils.test.ts` sob TZ −03). Com
>   `TZ=UTC LC_ALL=en_US.UTF-8` todas passam. Ou seja, os testes assumem UTC/en-US,
>   e isso importa para um produto BR (ver §23 e §24).

---

## 0. Resumo executivo

O WACRM é um **template self-hosted** (Next.js 16 + Supabase) que evoluiu de
“um tenant por usuário” para “um tenant por conta” na migration 017. A base é
madura: comentários extensos, testes unitários, idempotência no webhook, RLS em
todas as tabelas, tokens criptografados com AES-256-GCM. Mas ainda **não foi
desenhada como SaaS multi-cliente público**. As principais lacunas para um
SaaS BR:

| # | Achado | Severidade | Status |
|---|---|---|---|
| S1 | Funções `SECURITY DEFINER` sem checagem de autorização ficam **executáveis por `anon`** via PostgREST (`/rest/v1/rpc/...`): `_bcast_bump`, `recompute_broadcast_counts`, `record_webhook_failure`, `claim_ai_reply_slot`, `merge_duplicate_contacts`, `merge_duplicate_conversations`. O `REVOKE ... FROM PUBLIC` não basta no Supabase. | **Alta** | [verificado] |
| S2 | Buckets `chat-media`, `flow-media` e `avatars` são **públicos** e têm policy `SELECT` sem filtro de tenant. Qualquer pessoa com a anon key consegue **listar e baixar mídia de todos os tenants** (fotos/documentos de clientes finais espelhados do WhatsApp). | **Alta** | [verificado nas policies]; exploração não executada |
| S3 | `/api/whatsapp/media/[mediaId]` responde com `Cache-Control: public, max-age=86400` num endpoint autenticado. Atrás de CDN, isso permite vazamento entre tenants. | Média | [inferido] |
| S4 | Matching de telefone compara só os **últimos 8 dígitos** (`phonesMatch`). No Brasil, `+55 11 9xxxx-1234` e `+55 21 9xxxx-1234` viram o **mesmo contato**: mensagens de outra pessoa entram na conversa errada (dentro do mesmo tenant). | **Alta (BR)** | [inferido pela leitura direta] |
| S5 | RLS valida só o `account_id` da linha, **não a tenância das FKs** (`deals.contact_id`, `broadcast_recipients.contact_id`, `conversations.contact_id`, `tag_id`/`pipeline_id` nos configs de automação…). Os caminhos atuais com service role re-checam, mas um código novo que esqueça disso vaza. | Média | [verificado nas policies] |
| S6 | Admin consegue alterar `accounts.owner_user_id` direto via PostgREST (a policy `accounts_update` não protege colunas). | Baixa-média | [verificado na policy] |
| S7 | Rate limit **em memória por processo** (Map). Não funciona com várias réplicas nem serverless. | Média | [verificado] |
| A1 | **Uma conta = um número WhatsApp** (`UNIQUE(account_id)` em `whatsapp_config`, `UNIQUE(account_id, contact_id)` em `conversations`). | Arquitetural | [verificado] |
| A2 | **Um usuário = uma conta** (vínculo em `profiles.account_id`, sem tabela de membership). Agência/consultor com vários clientes precisa de vários e-mails. | Arquitetural | [verificado] |
| A3 | Disparo de campanha do dashboard é **orquestrado pelo navegador** (lotes de 10/s em `use-broadcast-sending.ts`). Fechar a aba interrompe o envio. Não existe fila nem agendamento real (`scheduled_at` não é usado). | Arquitetural | [verificado] |
| A4 | Triggers de automação `conversation_assigned` e `time_based` existem na UI/validação, mas **nunca são disparados** pelo backend. | Funcional | [verificado por grep] |
| A5 | Nada de billing, planos, limites/quotas, super-admin, auditoria, LGPD (export/exclusão) ou e-mails transacionais próprios. | Produto | [verificado] |

---

## 1. Estrutura geral da solução

Monólito Next.js (App Router) que fala direto com o Supabase:

```
Navegador (React 19)
 ├─ Supabase JS (anon key + JWT do usuário)  ──► PostgREST / Realtime / Storage   (protegido por RLS)
 └─ fetch /api/*  ──► Route Handlers Next.js
                         ├─ cliente "server" (cookies → JWT do usuário → RLS)
                         └─ cliente "admin" (SUPABASE_SERVICE_ROLE_KEY → ignora RLS)
Meta Cloud API ──► POST /api/whatsapp/webhook (HMAC) ──► after(): processWebhook (service role)
Cron externo   ──► GET /api/automations/cron, /api/flows/cron (x-cron-secret)
Integrações    ──► /api/v1/* (API key → service role + filtro manual por account_id)
MCP server (pacote separado em mcp-server/) ──► consome /api/v1
```

Pontos centrais:

- **Boa parte do CRUD roda no cliente**: pipelines, deals, contatos, tags,
  custom fields, notas e a criação de broadcasts usam
  `supabase.from(...).insert/update/delete` direto do browser (59 chamadas de
  escrita em `components/`, `app/(dashboard)`, `hooks/`). A segurança dessas
  operações está **inteira no RLS**.
- **Os fluxos que envolvem Meta, IA, webhooks e automações passam pelas API
  routes** e muitas vezes usam service role.
- Não há camada de serviço/repositório formal: a lógica de domínio fica em
  `src/lib/**` e é chamada tanto por API routes quanto pelo webhook.

## 2. Principais diretórios

| Caminho | Conteúdo |
|---|---|
| `src/app/(auth)` | login, signup, forgot/reset password |
| `src/app/(dashboard)` | inbox, contacts, pipelines, broadcasts, automations, flows, agents, notifications, settings, dashboard |
| `src/app/api/whatsapp/*` | webhook Meta, send, react, broadcast (+resume), config, templates (submit/sync/CRUD), media proxy |
| `src/app/api/v1/*` | API pública REST (me, contacts, conversations, messages, broadcasts, webhooks) |
| `src/app/api/account/*` | conta, membros, convites, API keys, transferência de ownership |
| `src/app/api/ai/*` | config, draft, autoreply, knowledge (CRUD/reindex), playground, test, usage |
| `src/app/api/automations/*`, `src/app/api/flows/*` | CRUD + engine manual + cron |
| `src/app/join/[token]`, `src/app/api/invitations/*` | aceite de convite |
| `src/lib/whatsapp/` (51 arquivos) | cliente Meta Graph (`meta-api.ts`, 1,2 mil linhas), envio, templates, criptografia, assinatura, identidade BSUID, espelho de mídia, broadcast core/resume |
| `src/lib/automations/`, `src/lib/flows/` | engines de automação (árvore de steps) e de flows (grafo de nós/bot) |
| `src/lib/ai/` | providers OpenAI/Anthropic, contexto, RAG (chunk/embeddings/retrieval), auto-reply, handoff, usage |
| `src/lib/auth/` | `getCurrentAccount`/`requireRole`, `requireApiKey`, roles, convites, callback |
| `src/lib/api-keys/`, `src/lib/api/v1/` | geração/hash/scopes de keys; helpers da API pública |
| `src/lib/webhooks/` | webhooks de saída (assinatura HMAC, guarda SSRF, entrega) |
| `src/lib/contacts/` | dedupe, import CSV, tags (escrita + eventos) |
| `src/components/` | UI por módulo + `ui/` (shadcn/base-ui) |
| `src/hooks/` | `use-auth` (perfil/conta), realtime, presença, envio de broadcast |
| `supabase/migrations/` | 001–042, idempotentes, aplicadas em ordem |
| `supabase/ci/verify-schema.sql` | asserções de schema rodadas no CI |
| `messages/{en,pt,es,ko}.json` | catálogos i18n (next-intl) |
| `mcp-server/` | servidor MCP standalone (npm `wacrm-mcp`) sobre `/api/v1` |
| `docs/` | public-api, mcp, multi-waba, docker, auth-emails, troubleshooting |

## 3. Stack

- **Runtime:** Node ≥ 20, Next.js **16.3.5** (App Router; `AGENTS.md` avisa que as APIs mudaram), React 19.2, TypeScript 6.
- **Backend de dados:** Supabase (Postgres 17, PostgREST, Auth/GoTrue, Realtime, Storage), `@supabase/ssr` + `supabase-js`, pgvector (HNSW, 1536 dimensões).
- **UI:** Tailwind 4, shadcn + `@base-ui/react`, lucide, sonner, recharts/tremor, `@xyflow/react` + dagre (editor de flows), dnd-kit (kanban), `opus-recorder` (áudio).
- **i18n:** next-intl, locale **global por deploy** (`NEXT_PUBLIC_APP_LOCALE`).
- **Integrações:** Meta WhatsApp Cloud API (Graph), OpenAI/Anthropic (chave do próprio cliente), OpenAI embeddings `text-embedding-3-small`.
- **Qualidade/CI:** ESLint 9, Prettier, Vitest 4. O workflow `ci.yml` roda lint → typecheck → test → build; `migrations.yml` faz replay das migrations num Postgres limpo + `verify-schema.sql`.
- **Deploy:** `output: "standalone"`, Dockerfile (node:20-alpine), docker-compose. O README recomenda Hostinger; comentários citam Vercel (`after()`).

## 4. Autenticação

- **Supabase Auth** (e-mail/senha; reset/confirmação via `/auth/callback` com
  sanitização do `next`). A configuração de Auth (signup aberto, confirmação de
  e-mail, política de senha) **não está versionada**: `supabase/config.toml` só
  tem `[db]`, então tudo fica no dashboard do Supabase.
- **`src/middleware.ts`:** chama `supabase.auth.getUser()` (refresh de cookie),
  redireciona rotas protegidas para `/login` e bloqueia `/api/whatsapp/*` sem
  sessão, exceto caminhos que contenham `/webhook`. As outras `/api/*` não são
  barradas no middleware; cada rota faz a própria checagem.
- **Nas API routes:** `getCurrentAccount()` / `requireRole(min)`
  (`lib/auth/account.ts`) leem `profiles.account_id/account_role` com o cliente
  do usuário. Algumas rotas antigas (`whatsapp/config`, `whatsapp/media`,
  `flows/*`) fazem `auth.getUser()` + lookup inline e dependem do RLS para o
  controle de papel.
- **API pública:** `Authorization: Bearer wacrm_live_…` → SHA-256 → lookup em
  `api_keys` (service role) → `ApiKeyContext` com `supabaseAdmin()`.
- **Cron:** header `x-cron-secret` comparado em tempo constante com `AUTOMATION_CRON_SECRET`.
- **Webhook Meta:** HMAC-SHA256 (`x-hub-signature-256`) contra
  `META_APP_SECRET`, que aceita vários secrets separados por vírgula. Falha
  fechado se o secret não estiver definido.

## 5. Multi-tenancy

- **Tenant = `accounts`** (migration 017). Toda tabela “raiz” de domínio tem
  `account_id NOT NULL` com FK `ON DELETE CASCADE` e índice. Tabelas filhas
  (`messages`, `contact_tags`, `pipeline_stages`, `broadcast_recipients`,
  `automation_steps`, `flow_nodes`, `flow_run_events`, `message_reactions`,
  `contact_custom_values`) **não têm `account_id`**: herdam a tenância por
  JOIN com a tabela pai nas policies.
- `user_id` continua nas tabelas como **autoria/auditoria**, não como isolamento.
- Isolamento em **duas camadas**:
  1. **RLS** com `is_account_member(account_id, min_role)` para o cliente do usuário;
  2. **filtro manual `.eq('account_id', …)`** em todo caminho com service role
     (webhook, engines, API v1, IA, cron).
- Só existe um banco/schema compartilhado (pool model). Não há schema por tenant.

## 6. Banco de dados: principais tabelas

36 tabelas em `public`, todas com RLS habilitado [verificado].

| Domínio | Tabelas |
|---|---|
| Identidade/tenant | `accounts` (name, owner_user_id, default_currency), `profiles` (user_id, account_id, account_role, beta_features, `role` legado sem uso), `account_invitations` (token_hash), `member_presence` |
| WhatsApp | `whatsapp_config` (1 por conta), `message_templates`, `quick_replies` |
| Inbox | `contacts` (phone, phone_normalized gerado, wa_user_id/BSUID, wa_username), `conversations` (status, assigned_agent_id, unread_count, campos de IA), `messages` (sender_type, content_type, message_id = wamid, status, erro, interactive_payload, ai_generated), `message_reactions`, `contact_notes`, `notifications` |
| CRM | `tags`, `contact_tags`, `custom_fields`, `contact_custom_values`, `pipelines`, `pipeline_stages`, `deals` |
| Campanhas | `broadcasts` (contadores agregados por trigger), `broadcast_recipients` (whatsapp_message_id único, template_params) |
| Automação | `automations`, `automation_steps` (árvore yes/no), `automation_logs`, `automation_pending_executions` (waits) |
| Flows (bot) | `flows`, `flow_nodes`, `flow_runs` (1 ativo por contato/conta), `flow_run_events` |
| API/integração | `api_keys`, `webhook_endpoints` |
| IA | `ai_configs` (1 por conta), `ai_knowledge_documents`, `ai_knowledge_chunks` (tsvector + vector(1536)), `ai_usage_log` |

Índices únicos relevantes [verificado]: `contacts(account_id, phone_normalized)`,
`contacts(account_id, wa_user_id)`, `conversations(account_id, contact_id)`,
`messages(conversation_id, message_id)`, `whatsapp_config(account_id)`,
`whatsapp_config(phone_number_id)`, `broadcast_recipients(whatsapp_message_id)`.
**Inconsistência:** `message_templates_user_name_language_key` ainda é
`(user_id, name, language)`, não `account_id`.

Realtime publica: `conversations`, `messages`, `message_reactions`, `flow_runs`,
`member_presence`, `notifications`.

Storage: buckets `avatars` (2 MB), `flow-media` e `chat-media` (16 MB), **todos `public = true`**.

## 7. Vínculo usuário ↔ empresa/conta

- **1 usuário pertence a exatamente 1 conta.** O vínculo é `profiles.account_id`
  + `profiles.account_role` (`owner > admin > agent > viewer`). Não há tabela de
  membership N:N; o índice `idx_accounts_one_per_owner` garante 1 conta própria
  por usuário.
- **Signup:** o trigger `handle_new_user` (SECURITY DEFINER) cria `accounts` + `profiles(owner)`.
  Ele engole exceções (`EXCEPTION WHEN OTHERS → WARNING`), então pode sobrar um
  usuário órfão sem perfil (a 017 até tem um passo de “healing” por causa disso).
- **Convite:** admin gera um token (32 bytes, base64url; o banco guarda só o
  SHA-256) → `/join/[token]` → RPC `redeem_invitation` move o perfil para a conta
  convidante **apenas se a conta pessoal estiver vazia** e depois apaga a conta antiga.
- **Gestão:** RPCs `set_member_role`, `remove_account_member` (devolve o membro
  para uma conta pessoal nova) e `transfer_account_ownership`.
- **Proteção:** o trigger `enforce_profile_privilege_columns` (034) impede o
  próprio usuário de alterar `account_id/account_role` via PostgREST.
- **Consequência para o SaaS BR:** quem atende vários clientes (agência,
  revendedor) precisa de um e-mail por cliente. Não existe “trocar de empresa”.

## 8. Contas do WhatsApp

- Tabela `whatsapp_config` (1 linha por conta): `phone_number_id` (único
  global), `waba_id`, `access_token` (AES-256-GCM), `verify_token` (criptografado),
  `status`, `registered_at`, `subscribed_apps_at`, `last_registration_error`,
  `mirror_inbound_media`.
- `POST /api/whatsapp/config` valida IDs, verifica o número na Graph API, chama
  `/register` (com PIN) e `/subscribed_apps`, e grava com o cliente do usuário (o
  RLS exige admin). Recusa um `phone_number_id` já usado por outra conta (checagem
  com service role).
- **Meta App é por deploy:** `META_APP_SECRET` (aceita lista) e `META_APP_ID`
  únicos no ambiente. Não há Embedded Signup / OAuth da Meta: o cliente cola
  um System User token manualmente (ver `docs/multi-waba.md`).
- A criptografia usa uma única `ENCRYPTION_KEY` global (64 hex). Não há rotação
  nem KMS; o formato CBC legado ainda é aceito na leitura.
- Selecionar `whatsapp_config`/`ai_configs`/`webhook_endpoints` está liberado
  para **todos os membros, inclusive viewer**. Hoje vem só o ciphertext, mas
  qualquer erro no `ENCRYPTION_KEY` ou um novo campo em claro passaria a vazar.

## 9. Processamento de mensagens recebidas

`POST /api/whatsapp/webhook` (`route.ts`, 1,4 mil linhas):

1. Lê o corpo cru → valida HMAC → `JSON.parse` → responde 200 e processa em `after()`.
2. Para cada `entry.changes`:
   - campos de template → `handleTemplateWebhookChange` (resolve a conta por `waba_id`/`meta_template_id`);
   - `statuses` → `handleStatusUpdate` (abaixo);
   - `messages` → busca `whatsapp_config` por `metadata.phone_number_id` (service
     role). Esse número define o **tenant**.
3. `processMessage`:
   1. `resolveInboundIdentity` (telefone e/ou BSUID);
   2. `findOrCreateContact` (BSUID exato → telefone “fuzzy” → insert, com retry em violação de unicidade);
   3. `findOrCreateConversation` (1 por contato por conta);
   4. evento `conversation.created` para os webhooks de saída;
   5. reação → `message_reactions` e para por aqui;
   6. `parseMessageContent`: mídia é resolvida na Graph API e, por padrão,
      **espelhada para `chat-media/account-<id>/…`** (público);
   7. **insert idempotente** (`upsert … ignoreDuplicates` em `(conversation_id, message_id)`); um replay encerra aqui;
   8. RPC `bump_conversation_on_inbound` (unread +1 atômico) → reabre a conversa fechada → marca o broadcast como “replied”;
   9. **Flows** (`dispatchInboundToFlows`): se o flow consumiu a mensagem, os triggers de conteúdo das automações são suprimidos;
   10. **Automações**: `first_inbound_message`, `new_contact_created`, `new_message_received`, `keyword_match`, `interactive_reply` (todas com await, em sequência);
   11. **IA auto-reply** (se nenhum flow consumiu e o texto não está vazio);
   12. webhook de saída `message.received`.

Pontos de atenção:

- Todo o pipeline roda **dentro do `after()` da mesma request**, em série, sem
  fila. Um LLM lento ou um endpoint de webhook lento consome o `maxDuration` da
  função; se estourar, os passos seguintes se perdem e não são re-tentados (o
  insert idempotente impede que o replay da Meta reprocesse).
- `handleStatusUpdate` atualiza `messages`/`broadcast_recipients` **só por
  `wamid`**, sem escopo de `phone_number_id`/conta. Na prática o wamid é único,
  mas o isolamento depende só disso.
- O GET de verificação aceita o `verify_token` de **qualquer** conta (varre e
  descriptografa todas). É uma escolha documentada, mas não escala e mistura tenants.

## 10. Processamento de mensagens enviadas

Núcleo: `sendMessageToConversation` (`lib/whatsapp/send-message.ts`), usado por
`/api/whatsapp/send` (UI, papel agent+, rate limit 60/min por usuário) e por
`/api/v1/messages`.

1. Valida o payload (text, image/video/document/audio, template, interactive).
2. Carrega a conversa + contato **filtrando por `account_id`** e o
   `whatsapp_config` da conta; descriptografa o token (e faz “self-heal” CBC→GCM).
3. Resolve o destino: telefone (com tentativa de variantes de trunk-prefix
   quando dá `131030`) ou BSUID (`recipient`).
4. Chama a Graph API **primeiro** e depois grava em `messages` com `status: 'sent'`.
   Se o insert falhar, a mensagem **já saiu** e não fica registrada (erro 500 “sent but failed to save”).
5. Atualiza o resumo da conversa e pausa um `flow_run` ativo (o agente assumiu).

Automações, Flows e IA usam helpers próprios (`lib/flows/meta-send.ts`,
`lib/automations/meta-send.ts`, `engineSendText`), com lógica semelhante mas
**duplicada**. Não há outbox, fila, retry com backoff nem verificação da janela
de 24 h (a Meta rejeita e o erro volta pelo status `failed`).

## 11. Webhooks da Meta

Ver §9. Resumo:

- Endpoint único `/api/whatsapp/webhook` (GET para o handshake, POST para eventos).
- Assinatura HMAC obrigatória, multi-secret, comparação em tempo constante.
- Roteamento de tenant por `phone_number_id` (mensagens) ou `waba_id` (templates).
- Idempotência por `(conversation_id, message_id)`; status com ladder
  forward-only (`pending → sent → delivered → read → replied`; `failed` só a
  partir de pending/sent).
- Sem armazenamento do payload bruto (não há como fazer replay/debug de evento)
  e sem dead-letter.

## 12. Identificação de contatos

- Chaves: `phone` (texto livre), `phone_normalized` (gerado, só dígitos, único
  por conta quando não vazio), `wa_user_id` (BSUID, único por conta),
  `wa_username` (só exibição).
- Ordem no inbound: **BSUID exato** → **telefone fuzzy** (`findExistingContact`:
  `LIKE '%<últimos 8 dígitos>'` + `phonesMatch`, que **também compara só os
  últimos 8 dígitos**) → cria.
- **Problema BR (S4):** os últimos 8 dígitos não identificam o número no
  Brasil. DDDs diferentes com o mesmo final colidem (e números de outros países
  também). O fuzzy existe para tratar o “0” de trunk (Lituânia, origem do
  projeto) e acaba resolvendo o 9º dígito brasileiro por acidente, mas gera
  falsos positivos. O mesmo helper é usado no formulário manual, no import CSV e
  na API v1.
- O dedupe da migration 022 junta contatos com o mesmo `phone_normalized` exato
  (correto); o problema está só no matching fuzzy em tempo de execução.

## 13. Pipelines e oportunidades

- `pipelines` (settings-class: escrita só por admin) → `pipeline_stages`
  (`position`, `color`; escrita admin) → `deals` (title, value NUMERIC(12,2),
  currency, status `open|won|lost`, `assigned_to` → `profiles.id`,
  `contact_id`, `conversation_id`, expected_close_date, notes).
- CRUD **100% no cliente** via supabase-js (kanban com dnd-kit,
  `components/pipelines/*`). Sem API route, sem histórico de mudança de estágio,
  sem probabilidade/forecast, sem motivo de perda.
- Automação `create_deal` cria deal via service role, com a moeda vinda de `accounts.default_currency`.
- **Não há eventos** de deal para automações nem para webhooks de saída.
- Não há endpoint de deals/pipelines na API v1.

## 14. Campanhas (broadcasts)

Dois caminhos diferentes:

1. **Dashboard:** `hooks/use-broadcast-sending.ts` insere `broadcasts` e
   `broadcast_recipients` pelo cliente (RLS) e depois chama
   `/api/whatsapp/broadcast` em **lotes de 10 a cada 1 s pelo navegador**. A rota
   envia para a Meta e não grava nada; quem atualiza as linhas é o hook.
   `POST /api/whatsapp/broadcast/[id]/resume` retoma até 1000 destinatários por
   chamada em `after()`, com lock otimista `delivery_locked_at` (stale após 30 min).
2. **API v1:** `createBroadcast` (find-or-create de contatos + RPC atômica
   `create_broadcast_with_recipients`) + `deliverBroadcast` em `after()`
   (`maxDuration = 60`, envio sequencial).

- Contadores agregados mantidos por trigger (`_bcast_bump`) a partir de `broadcast_recipients.status`.
- Status Meta → `broadcast_recipients` via `whatsapp_message_id`.
- **Lacunas:** `scheduled_at` existe e não é usado (não há agendamento); sem fila
  durável; sem throttling por tier da Meta; sem opt-out/lista de supressão (um
  requisito importante de LGPD e de qualidade de número); 60 req/min por usuário
  só para iniciar a campanha.

## 15. Automações

- **Modelo:** `automations` (trigger_type + trigger_config) → `automation_steps`
  em árvore (`parent_step_id`, `branch yes/no`, `position`).
- **Triggers declarados:** `new_message_received`, `first_inbound_message`,
  `keyword_match`, `new_contact_created`, `interactive_reply`, `tag_added`,
  `conversation_assigned`, `time_based`.
  - **`conversation_assigned` e `time_based` nunca são disparados** pelo backend
    (só via `POST /api/automations/engine`, manual) (A4).
- **Steps:** send_message/buttons/list/template, add/remove_tag,
  assign_conversation, update_contact_field, create_deal, wait, condition,
  send_webhook (com guarda SSRF e `redirect: manual`), close_conversation.
- **Execução:** `runAutomationsForTrigger` (service role) valida que contato e
  conversa pertencem à conta, depois executa os steps. `wait` grava em
  `automation_pending_executions` e é retomado por `/api/automations/cron`
  (50 por chamada, claim por UPDATE condicional). Cadeia de `tag_added` limitada
  por `MAX_TAG_CHAIN_DEPTH`.
- **Flows (bot conversacional, sistema paralelo):** `flows` / `flow_nodes`
  (start, send_buttons/list/message/media, collect_input, condition, set_tag,
  handoff, end; `http_fetch` está no CHECK mas não implementado) / `flow_runs`
  (1 ativo por contato) / `flow_run_events`. Timeout por `/api/flows/cron`.
  Os flows têm prioridade sobre automações de conteúdo e sobre a IA.
- **Débito:** existem duas engines (automations ~900 linhas + flows ~1,2 mil
  linhas) com envio, interpolação e tags duplicados.

## 16. Permissões e RLS

- **Helper:** `is_account_member(account_id, min_role)`, SECURITY DEFINER,
  `STABLE`, lê `profiles` (evita recursão de RLS).
- **Três camadas de policy:**
  - **viewer:** SELECT em tudo da conta;
  - **agent+:** escrita em dados operacionais (contacts, conversations, messages, deals, broadcasts, automations, flows, quick_replies, notes);
  - **admin+:** escrita em settings-class (tags, custom_fields, pipelines/stages, message_templates, whatsapp_config, api_keys, webhook_endpoints, ai_*), além de SELECT em convites e `ai_usage_log`.
- **Service-only** (sem policy de escrita): `automation_logs`, `automation_pending_executions`, `flow_runs`, `flow_run_events`.
- `notifications`: só o destinatário; o UPDATE é restrito à coluna `read_at` por GRANT de coluna (bom padrão).
- **Pontos fracos:**
  - **S1:** funções DEFINER expostas a `anon` (detalhe em §25);
  - **S5:** as policies não validam a tenância das FKs;
  - `messages_modify` é `FOR ALL` para agent+: agentes podem editar/apagar
    mensagens de cliente e inserir mensagens falsas `sender_type='customer'`. Não
    há trilha de auditoria;
  - storage público (S2);
  - a camada de aplicação repete a checagem de papel (`requireRole`) de forma
    inconsistente: algumas rotas confiam só no RLS, outras usam service role e
    dependem só do código.

## 17. API pública `/api/v1`

| Endpoint | Scope |
|---|---|
| `GET /me` | qualquer key válida |
| `GET/POST /contacts`, `GET/PATCH /contacts/:id` | `contacts:read` / `contacts:write` |
| `GET /conversations`, `GET /conversations/:id` | `conversations:read` |
| `GET /conversations/:id/messages` | `messages:read` |
| `POST /messages` (find-or-create do contato por telefone + envio) | `messages:send` |
| `POST /broadcasts`, `GET /broadcasts/:id` | `broadcasts:send` |
| `GET/POST /webhooks`, `GET/PATCH/DELETE /webhooks/:id` | `webhooks:manage` |

- Envelope `{ data }` / `{ data, meta: { next_cursor } }` / `{ error: { code, message } }`; paginação por cursor (`lib/api/v1/pagination.ts`).
- Todas as rotas usam **service role + `.eq('account_id', ctx.accountId)`**.
  Revisei todas, e o filtro está presente [verificado por leitura].
- Rate limit por key (em memória). Não há idempotency-key em `POST /messages`
  nem em `/broadcasts` (um retry do cliente duplica o envio).
- Sem versionamento além do prefixo, sem OpenAPI gerado (há só `docs/public-api.md`).

## 18. API keys e scopes

- Formato `wacrm_live_<32 bytes base64url>`. O banco guarda o SHA-256 (sem
  salt/pepper, aceitável com 256 bits de entropia) e um prefixo de 8 caracteres
  para exibição. O plaintext aparece uma única vez.
- `scopes text[]` com 7 valores fixos (`API_SCOPES`); `expires_at` e `revoked_at` opcionais; `last_used_at` atualizado sem await.
- Criação/revogação: admin+ (RLS + `requireRole('admin')`). **Leitura da lista: qualquer membro.**
- **Lacunas:**
  - a key **não herda nem re-checa o papel do criador**: se o admin for removido
    ou rebaixado, a key continua válida;
  - sem allowlist de IP, sem scopes por recurso, sem scopes de leitura para broadcasts/webhooks (`broadcasts:send` dá também o GET);
  - `touchLastUsed` faz um UPDATE por request (carga de escrita na tabela de keys).

## 19. IA / RAG

- **Config por conta** (`ai_configs`): provider `openai|anthropic`, model, `api_key`
  (BYO, criptografada), `system_prompt`, `is_active`, `auto_reply_enabled`,
  `auto_reply_max_per_conversation` (1–20), `handoff_agent_id`, `embeddings_api_key` (OpenAI).
- **Modos:** draft no inbox (`/api/ai/draft`, agent+), playground/test,
  auto-reply no webhook.
- **Auto-reply:** respeita flows (que têm prioridade); **não roda se existir
  qualquer automação ativa `new_message_received`/`keyword_match`** na conta;
  não roda em conversa atribuída a humano ou com `ai_autoreply_disabled`;
  rate limit por conta (memória); cap atômico via `claim_ai_reply_slot`; handoff
  por sinal do modelo gera resumo e atribuição; uso registrado em `ai_usage_log`.
- **RAG:** documentos → `chunkText` → chunks com `fts tsvector('simple')` gerado e
  `embedding vector(1536)` opcional. Retrieval híbrido: semântico
  (`match_ai_knowledge_semantic`) e complemento por FTS (`match_ai_knowledge_fts`),
  k=5, ambos `SECURITY INVOKER` com `p_account_id`. Com service role o filtro é
  o parâmetro; com o cliente do usuário o RLS também atua.
- **Limitações:** dimensão fixa 1536 (troca de modelo exige migration); FTS
  `'simple'` (sem stemming em português); sem upload de PDF/URL (só texto);
  embeddings só OpenAI; contexto = últimas N mensagens (`AI_CONTEXT_MESSAGE_LIMIT`);
  sem guardrails/PII redaction; sem quota por tenant além do rate limit em memória.

## 20. Configurações por tenant

Ficam espalhadas em várias tabelas, sem uma tabela `account_settings`:

| Configuração | Onde |
|---|---|
| Nome, moeda padrão | `accounts.name`, `accounts.default_currency` (CHECK `^[A-Z]{3}$`) |
| WhatsApp | `whatsapp_config` (+ `mirror_inbound_media`) |
| IA | `ai_configs` |
| Integrações | `api_keys`, `webhook_endpoints` |
| Catálogos | `tags`, `custom_fields`, `pipelines`, `message_templates`, `quick_replies` |
| Feature flags | `profiles.beta_features` (**por usuário** e editável pelo próprio usuário; serve só para gating de UI) |
| **Globais por deploy** (não por tenant) | locale (`NEXT_PUBLIC_APP_LOCALE`), fuso (runtime), Meta App, `ENCRYPTION_KEY`, limites de rate, `AI_*` |

Para o SaaS BR faltam: fuso horário, idioma, horário comercial, plano/limites,
branding, dados fiscais (CNPJ) e consentimento LGPD.

## 21. Pontos mais sensíveis para manutenção do fork

1. **`supabase/migrations/`**: numeração sequencial compartilhada com o
   upstream. Uma migration nova do fork com número `043` vai colidir com a
   próxima do upstream (ver §22.4).
2. **`app/api/whatsapp/webhook/route.ts`**: 1,4 mil linhas, coração do produto,
   recebe muitos PRs no upstream (issues #301, #363, #367, #369, #409, #519, #534, #535).
3. **`lib/whatsapp/meta-api.ts` / `send-message.ts` / `template-*`**: acoplados ao formato da Graph API.
4. **Engines de automação e de flows**: lógica densa, muito comentada, com invariantes implícitas.
5. **Policies de RLS da 017** e o helper `is_account_member`: qualquer mudança no modelo de membership mexe em tudo.
6. **`hooks/use-auth.tsx`** e `lib/auth/account.ts`: assumem 1 conta por usuário.
7. **`lib/i18n/translate.ts` + `messages/*.json`**: o commit do fork (`fbabe3f`,
   104 arquivos, +3,7 mil linhas) espalhou `getT()` por `lib/`. É a **maior fonte
   imediata de conflito de merge** com o upstream.

---

## 22. O que alterar diretamente vs. evitar

### 22.1 Alterar diretamente (correções pequenas e localizadas, bons candidatos a PR upstream)

- **S1:** migration nova com `REVOKE EXECUTE ... FROM anon, authenticated` nas
  funções DEFINER internas, mais `GRANT` só para `service_role` (ou para o
  trigger, que não precisa de GRANT).
- **S2:** policies `SELECT` de storage filtrando `account-<id>` por membership;
  avaliar tornar `chat-media` privado e servir por signed URL.
- **S3:** `Cache-Control: private, max-age=…` no proxy de mídia.
- **S4:** `phonesMatch` com regra específica para BR (normalizar o 9º dígito com
  DDD) e comparar o número completo (com country code) em vez dos últimos 8 dígitos.
- **S6:** trigger ou GRANT de coluna impedindo UPDATE de `owner_user_id` fora da RPC.
- Índice único de `message_templates` → `(account_id, name, language)`.
- Testes independentes de TZ/locale (fixar `TZ=UTC`/`LANG` no `vitest.config.ts` ou nos próprios testes).
- Tradução PT-BR (`messages/pt.json`) e textos.

### 22.2 Evitar alterar (ou alterar só via PR upstream)

- Estrutura e ordem das migrations existentes (001–042). **Nunca editar migration já aplicada.**
- `webhook/route.ts`, `send-message.ts`, `meta-api.ts`, engines: mudanças grandes
  aqui viram conflito permanente. Preferir **pontos de extensão** (hooks/eventos)
  e mandar o PR para o upstream.
- Contrato da API v1 e o formato dos webhooks de saída (o MCP server e terceiros dependem deles).
- `is_account_member` e as policies da 017 (a menos que se adote um modelo de membership N:N, o que é uma decisão de produto, ver §23 e §27).

### 22.3 Funcionalidades que podem ser módulos externos

Usar os eventos de saída (`message.received`, `message.status_updated`,
`conversation.created`) e a API v1, ou um schema separado (`saas.*`) no mesmo
banco, com o mínimo de toque no core:

| Módulo | Como acoplar |
|---|---|
| **Billing/planos** (Asaas, Iugu, Stripe BR, Pix/boleto) | schema `saas` (`plans`, `subscriptions`, `usage_counters`) + checagem em pontos centrais (envio, broadcast, IA) via 1 função `assertQuota()` |
| **Painel super-admin / backoffice** | app separada lendo com service role, ou rota `/admin` isolada |
| **Fila de envio / worker de campanhas** | worker Node (BullMQ/pg-boss/Supabase Queues) consumindo `broadcast_recipients` pendentes; substitui o loop do browser |
| **Agendamento de campanhas e trigger `time_based`** | o mesmo worker/cron |
| **Integrações BR** (RD Station, Bling, Tiny, Hotmart, Kiwify, NFe) | serviços que consomem webhooks de saída e chamam `/api/v1` |
| **Onboarding Meta (Embedded Signup)** | rota/serviço próprio que no final grava em `whatsapp_config` |
| **LGPD** (export, anonimização, opt-out) | serviço/rotas próprias + tabela `saas.consents` / `suppression_list` |
| **Relatórios/BI** | views/materialized views em schema próprio |
| **RAG avançado** (PDF, URL crawling, PT stemming) | pipeline externo que grava em `ai_knowledge_documents/chunks` |

### 22.4 O que deve continuar compatível com o upstream

- Nomes e semântica das tabelas centrais e de `account_id` (tenant).
- Sequência de migrations do upstream: **adotar uma faixa ou um prefixo próprio
  para o fork** (ex.: migrations `900_saas_*.sql` ou um timestamp). Atenção: o
  Supabase CLI ordena por nome, então é preciso combinar uma convenção que nunca
  intercale de forma errada com as próximas do upstream.
- Contrato `/api/v1`, scopes e o formato dos eventos de webhook de saída.
- Layout de `src/lib/**` (manter os arquivos; estender por composição em `src/saas/**`).
- `messages/*.json` com as mesmas chaves (adicionar chaves novas em namespace próprio, ex. `Saas.*`).
- Fluxo de assinatura/roteamento do webhook da Meta.

---

## 23. Riscos técnicos

| Risco | Impacto | Mitigação |
|---|---|---|
| Divergência do upstream (o commit i18n já é grande) | merges cada vez mais caros | rebase frequente; enviar i18n e correções como PR upstream; código SaaS em pastas novas |
| Colisão de numeração de migrations | migration do fork ignorada ou aplicada fora de ordem | convenção de prefixo própria + CI `migrations.yml` |
| Processamento do webhook todo em `after()` | perda silenciosa de automação/IA/webhook em timeout | fila durável (pg-boss/Supabase Queues) e gravação do payload bruto |
| Rate limit em memória | sem efeito com >1 instância/serverless | Redis/Upstash ou Postgres |
| Campanha orquestrada no browser | campanha parcial ao fechar a aba; abuso | worker server-side |
| 1 número por conta | bloqueia clientes com vários números/departamentos | reprojetar `whatsapp_config` + conversa por (contato, número), um projeto grande |
| 1 conta por usuário | bloqueia agências/revendas | membership N:N, um projeto grande que mexe no RLS inteiro |
| `ENCRYPTION_KEY` única sem rotação | vazamento compromete todos os tenants | envelope encryption / versionamento de chave |
| Next.js 16 com APIs novas | IA/devs erram APIs | seguir `node_modules/next/dist/docs` (AGENTS.md) |
| Dependência de BYO-key de IA | suporte difícil, custo invisível | se o SaaS revender IA, precisa de chave da plataforma + metering |
| Testes dependentes de TZ/locale | CI verde, dev BR vermelho | fixar o ambiente nos testes |
| Limites da Meta (tier, quality rating) não modelados | número bloqueado por campanha | throttling por tier + monitoramento de quality |

## 24. Débito técnico existente

- **Cinco cópias de `supabaseAdmin()`** (`lib/flows/admin-client.ts`,
  `lib/automations/admin-client.ts`, `lib/ai/admin-client.ts`, inline no webhook
  e em `whatsapp/config`). A API v1 importa o de `flows`.
- **Duas engines** (automations e flows) com envio, interpolação e tags duplicados.
- **Três caminhos de envio** (send-message, flows/meta-send, automations/meta-send) e **dois de broadcast** (browser e servidor).
- Coluna legada `profiles.role` sem uso; `user_id NOT NULL` em tabelas de domínio
  forçando “usuário de auditoria” artificial (dono do config); FK
  `deals.assigned_to → profiles.id` em vez de `auth.users.id` (inconsistente com
  `conversations.assigned_agent_id`).
- `message_templates` com unicidade por `user_id` (pré-017).
- `scheduled_at`, triggers `time_based`/`conversation_assigned` e nó `http_fetch` sem implementação.
- Checagem de papel inconsistente entre rotas (algumas só RLS, outras só código).
- Auth do Supabase não versionada (`config.toml` mínimo).
- `CSP` em modo **Report-Only** com `'unsafe-inline' 'unsafe-eval'`.
- Locale e fuso globais; formatação de moeda via `Intl.NumberFormat(undefined, …)` (depende do runtime).
- `findExistingContact` faz `LIKE '%suffix'` em `phone` cru (não usa índice, e telefones formatados com hífen não casam).
- Sem observabilidade estruturada (só `console.*`), sem tracing, sem tabela de eventos brutos.
- Arquivos muito grandes: `webhook/route.ts` (1447), `meta-api.ts` (1228), `flows/engine.ts` (1213), `automations/engine.ts` (888).

## 25. Possíveis problemas de segurança

> **Atualização:** os itens 1, 2 (listagem), 3, 4 e 8 foram corrigidos pelas
> migrations 902/903 e pelo patch P-006, com testes de isolamento pgTAP.
> Detalhes em [`docs/TENANCY.md`](./TENANCY.md).

Ordenados por prioridade.

1. **[Alta][verificado] Funções DEFINER executáveis por `anon`/`authenticated`.**
   Resultado de `has_function_privilege` no banco local:

   | Função | anon | authenticated | Efeito se chamada diretamente |
   |---|---|---|---|
   | `_bcast_bump(bid, col, delta)` | ✅ | ✅ | altera qualquer coluna inteira de **qualquer** broadcast de qualquer tenant (precisa do UUID) |
   | `recompute_broadcast_counts(bid)` | ✅ | ✅ | recalcula contadores de qualquer broadcast |
   | `record_webhook_failure(id, max)` | ✅ | ✅ | **desativa o webhook de saída de qualquer tenant** (`max=1`); o id vai no header `X-Wacrm-Webhook-Id` para o receptor |
   | `claim_ai_reply_slot(conv, max)` | ✅ | ✅ | esgota o limite de IA de qualquer conversa |
   | `merge_duplicate_contacts()` / `merge_duplicate_conversations()` | ✅ | ✅ | manutenção global em todos os tenants (DoS / efeitos colaterais) |

   Causa: no Supabase os privilégios padrão concedem EXECUTE diretamente a
   `anon`/`authenticated`; `REVOKE … FROM PUBLIC` não remove isso. As migrations
   007, 012, 037 e 038 já fazem o certo (`REVOKE … FROM anon, authenticated`).
   Correção: migration com o mesmo padrão para as funções acima.
   (`is_account_member`, `peek_invitation`, as RPCs de membros e `touch_presence`
   checam `auth.uid()` ou são intencionais.)

2. **[Alta][verificado nas policies] Storage público e listável entre tenants.**
   As policies `"Chat media is publicly readable"`, `"Flow media…"` e
   `"Avatars…"` são `SELECT USING (bucket_id = '…')` para `{public}`. Além do
   download por URL pública, isso permite **listar objetos** pela Storage API
   com a anon key, e o prefixo `account-<uuid>/` não protege nada. O espelho de
   mídia recebida está ligado por padrão, então documentos e fotos de clientes
   finais ficam expostos. Para LGPD é crítico.
3. **[Média] Cache público de mídia autenticada** (`/api/whatsapp/media/[mediaId]`).
4. **[Média] RLS sem validação de tenância das FKs** (S5). Hoje os caminhos
   service-role revalidam (`assertContactAndTagOwnership`,
   `runAutomationsForTrigger`, `planBroadcastResume` usando o cliente do usuário),
   mas é uma defesa frágil. Sugestão: triggers `BEFORE INSERT/UPDATE` que
   validam `account_id` do pai, ou `WITH CHECK` com EXISTS.
5. **[Média] API keys sobrevivem à saída/rebaixamento do criador**; listagem
   visível a viewers.
6. **[Média] Rate limit em memória**: ineficaz com várias instâncias. Signup
   aberto sem captcha também cria contas à vontade.
7. **[Média] SSRF com TOCTOU de DNS** em `isDeliverableUrl`: ele resolve o DNS,
   depois o `fetch` resolve de novo (DNS rebinding). Mitigação: fixar o IP
   resolvido (agent customizado) ou usar um egress proxy.
8. **[Baixa-média] Admin altera `accounts.owner_user_id`** diretamente.
9. **[Baixa-média] Agentes podem editar/apagar/forjar mensagens** (`messages_modify` FOR ALL) e não há audit log.
10. **[Baixa] CSP só report-only**; `HSTS preload` já forçado (atenção a subdomínios).
11. **[Baixa] `verify_token` compartilhado entre tenants** no handshake; o GET descriptografa todos os tokens.
12. **[Baixa] `ENCRYPTION_KEY` única** sem rotação; ciphertexts de tokens legíveis por qualquer membro (incluindo viewer).
13. **[Info] `.env.local` presente no clone local** (chmod 600, gitignored). Não foi lido.

## 26. Possíveis problemas de isolamento entre tenants

| Vetor | Situação |
|---|---|
| Storage (`chat-media`, `flow-media`, `avatars`) | **Vazamento real:** leitura/listagem cruzada (S2) |
| RPCs DEFINER expostas | **Integridade cruzada:** broadcasts, webhooks e IA de outro tenant (S1) |
| FKs entre tenants (deals, recipients, conversations, step configs) | permitido pelo RLS; mitigado em código (S5) |
| Status webhook por `wamid` sem filtrar conta | baixo risco (wamid único), mas sem defesa em profundidade |
| Cache de mídia | risco atrás de CDN (S3) |
| `verify_token` global | mistura tenants no handshake (baixo) |
| Service role em API v1/webhook/engines | **ok hoje**: todas as queries revisadas filtram `account_id`; é o ponto mais fácil de regredir. Sugestão: wrapper `tenantDb(accountId)` ou teste que falha se uma query service-role não tiver `account_id` |
| Realtime | ok (respeita RLS) |
| `ENCRYPTION_KEY` única | vazamento da chave compromete todos os tenants |
| Templates por `user_id` | inconsistência de unicidade dentro da conta (não vaza entre tenants) |
| Contato fuzzy por 8 dígitos | **mistura pessoas dentro do mesmo tenant** (S4); entre tenants não ocorre (a busca filtra `account_id`) |

---

## 27. Próximos passos recomendados (sem refatoração grande)

1. **Hotfix de segurança** (1 migration + 2 ajustes pequenos): S1, S2 (pelo menos
   remover o SELECT público amplo), S3, S6. Ideal mandar como PR upstream também.
2. **Correção BR de telefone** (S4) com testes cobrindo DDD e 9º dígito.
3. **Convenção do fork:** prefixo de migrations, pasta `src/saas/`, namespace i18n `Saas.*`, e enviar o commit i18n para o upstream.
4. **Fixar TZ/locale nos testes** para a suíte ficar verde em máquinas BR.
5. **Desenhar (antes de codar)** as três decisões estruturais do SaaS:
   (a) membership N:N vs. 1:1; (b) multi-número por conta; (c) fila/worker
   para webhook, campanhas e agendamento.
6. Depois disso: billing/quotas (`assertQuota`), super-admin, LGPD/opt-out,
   rate limit distribuído, observabilidade.

---

### Apêndice A — Consultas de verificação usadas (somente leitura)

```sql
-- Funções em public: SECURITY DEFINER e quem pode executar
select p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authn
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
order by p.prosecdef desc, anon desc;

-- RLS habilitado por tabela
select tablename, rowsecurity from pg_tables where schemaname = 'public';

-- Policies de storage
select policyname, cmd, roles, qual from pg_policies where schemaname = 'storage';

-- Buckets
select id, public, file_size_limit from storage.buckets;

-- Índices únicos
select indexname, indexdef from pg_indexes
where schemaname = 'public' and indexdef ilike '%unique%';
```

### Apêndice B — Matriz de autenticação das rotas internas (`src/app/api`, exceto v1)

- `requireRole('owner')`: transfer-ownership.
- `requireRole('admin')`: api-keys (POST/DELETE), invitations, members (PATCH/DELETE), ai config/knowledge/test/usage, templates submit/sync/CRUD, account PATCH.
- `requireRole('agent')`: whatsapp send/react/broadcast/resume, ai draft/autoreply/playground, automations/flows CRUD + engine, contacts tags, quick-replies.
- Só `auth.getUser()` + RLS: `whatsapp/config` (escrita admin garantida pelo RLS, **mas as chamadas à Meta (register/subscribe) acontecem antes, para qualquer membro**), `whatsapp/media/[id]`, `flows/[id]/runs`, `flows/templates`, `invitations/redeem`.
- Segredo compartilhado: `automations/cron`, `flows/cron` (`x-cron-secret`).
- HMAC Meta: `whatsapp/webhook`.
- Anônimo com rate limit: `invitations/[token]/peek`.
