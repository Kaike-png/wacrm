# Planos SaaS

Limites e recursos por plano, guardados como **dados**. A aplicação pergunta
por **chave** (`max_contacts`, `ai_enabled`…) e nunca pelo nome do plano.

- Banco: `supabase/migrations/907_billing_plans.sql`
- Serviço central: `src/billing/entitlements.ts` (servidor) e `src/billing/use-entitlements.ts` (navegador)
- Tipos e regras puras: `src/billing/features.ts`, `src/billing/errors.ts`
- Telas: `src/billing/plan-ui.tsx` e o editor em `/platform/plans` (`src/modules/platform/plans-editor.tsx`)
- Patch do core: **P-010**
- Testes: `supabase/tests/database/billing_plans.test.sql`, `src/billing/plans.test.ts`

---

## 1. Modelo

```
billing_features        key (PK) · kind (limit|flag) · default_value · sort_order · description
billing_plans           code (PK) · name · is_active · is_default (no máx. um) · sort_order
billing_plan_features   plan_code + feature_key (PK) · value (JSONB)
billing_subscriptions   account_id (PK) · plan_code · started_at · current_period_end · external_id · updated_by
```

| Tipo | Valor | Exemplo |
|---|---|---|
| `limit` | inteiro ≥ 0, ou `null` = ilimitado | `max_contacts = 2000`, `max_automations = null` |
| `flag` | `true` / `false` | `ai_enabled = false` |

Os valores são validados por tipo em trigger, então `"1.5"`, `-1` ou um
número numa flag são recusados.

A regra é única e fica no banco:

```
valor(org, chave) = valor do plano da org  ??  default_value do catálogo
```

**Sem assinatura = sem limites.** Os defaults do catálogo são
permissivos (ilimitado / habilitado), então organizações anteriores à 907
continuam funcionando como antes até receberem um plano no painel.
**Organizações novas** recebem o plano marcado como padrão (Start),
inclusive durante o trial. Um seed só cria o que não existe: valores
editados depois não são sobrescritos.

O ciclo de vida (`trial`, `active`, `past_due`, `suspended`,
`cancelled`) continua em `accounts.status` (902/906). A assinatura diz
**qual plano**, não **se está em dia**. O billing futuro grava os dois.

### Planos iniciais (seed)

| Chave | Start | Pro | Business |
|---|---|---|---|
| `max_users` | 2 | 5 | 15 |
| `max_whatsapp_accounts` | 1 | 1 | 3 |
| `max_contacts` | 2.000 | 10.000 | 50.000 |
| `max_automations` | 5 | 30 | ilimitado |
| `ai_enabled` | não | sim | sim |
| `api_enabled` | não | sim | sim |

Os valores podem ser mudados em **Painel da plataforma → Planos**, sem
deploy e com auditoria (`billing_plan.updated`, com antes e depois),
ou por SQL. Para criar um plano novo, faça um `INSERT` em
`billing_plans` e `billing_plan_features`; ele aparece no editor e no
seletor de plano das organizações.

**Recurso novo:** insira a chave em `billing_features` (com o default),
some-a a `LIMIT_FEATURES`/`FLAG_FEATURES` (`features.ts`), adicione os
textos em `Custom.billing.*` e aplique a regra no ponto certo. Os testes
de `plans.test.ts` falham se o catálogo SQL, o código e as traduções
divergirem.

## 2. Serviço central

> Para código novo use `UsageService` ([`USAGE.md`](./USAGE.md)); as
> funções abaixo são a camada que o core chama.

**Servidor** (`src/billing/entitlements.ts`):

```ts
await assertWithinLimit(accountId, 'max_automations');   // lança PlanLimitError
await assertFeatureEnabled(accountId, 'api_enabled');
if (!(await isFeatureEnabled(accountId, 'ai_enabled'))) …
const { allowed, limit, used } = await checkLimit(accountId, 'max_contacts', 500);
const ent = await getEntitlements(accountId);            // plano + valores + uso
```

**Navegador:**

- `useEntitlements()` usa `billing_my_entitlements()` e só lê a própria
  organização;
- `usePlanLimitMessage()` transforma qualquer recusa em mensagem
  traduzida.

**Uso medido** (`billing_usage`):

| Chave | Conta |
|---|---|
| `max_users` | membros + convites pendentes não expirados (o convite reserva a vaga) |
| `max_contacts` | contatos |
| `max_whatsapp_accounts` | linhas de `whatsapp_config` |
| `max_automations` | automações, ativas ou não |

**Falha aberta:** se a consulta ao plano falhar (banco fora do ar,
migration ausente), o servidor **permite** e registra o erro. As triggers
do banco continuam recusando a gravação, então uma falha de billing não
derruba clientes pagantes. As flags ficam em cache por 30 segundos por
processo, porque são lidas em toda chamada da API e em toda resposta da
IA.

**Proibido:** `if (plan === 'pro')`. Um teste varre `src/` e falha
nesse padrão.

## 3. Onde cada limite é aplicado

As triggers do banco seguram **qualquer caminho**: PostgREST, rotas,
funções e upstream novo. O servidor checa antes para responder com um
403 claro. A recusa no banco é `SQLSTATE 53400`, com mensagem
`plan_limit_exceeded` e a chave da feature em `DETAIL`.

