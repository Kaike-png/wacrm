# Medição de uso e limites

Quanto cada organização usa, se ela ainda pode criar algo e o que dizer
quando não pode.

- Banco: `supabase/migrations/908_usage_metering.sql`
- Serviço: `src/billing/usage.ts` (`UsageService`), por cima de
  `src/billing/entitlements.ts` (camada que o core usa, ver
  [`PLANS.md`](./PLANS.md))
- Telas: `src/billing/usage-ui.tsx` (“Uso neste mês”), avisos em
  `src/billing/plan-ui.tsx`
- API: `GET /api/billing/usage`
- Patch do core: **P-011** (avisos nas páginas de Contatos e Automações)
- Testes: `supabase/tests/database/usage_metering.test.sql`,
  `src/billing/usage.test.ts`, `src/billing/plans.test.ts`

---

## 1. UsageService

```ts
import { UsageService } from '@/billing/usage';

const usage = await UsageService.getUsage(accountId);
//   { period, plan, users, contacts, whatsapp_accounts, automations,
//     messages, campaigns, ai, api }

const check = await UsageService.canUseFeature(accountId, 'max_contacts', 500);
//   { allowed, kind, limit, used, remaining, plan, upgrade, message }
if (!check.allowed) return NextResponse.json({ error: check.message }, { status: 403 });
```

- **`canUseFeature`** vale para limites (cabem mais N?) e para recursos
  (está incluído?). Quando recusa, já vem com a mensagem amigável e a
  sugestão de upgrade.
- **Falha aberta:** se a consulta ao banco falhar, o serviço permite. As
  triggers continuam recusando a gravação.
- **`getUsage`** é um relatório e propaga erros normalmente.
- **Mais leves:** `UsageService.getEntitlements` (plano, valores e
  contagens) e `UsageService.isFeatureEnabled` (com cache de 30 s, para
  caminhos quentes).

**No navegador:**

- `useUsage()` lê o relatório (`billing_my_usage`, só da própria
  organização);
- `useEntitlements()` lê os limites;
- `usePlanLimitMessage()` converte qualquer recusa em texto.

**Na API:** `GET /api/billing/usage` (qualquer membro) devolve o
relatório; com `?feature=max_contacts&increment=500` devolve o resultado
de `canUseFeature`.

## 2. O que é medido

`billing_usage_report(account)`. O **período** é o mês corrente no fuso
da organização (`accounts.timezone`); também há os últimos 30 dias para
mensagens e IA.

| Métrica | Como |
|---|---|
| Usuários | membros; **ativos** = vistos no app (presença) ou logados nos últimos 30 dias; convites pendentes (contam no limite) |
| Contatos | total; criados no mês |
| Contas WhatsApp | configuradas; conectadas (`connected`/`pending`) |
| Automações | total (conta no limite); ativas |
| Mensagens enviadas | `agent`/`bot`, sem falha, no mês (falhas à parte) |
| Mensagens recebidas | `customer`, no mês |
| Campanhas | criadas no mês; envios de campanha no mês (`broadcast_recipients.sent_at`); total |
| Uso de IA | incluída no plano?; chamadas e tokens no mês (`ai_usage_log`); respostas automáticas no mês (`messages.ai_generated`); tokens em 30 dias |
| API | incluída no plano?; chaves ativas |

São agregações sobre as tabelas existentes, com índices da 906 e do
upstream. **Não há contador no caminho de gravação das mensagens**, então
nenhuma contenção foi adicionada ao webhook. Se o volume crescer muito, o
próximo passo é um rollup diário (ver pendências).

**Onde ver:**

- **cliente:** Configurações → Organização → **Uso neste mês**, abaixo de
  “Plano e uso”;
- **equipe:** Painel da plataforma → organização → **Uso neste mês**, o
  mesmo relatório que substituiu o bloco antigo de 30 dias.

## 3. Ao atingir um limite

