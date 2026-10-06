# WhatsApp para operação SaaS

Como as credenciais da Meta de cada tenant são guardadas, quem pode ver o
quê, como o webhook encontra o tenant certo e como acompanhar a saúde da
conexão. Sem Embedded Signup nesta versão.

Código: `src/custom/whatsapp/` · banco: `supabase/migrations/905_whatsapp_saas.sql`
· patch do core: **P-008** · testes: `supabase/tests/database/whatsapp_secrets.test.sql`,
`src/custom/whatsapp/whatsapp.test.ts`.

---

## 1. Como estava (análise)

| Item | Situação no upstream |
|---|---|
| Onde fica | `whatsapp_config`, **uma linha por conta** (`UNIQUE(account_id)`) |
| Phone Number ID | `phone_number_id`, **único no deploy inteiro** (013) |
| WABA ID | `waba_id`, opcional, **não único**: dois tenants podiam apontar a mesma WABA |
| Meta Business ID | não existia |
| Access token | criptografado (AES-256-GCM, `ENCRYPTION_KEY`; formato antigo CBC ainda lido e migrado no uso) |
| Verify token | criptografado; o handshake `GET /api/whatsapp/webhook` compara com o de cada conta |
| PIN (2FA) | não era guardado, só usado no `/register` |
| Status | `connected` / `disconnected`, mais `registered_at`, `subscribed_apps_at`, `last_registration_error` |
| Logs de conexão | não havia; só `console.*` |
| Roteamento do webhook | pelo `metadata.phone_number_id` (service role); o `entry.id` (WABA) não era conferido |
| Exposição | RLS deixava **qualquer membro** (inclusive *viewer*) fazer `select *` na tabela pelo PostgREST e receber **os ciphertexts** do token e do verify token. A própria tela de configurações fazia `select('*')` no navegador. As rotas de servidor liam o token com o cliente do usuário |
| Gravação | `POST /api/whatsapp/config` gravava com o cliente do usuário. O RLS limitava a admin, mas um admin conseguia gravar qualquer valor direto pelo PostgREST, sem passar pela validação na Meta |
| API | `GET/POST /api/whatsapp/config` já não devolviam tokens |
| Logs | tokens iam no header `Authorization`, não na URL, e nenhum `console.*` imprimia token. Mas não havia proteção contra um log futuro que imprimisse um objeto com token |

O ciphertext no navegador não revela o token sem a `ENCRYPTION_KEY`. Mas
é material sensível desnecessariamente exposto: um vazamento da chave
somado a um dump do navegador basta.

## 2. O que mudou

### 2.1 Segredos só no servidor (migration 905)

- **Privilégios por coluna:** `anon` e `authenticated` perderam SELECT,
  INSERT, UPDATE e REFERENCES na tabela e receberam SELECT só nas
  colunas não secretas. Nenhum papel de cliente lê ou grava
  `access_token`, `verify_token` ou `pin`. `select *` também é recusado,
  porque incluiria segredos. O RLS continua valendo por cima: membros
  leem, admins gravam.
- **Pelo navegador só se grava** `mirror_inbound_media` (a preferência
  que a tela altera direto). Credenciais e identificadores só mudam por
  `POST /api/whatsapp/config`, que valida tudo na Meta antes.
- **Flags no lugar dos segredos:** as colunas geradas `has_access_token`,
  `has_verify_token` e `has_pin` dizem à tela se o segredo existe, sem
  mostrá-lo.
- **Leitura no servidor:** `src/custom/whatsapp/config-store.ts`. As rotas
  continuam resolvendo a conta do usuário pela sessão (RLS) e então leem
  a linha com a **service role, sempre filtrando por esse `account_id`**
  (`getWhatsAppConfigRow`). Gravações com segredo usam
  `whatsappConfigAdmin()`. 11 pontos do core passaram a usar isso: envio,
  reação, mídia, campanhas, retomada de campanha, modelos (envio,
  edição/exclusão, sincronização), verificação de registro e configuração.