| Chave | Banco (trigger) | Servidor / UI |
|---|---|---|
| `max_users` | `account_invitations` INSERT (membros + pendentes); `profiles` ao entrar numa organização (resgate de convite, qualquer caminho) | `POST /api/account/invitations`; aviso na aba Membros |
| `max_whatsapp_accounts` | `whatsapp_config` INSERT | `POST /api/whatsapp/config`, ao conectar o primeiro número |
| `max_automations` | `automations` INSERT | `POST /api/automations` e `…/duplicate` |
| `max_contacts` | `contacts` INSERT **feito pelo navegador** (por comando: um lote de importação que ultrapassaria o limite é recusado inteiro) | API pública (`findOrCreateContact`); mensagem no formulário de contato e na importação (que para no limite e informa uma vez) |
| `ai_enabled` | — | `loadAiConfig`/`loadEmbeddingsKey` respondem "não configurado": sem resposta automática, rascunho ou embeddings. Aviso em Agentes de IA |
| `api_enabled` | `api_keys` INSERT | `requireApiKey` devolve 403 em **toda** chamada `/api/v1` (chaves antigas param); `POST /api/account/api-keys`; aviso na aba API |

**Contatos de WhatsApp recebido nunca são bloqueados.** O webhook cria
contatos com a service role, e a trigger só limita o papel
`authenticated`. Perder a mensagem de um cliente final é pior do que
passar do limite. Esses contatos contam no uso, então a organização fica
acima do limite e não cadastra mais nenhum à mão.

**Downgrade não apaga nada.** Quem está acima do novo limite mantém tudo,
mas não cria mais nada daquele tipo até voltar para baixo do limite.

**Business com 3 números:** a arquitetura do upstream comporta **um**
número por organização (`whatsapp_config.account_id` é UNIQUE). O limite
existe e é aplicado, mas permitir mais de um número exige mudar o modelo
do upstream (inbox, envio e webhook por número). Fica como pendência.

**Mensagens:** as recusas aparecem como, por exemplo,
*“Você atingiu o limite de 2 usuários do plano Start (convites
pendentes contam). Faça upgrade para o plano Pro (até 5).”* (908) As telas Organização → **Plano e
uso** mostram o plano, as barras de uso e o que está incluído.

## 4. Segurança

- **Catálogo** (`billing_features`, `billing_plans`,
  `billing_plan_features`): leitura para usuários autenticados, porque
  não tem dado de tenant e serve para comparar planos. Escrita só pelo
  painel ou pela service role.
- **Assinatura:** membros leem só a da própria organização e não podem
  trocar de plano.
- **Funções de checagem** (`billing_check_limit`, `billing_entitlements`,
  `billing_usage`): só a service role executa. Um cliente não consegue
  sondar o uso de outra organização.
- **Painel:** `platform_set_plan` só aceita planos existentes e ativos;
  `platform_update_plan` valida chave e tipo e audita antes e depois. O
  plano padrão precisa estar ativo.

## 5. Verificado

- **pgTAP** (`billing_plans.test.sql`, 43 testes):
  - seed exatamente como especificado;
  - validação de valores e plano padrão único;
  - organização nova no plano padrão;
  - usuários: o 2º convite pendente e o 3º membro são recusados, por
    qualquer caminho;
  - a 6ª automação é recusada; depois do upgrade para Business
    (ilimitado) a mesma inserção funciona; depois do downgrade nada é
    apagado e nada novo cabe;
  - contatos: lote que ultrapassaria o limite é recusado inteiro, o
    exato cabe, o seguinte é recusado, e o contato vindo de mensagem
    recebida passa;
  - número de WhatsApp acima do limite e chave de API no Start são
    recusados;
  - sem plano, tudo ilimitado;
  - permissões de leitura e edição;
  - edição no painel com auditoria.
- **Testes já existentes:** isolamento, segredos do WhatsApp e painel da
  plataforma continuam passando. As fixtures do isolamento rodam sem
  plano.
- **Vitest:** regras puras, mensagens, sincronia catálogo/código/
  traduções e o teste contra `if (plan === …)`.
- **Navegador** (organização QA no Start, com `max_contacts` reduzido a 3
  no editor):
  - card “Plano e uso” correto;
  - avisos de IA e API exibidos;
  - criar chave de API devolveu 403 com mensagem;
  - **chave criada no Pro parou de funcionar** em `/api/v1/me` (403);
  - 1º convite criado, 2º recusado, aviso na aba Membros;
  - 6ª automação recusada;
  - pelo formulário, o 3º contato foi criado e o 4º recusado com a
    mensagem do plano.
  - O estado local foi restaurado no fim: QA voltou ao Pro e o Start
    voltou a 2.000 contatos.

## 6. Pendências

- **Mais de um número de WhatsApp por organização:** veja a seção 3.
- **Billing / gateway:** grava `billing_subscriptions` (`external_id`,
  `current_period_end`) e `accounts.status`. O resto já consulta por
  chave.
- **Medição por período** (ex.: mensagens por mês) precisa de contadores
  próprios. O modelo de features comporta, mas `billing_usage` hoje só
  conta estoque.
- **Overrides por organização** (um cliente com limite especial) não
  existem ainda. O caminho seria uma tabela
  `billing_account_feature_overrides` dentro da mesma
  `billing_feature_value`.
- A 906 cria `billing_account_plans` e a 907 migra o conteúdo e a
  remove, porque as duas foram aplicadas em sequência nesta etapa.