- **Nada é apagado.** Downgrade ou limite reduzido mantém todos os
  registros visíveis e editáveis.
- **Só novas criações** daquele tipo são recusadas. As triggers da 907
  cobrem todos os caminhos.
- **Mensagem amigável com sugestão de upgrade**, igual em todo lugar
  (resposta da API, toast do formulário, importação e avisos):

  > Você atingiu o limite de 2.000 contatos do plano Start. Faça upgrade para o plano Pro (até 10.000).

  > Você atingiu o limite de 30 automações do plano Pro. Faça upgrade para o plano Business (sem limite).

  > A inteligência artificial não está incluída no plano Start. Disponível a partir do plano Pro.

  > Você atingiu o limite de 50.000 contatos do plano Business. Fale com o suporte para ampliar seu plano.

- **A sugestão sai dos dados** (`billing_upgrade_for`): é o plano ativo
  mais barato (por `sort_order`), acima do atual, que tenha valor maior
  (ou ilimitado), ou o recurso ligado. Exemplo: para números de WhatsApp,
  o Pro tem o mesmo 1 do Start, então a sugestão pula para o Business.
  Mudou os planos no editor, a sugestão acompanha.
- **A recusa do banco carrega o contexto:** `SQLSTATE 53400`, `DETAIL` com
  a chave, e `HINT` com o JSON
  `{"feature","limit","used","plan","upgrade","upgrade_value"}`. O
  navegador monta a frase sem outra consulta.
- **Aviso antes da recusa:** Contatos, Automações e Membros mostram o
  aviso quando o limite já foi atingido; Agentes de IA e API mostram
  quando o recurso não está no plano. Todos com a sugestão de upgrade.

## 4. Verificado

- **pgTAP** (`usage_metering.test.sql`, 26 testes):
  - relatório com usuários (o membro inativo há 90 dias não conta como
    ativo), contatos só da organização, mensagens do mês (enviadas,
    recebidas e com falha, ignorando as de 60 dias atrás), campanhas e
    envios, IA (chamadas, tokens e respostas automáticas), período no
    fuso da organização;
  - `can_use` com o que resta;
  - sugestões: Pro para contatos, Business para WhatsApp, Pro para IA,
    nenhuma no plano máximo ou quando já é ilimitado;
  - recusas do banco (convite e contato digitado) com o JSON completo;
  - **nada apagado**: com limite abaixo do total, os contatos continuam
    visíveis e editáveis e só o novo é recusado;
  - membro lê só o próprio uso e não sonda o de outra organização.
- **Vitest:**
  - `usage.test.ts` (8 testes): mensagem do exemplo pedido, permitido sem
    mensagem, recursos, falha aberta, `assertWithinLimit` com contexto,
    `getUsage`, cache de flags;
  - `plans.test.ts`: frases para cada recurso, sem upgrade, hint JSON e
    legado.
- **Navegador** (QA no Start com limite de contatos 2):
  - o card “Uso neste mês” trouxe os números corretos;
  - `/api/billing/usage?feature=max_contacts` devolveu a mensagem;
  - o aviso apareceu na página de Contatos;
  - criar pelo formulário mostrou *“Você atingiu o limite de 2 contatos
    do plano Start. Faça upgrade para o plano Pro (até 10.000).”*;
  - o painel mostra o mesmo relatório.
  - O estado local foi restaurado no fim.

## 5. Pendências

- **Rollup diário** (`billing_usage_daily`), quando o volume de mensagens
  tornar caras as agregações por mês. Ele também dá o histórico para
  faturamento.
- **Limites por período** (ex.: mensagens/mês, tokens de IA/mês): o
  relatório já mede. Falta a feature no catálogo e a checagem no envio,
  que é um caminho quente; decidir antes se bloqueia ou só avisa.
- **Avisos preventivos** (ex.: 80% do limite) e e-mail ao dono: as barras
  já ficam amarelas a partir de 80%, mas não há notificação.