- **Checagem de papel explícita no salvamento:** como agora o
  `POST /api/whatsapp/config` grava com a service role, a regra “só admin”
  que o RLS fazia passou a ser checada no código, com resposta 403.
- **Resposta das APIs:** nenhuma API devolve token, verify token ou PIN.
  O novo `GET /api/whatsapp/connection` devolve no máximo o **final do
  token** (`••••WXYZ`), e só para admins.

### 2.2 Dados por tenant

| Campo | Coluna | Observação |
|---|---|---|
| Meta Business ID | `business_id` | numérico, opcional. No assistente (onboarding) e editável no card de status |
| WABA ID | `waba_id` | **único quando preenchido**: uma WABA, um tenant |
| Phone Number ID | `phone_number_id` | único (upstream) |
| Access token | `access_token` | criptografado, só servidor |
| Verify token | `verify_token` | criptografado, só servidor |
| PIN | `pin` | **novo:** criptografado, só servidor. Guardado depois de um `/register` bem-sucedido; serve para re-registrar o número sem pedir o PIN de novo |
| Status | `status` | `connected` · `pending` · `error` · `disconnected` |
| Saúde | `last_checked_at`, `last_check_error` (sem segredos), `last_webhook_at` | |

**Regra do status** (`computeConnectionStatus`, `status.ts`):

- **Desconectado:** não há configuração.
- **Erro:** o último salvamento, registro ou teste falhou.
- **Pendente:** credenciais válidas, mas falta um passo para receber
  mensagens: a WABA não está assinada no app (sem webhook) ou o app
  assinado não é o deste deploy (`META_APP_ID`).
- **Conectado:** credenciais válidas e a WABA assinada. Um webhook
  recebido nos últimos 7 dias também conta como conectado, porque é a
  prova de que a Meta está entregando.

A caixa de entrada trata **pendente** como utilizável, porque o envio
funciona.

### 2.3 O webhook identifica o tenant

1. **Assinatura:** `X-Hub-Signature-256` contra `META_APP_SECRET`
   (upstream, aceita vários apps).
2. **Tenant:** pelo `metadata.phone_number_id`, que é único. Vale para
   **mensagens e status de entrega** (antes os status eram aplicados só
   pelo `wamid`, em qualquer tenant — audit F-19). Código:
   `src/custom/whatsapp/routing.ts`.
3. **O `entry.id` (WABA da entrega) é obrigatório e precisa ser a WABA do
   tenant** (audit F-20):
   - `waba_id` salvo e igual → entrega aceita;
   - salvo e diferente, ou entrega sem `entry.id` → descartada;
   - **tenant sem `waba_id` salvo** → não é mais um passe livre: o app
     pergunta à Meta, com o token desse tenant, se o número está na WABA da
     entrega (`GET /{waba}/phone_numbers`). Confirmado → a WABA é gravada
     no tenant (`waba_id`, único) e as próximas entregas usam o caminho
     rápido. Não confirmado, erro da Meta, ou WABA já ligada a outro
     tenant → descartada; recusas ficam em cache 10 min (sem uma chamada à
     Graph por entrega forjada).
   - Número desconhecido ou repetido → descartado.

   Toda recusa gera uma linha técnica `[webhook] delivery ignored:
   reason=… phone_number_id=… waba=…` (só ids, nunca token) e, quando o dono
   do número é conhecido, `webhook_rejected` no log do tenant. Nunca há
   fallback para "algum" tenant.
   Status aceitos atualizam só linhas do tenant roteado (`messages` via
   `conversations.account_id`, `broadcast_recipients` via
   `broadcasts.account_id`), e o evento `message.status_updated` vai só para
   os webhooks de saída desse tenant.
4. **Novo:** `last_webhook_at` é atualizado, no máximo a cada 5 minutos.
   O primeiro webhook depois de um intervalo grava `webhook_received`.
