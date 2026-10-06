# Inadimplência e suspensão

O que cada situação da organização permite fica decidido num único lugar.
O resto do sistema só pergunta "esta organização pode fazer X?" e nunca
compara o status.

| Peça | Onde |
|---|---|
| A matriz (pura) | `src/billing/access-policy.ts` |
| Mesma matriz no banco + travas + carência | `supabase/migrations/911_billing_delinquency.sql` |
| API usada pelo app | `src/billing/enforcement.ts`: `assertTenantCan`, `tenantCan`, `assertPhoneCan`, `getTenantAccess` |
| Recusa → mensagem amigável (403) | `src/billing/access-errors.ts` (usado por `toErrorResponse` e pela API pública) |
| Aviso no topo do painel | `src/billing/access-notice.tsx` |
| Exportação de dados | `GET /api/account/export` (CSV de contatos) + card em Configurações → Organização |
| Patch do core | **P-014** (substitui o bloqueio total do P-009) |

## 1. A política

| Status | Login, dados, exportação, faturamento e pagamento | Envio de mensagens | Campanhas | Automações (inclui fluxos e IA automática) | Criar integrações | Mensagens recebidas | Aviso |
|---|---|---|---|---|---|---|---|
| `trial` / `active` | ✅ | ✅ | ✅ | ✅ | ✅ | entram | — |
| `past_due` | ✅ | ✅ | ✅ | ✅ | ✅ | entram | 🟡 "Pagamento pendente" + data da suspensão + botão de pagar |
| `suspended` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | entram na caixa de entrada, **sem** resposta automática | 🔴 "Organização suspensa" + o que está bloqueado + botão de pagar |
| `cancelled` | ✅ | ⛔ | ⛔ | ⛔ | ⛔ | não são gravadas | 🔴 "Organização cancelada" + suporte |

- **Nada é apagado automaticamente**, em nenhum status. Contatos,
  conversas, automações e campanhas continuam visíveis e editáveis. Uma
  automação pode ser desligada, mas não ligada; uma campanha pode ficar
  em rascunho, mas não ser agendada nem enviada.
- **"Criar integrações"** cobre: conectar um número de WhatsApp novo,
  criar webhook, criar chave de API e configurar IA pela primeira vez.
  Editar o que já existe continua permitido.
- **`cancelled`** é decidido pela equipe. Nenhuma regra automática
  cancela uma organização.

## 2. Ciclo automático

```
active ──(cobrança vencida, webhook do gateway)──▶ past_due
past_due ──(BILLING_GRACE_DAYS sem pagar, cron diário)──▶ suspended  [por: billing]
past_due / suspended[billing] ──(pagamento confirmado)──▶ active
```

- **Carência:** `BILLING_GRACE_DAYS`, padrão de 7 dias, contados de
  quando a organização entrou em `past_due`. A suspensão é feita por
  `GET /api/billing/cron`, a mesma rota diária que encerra assinaturas
  canceladas, chamando `billing_enforce_delinquency`.
- **Suspensão pelo sistema:** fica registrada na auditoria da plataforma
  como *"O sistema suspendeu a organização X por falta de pagamento…"*.
  A reativação por pagamento também é auditada.
- **Quem suspendeu importa.** `billing_delinquency.suspended_by` guarda
  `billing` ou `platform`:
  - um pagamento libera **só** a suspensão feita pelo sistema;
  - a suspensão feita pela equipe no painel só a equipe retira, e o
    aviso diz "suspensa pela equipe da plataforma".
- **Reativação pela equipe para `past_due`:** começa uma carência nova,
  para a organização não ser suspensa de novo na rodada seguinte do cron.
- **Organizações já em atraso** quando a 911 foi aplicada começaram a
  carência naquele momento. Ninguém foi suspenso retroativamente.

## 3. Como é aplicado (centralizado)

**Uma matriz, duas cópias sincronizadas.** `ACCESS_POLICY` (TS) e
`account_status_blocks()` (SQL) são comparadas por um teste
(`access-policy.test.ts`); divergência quebra o CI.

**O banco garante,** por qualquer caminho (navegador, service role, API
pública, cron), com triggers que chamam `tenant_assert_can`:

| Tabela | Trava |
|---|---|
| `broadcasts` | inserir ou mudar para `scheduled`/`sending` → `campaigns.send` |
| `automations`, `flows` | criar, ligar ou ativar → `automations.run` |
| `whatsapp_config`, `ai_configs` | criar a primeira → `integrations.create` |
| `webhook_endpoints`, `api_keys` | criar ou reativar webhook → `integrations.create` |

A recusa usa o SQLSTATE `TR403`, `DETAIL` com a ação e `HINT` com o JSON
`{"action","status"}`.

**O servidor bloqueia nos pontos de passagem obrigatórios**, sempre com
`assertTenantCan`/`assertPhoneCan`/`tenantCan`:

| Ponto | Ação | Por quê |
|---|---|---|
| `lib/whatsapp/meta-api.ts` (texto, mídia, template, reação, botões, lista) | `messages.send` | **toda** mensagem que sai passa aqui, venha do inbox, da API, de automações, fluxos, IA ou campanhas; "marcar como lida/digitando" não é envio e continua |
| `lib/whatsapp/send-message.ts` | `messages.send` | recusa cedo, antes de criar conversa (inbox e `POST /api/v1/messages`) |
| `api/whatsapp/react` | `messages.send` | mensagem clara em vez de "erro da Meta" |
| `api/whatsapp/broadcast`, `lib/whatsapp/broadcast-core.ts` | `campaigns.send` | campanhas pelo painel e pela API |
| `lib/automations/engine.ts` (disparo e retomada de esperas), webhook do WhatsApp (fluxos, automações e IA) | `automations.run` | nada automático roda; a mensagem recebida é gravada normalmente |
| `lib/automations/meta-send.ts`, `lib/flows/meta-send.ts` | `automations.run` | envio de automações/fluxos retomados pelo cron |
| `api/automations` (+ duplicar), `api/account/api-keys`, `api/whatsapp/config` (número novo), `api/v1/webhooks` | `automations.run` / `integrations.create` | mensagem clara antes de chegar ao banco |

**Mensagem amigável.** `toErrorResponse` (rotas do painel) e
`toApiErrorResponse` (API pública) transformam a recusa, seja o erro
tipado ou o `TR403` do banco, num 403. Exemplo:

> Envio de mensagens bloqueado. A organização está suspensa. Regularize o pagamento em Configurações → Organização → Assinatura para liberar.

Na API pública: `{"error":{"code":"tenant_restricted","message":"…"}}`.

**Travas contra regressão** (`access-policy.test.ts`):

- nenhum arquivo fora da política, do domínio de cobrança e do painel da
  plataforma compara `status === 'suspended' | 'cancelled' | 'past_due'`;
- nenhuma migration posterior volta a colocar o status dentro de
  `is_account_member`.

**Falha aberta.** Se o status não puder ser lido (erro transitório), o
servidor deixa passar e as travas do banco continuam valendo. O status
fica em cache por 10 s; mudanças feitas pela cobrança limpam o cache na
hora.

## 4. Mudança em relação ao painel admin (P-009)

Antes, uma organização suspensa **perdia todo o acesso**: os dados
sumiam pela RLS, aparecia uma tela cheia e o webhook descartava
mensagens recebidas. Agora vale a política acima para qualquer
suspensão, da equipe ou do sistema:

- **mantém:** login, dados, exportação e pagamento; mensagens recebidas
  continuam entrando;
- **perde:** envios, campanhas, automações e novas integrações.

A tela cheia (`suspended-screen.tsx`) e o bloqueio da API de leitura
foram removidos. O texto do diálogo "Suspender" no painel foi atualizado.

## 5. Verificado

- **pgTAP:**
  - `billing_delinquency.test.sql` (37 testes): matriz; `past_due` sem
    bloqueio; carência respeitada; suspensão depois da carência,
    idempotente e auditada como sistema; organização suspensa lê, edita e
    vê uso, mas não cria nem liga automação, não inicia nem agenda
    campanha (rascunho permitido) e não cria chave de API, nem pelo
    service role; reativação limpa o registro e é auditada; suspensão da
    equipe registrada como `platform`; reativação para `past_due` com
    carência nova; nada apagado; funções e tabela só para o servidor;
  - `platform_admin.test.sql` atualizado para a nova semântica;
  - `tenant_isolation` com `billing_delinquency` revisada como só do
    servidor.
- **Vitest:**
  - `access-policy.test.ts`: matriz, sincronia com o SQL, travas contra
    regressão, mensagens em pt e en;
  - `enforcement.test.ts`: cada status, número de WhatsApp para a
    organização, falha aberta;
  - `meta-api.delinquency.test.ts`: cada tipo de envio é recusado
    **antes** de qualquer chamada à Meta, e "digitando/lida" não;
  - `payments.test.ts`: pagamento libera só a suspensão da cobrança;
  - `csv.test.ts`: exportação com BOM, `;` e proteção contra fórmula.

## 6. Pendências

- **Teste no navegador:** ainda não feito (ver a resposta desta etapa).
- **E-mail ou WhatsApp avisando** a entrada em `past_due` e a véspera da
  suspensão.
- **Painel da plataforma:** mostrar "suspensa por cobrança/equipe" e a
  data em que vence a carência.
- **Exportação:** hoje só de contatos. Conversas e mensagens dariam a
  portabilidade completa (LGPD).