5. **Eventos de modelo** chegam pela WABA (`entry.id`). Com `waba_id`
   único, eles têm um tenant só, em vez de serem ignorados por ambiguidade.

### 2.4 Log de conexão sem segredos

Tabela `whatsapp_connection_events`:

- **Eventos:** `saved`, `registration_failed`, `tested`, `disconnected`,
  `webhook_received`, `webhook_rejected`.
- **Colunas:** status, Phone Number ID, WABA, código de erro da Meta,
  mensagem e quem fez a ação.
- **Mensagens redigidas** por `safeMessage` e limitadas a 500
  caracteres; o banco também recusa mensagens maiores.
- **Escrita** só pelo servidor (service role). Clientes não inserem, não
  alteram e não apagam.
- **Leitura:** membros leem o log do próprio tenant (RLS); o
  `tenant_enforce_refs` vale também aqui.

### 2.5 Tokens fora dos logs

- **Redação no console** (`src/custom/whatsapp/redact.ts`, ligada em
  `src/instrumentation.ts`): todo `console.log/info/warn/error/debug` do
  servidor passa por `redactValue` antes de sair.
- **O que é removido:**
  - tokens da Meta (`EAA…`), `Bearer …`;
  - parâmetros `access_token=`, `hub.verify_token=` e afins;
  - campos JSON chamados `access_token`, `verify_token`, `pin`, `secret`
    e similares;
  - ciphertexts do app, JWTs, chaves `sk-…` e `wacrm_live_…`.
- Objetos, `Error` (mensagem, stack, cause) e arrays são varridos;
  chaves com nome de segredo viram `[redacted]`.
- **Testado no build de produção:**
  `console.error('token EAAG…', { access_token: '…' })` saiu como
  `token EAA…[redacted] and { access_token: '[redacted]' }`.
- O `next dev` só carrega o `instrumentation.ts` ao iniciar: reinicie o
  servidor de desenvolvimento depois de atualizar.

### 2.6 Tela de status

Em Configurações → WhatsApp, acima da configuração avançada (que não mudou):

- **Status:** selo **Conectado / Pendente / Erro / Desconectado** com
  explicação, e o motivo do último erro já redigido.
- **Identificadores:** Phone Number ID, WABA, Meta Business ID (editável
  por admins).
- **Segredos, sem mostrá-los:** token como `••••WXYZ` (só admins), verify
  token e PIN como “configurado” / “não configurado”.
- **Saúde:** número registrado, WABA assinada, último webhook, último teste.
- **Histórico:** as 10 últimas entradas do log de conexão.
- **Testar conexão** (admins, com limite de requisições), via
  `POST /api/whatsapp/connection/test`. Verifica:
  - o token decripta e a Meta aceita o número;
  - o número está na WABA salva;
  - a WABA está assinada no app (e no `META_APP_ID`, se configurado).

  Grava o novo status, `last_checked_at` e `last_check_error`, e registra
  o evento.

APIs (rotas do fork, `src/app/api/(fork)/whatsapp/connection/`):

| Rota | Quem | O quê |
|---|---|---|
| `GET /api/whatsapp/connection` | membros | resumo sem segredos (dica do token só para admins) + histórico |
| `PATCH /api/whatsapp/connection` | admins | Meta Business ID |
| `POST /api/whatsapp/connection/test` | admins | “Testar conexão” |

## 3. Verificado

- **Banco** (`npm run test:db`):
  - `whatsapp_secrets.test.sql`, 24 testes:
    - admin não lê nem grava `access_token`, `verify_token` ou `pin`, e
      `select *` é recusado;
    - admin lê só as próprias colunas públicas e os `has_*`;
    - não insere config direto nem troca o número direto; ainda altera a
      preferência de mídia;
    - não vê a config nem o log de outro tenant;
    - não forja nem apaga entradas do log;
    - viewer vê o status, mas não altera nem desconecta;
    - a service role lê o token;
    - número e WABA não se repetem entre tenants;
    - Business ID numérico e os 4 status são exigidos;
    - nenhum papel de cliente tem privilégio algum nas colunas secretas.
  - Os 124 testes de isolamento continuam passando.
- **Unitários** (`whatsapp.test.ts`, 21 testes):
  - redação dos padrões de segredo, inclusive no console;
  - dica de token com no máximo 4 caracteres;
  - regras de status;
  - a lista de colunas públicas bate com o GRANT da migration;
  - **guarda contra regressão:** nenhum componente de navegador pede
    coluna secreta ou `select(*)` em `whatsapp_config`, e nenhum código de
    servidor fora da lista revisada faz `select('*')` nela.
- **Navegador e HTTP**, com uma config falsa criptografada:
  - PostgREST com a sessão do usuário: `select=access_token`, `select=*`,
    `select=verify_token,pin` e `PATCH access_token` deram **403 (42501)**;
    as colunas públicas deram 200;
  - `GET /api/whatsapp/connection` e `GET /api/whatsapp/config` não
    trouxeram token, ciphertext, verify token nem PIN;
  - “Testar conexão” com token inválido mudou o status para **Erro**, com
    a explicação da Meta e o evento `tested` (código 190) no histórico;
  - **webhook assinado:**
    - com uma WABA estranha, foi descartado e gerou `webhook_rejected`;
    - com a WABA certa, a mensagem entrou e o webhook ficou marcado como
      recebido (`webhook_received`, `last_webhook_at`).
- Suíte do upstream: 1250 testes passando. Os testes antigos continuam
  usando os próprios mocks: `getWhatsAppConfigRow` só usa o cliente
  recebido quando ele não é um `SupabaseClient` real, ou seja, um dublê
  de teste.

## 4. Riscos e pendências

- **Outras credenciais com o mesmo problema** (fora do escopo desta
  etapa): `ai_configs.api_key` (chave da OpenAI/Anthropic) e
  `webhook_endpoints.secret` estão criptografados, mas os ciphertexts
  continuam legíveis por qualquer membro pelo PostgREST. Mesma correção:
  privilégio por coluna e leitura no servidor.
- **Uma `ENCRYPTION_KEY` para todos os tenants**, sem rotação. Vazou, vale
  para todos. Próximo passo: chave por tenant (envelope) ou KMS, com
  re-criptografia.
- **Handshake do webhook:** o `GET` compara o verify token com o de cada
  tenant (decriptando todos). Funciona, mas em escala o melhor é um
  verify token **do deploy** (env), já que o app da Meta é do deploy.
- **Status de mensagem** (`statuses`) ainda é casado só pelo `wamid`, sem
  checar o tenant. O risco é baixo (`wamid` é único na Meta), mas falta
  defesa em profundidade.
- **WABA compartilhada entre tenants** (agência com uma WABA para vários
  clientes) deixou de ser aceita. Se houver duplicatas no banco, a
  migration **não cria** o índice e avisa (WARNING), com a consulta para
  achá-las.
- **PIN guardado:** é um segundo fator do número. Fica criptografado e
  inacessível ao navegador, mas quem tiver a chave e o banco o tem. Se
  preferir não guardar, basta não preenchê-lo (`has_pin = false`).
- **Upstream:** uma migration futura que crie coluna nova em
  `whatsapp_config` não dá SELECT dela ao navegador; o código do upstream
  que a ler vai receber 42501. Isso é de propósito: conceda a coluna na
  migration do fork se ela não for secreta. Código do upstream que volte
  a fazer `select('*')` no navegador também falha alto, e o teste de
  regressão aponta onde.
- **Embedded Signup** fica para a próxima etapa. Ele substitui token e IDs
  digitados por um fluxo OAuth, e a mesma `whatsapp_config` serve.
