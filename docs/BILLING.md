# Cobrança e meios de pagamento

Esta é a camada que prepara a cobrança sem amarrar o produto a um gateway.

- **Hoje:** existe um gateway **mock** para desenvolvimento.
- **Depois:** Asaas, Mercado Pago, Efí e Pagar.me entram como adaptadores.
  Nenhuma regra de negócio muda quando eles chegarem.

| Peça | Onde |
|---|---|
| Contrato do gateway | `src/billing/payments/types.ts` (`BillingProvider`) |
| Regras de negócio (puras) | `src/billing/payments/rules.ts` |
| Serviço (único que fala com gateway e banco) | `src/billing/payments/service.ts` (`BillingService`) |
| Registro de gateways | `src/billing/providers/registry.ts`, `providers/index.ts` |
| Gateway mock | `src/billing/providers/mock/` |
| Gateways reais | `src/integrations/payments/<nome>/`, registrados em `src/integrations/payments/index.ts` — **Asaas** pronto ([ASAAS.md](./ASAAS.md)) |
| Teste de contrato reutilizável | `src/billing/payments/contract.ts` |
| Banco | `supabase/migrations/909_billing_payments.sql` |
| Tela do cliente | `src/billing/subscription-card.tsx` (Configurações → Organização → **Assinatura**) |
| Preço no painel | `/platform/plans` (campo “Preço mensal”) |
| Patch do core | **P-012**: só as variáveis no `.env.local.example`; nenhum código do core alterado |

---

## 1. Camadas

```
UI / rotas (fork)  ──►  BillingService  ──►  rules.ts (decide)      ──►  banco (billing_*)
                              │
                              └──►  BillingProvider (contrato)
                                        ├── mock            (src/billing/providers/mock)
                                        ├── asaas           (src/integrations/payments/asaas)        — pronto
                                        ├── mercadopago     …                                         — futuro
                                        ├── efi             …                                         — futuro
                                        └── pagarme         …                                         — futuro
```

- **Adaptadores só traduzem.** Status, nomes de campo, SDK e assinatura de
  webhook do gateway entram no adaptador e saem em formato normalizado:
  status `pending|paid|overdue|refunded|canceled|failed`, valores em
  centavos com moeda ISO e Pix como `{copyPaste, qrCodeImage, expiresAt}`.
- **Regras só decidem.** `decideEffects(evento, estado)` é uma função
  pura, sem banco e sem gateway, que devolve efeitos: registrar pagamento,
  alterar assinatura, alterar status da organização, cancelar assinatura
  antiga.
- **O serviço aplica.** Ele busca o estado, chama as regras, grava e
  conversa com o gateway sempre pelo contrato.
- **Qual gateway roda é dado, não código.**
  - Cada cliente, assinatura e pagamento guarda a coluna `provider`.
  - `BILLING_PROVIDER` escolhe o gateway das **novas** cobranças. Registros
    antigos continuam no gateway de origem, o que permite migrar de
    gateway sem cortar ninguém.
- **Travas em teste** (`payments.test.ts`):
  - nenhum arquivo de `src/billing` fora de `providers/` cita um gateway
    (Asaas, Mercado Pago, Efí, Pagar.me, Stripe…) ou importa um adaptador;
  - só o registro importa o mock.

## 2. O contrato (`BillingProvider`)

Os nomes pedidos foram adaptados ao padrão do projeto:

| Conceito pedido | Método | Observação |
|---|---|---|
| createCustomer | `createCustomer(input)` | nome, e-mail, CPF/CNPJ e telefone, vindos de `br_account_profiles` |
| createSubscription | `createSubscription(input)` | devolve a assinatura **e a primeira cobrança** (é ela que ativa) |
| cancelSubscription | `cancelSubscription(id, { atPeriodEnd })` | |
| generatePix | `createPixCharge(input)` | cobrança avulsa (ex.: taxa de implantação, pacote extra) |
| getPayment | `getPayment(id)` | usado no “Já paguei” (consulta direta, sem esperar o webhook) |
| handleWebhook | `parseWebhook({ headers, rawBody })` | **só verifica a autenticidade e traduz**; quem aplica é o serviço |

O provider também declara `id`, `displayName` e `capabilities`:

- `methods`: formas de pagamento aceitas;
- `recurring`: se o gateway cobra sozinho a cada período;
- `sandbox`;
- `requiresTaxId`: se o gateway exige CPF/CNPJ (é o caso de quase todos os
  brasileiros no Pix e no boleto). Quando exige e a organização não tem o
  documento, a tela pede para preencher em Configurações → Organização.

Erros: `BillingProviderError` (com `retryable`) e `InvalidWebhookError`.

## 3. Fluxos

**Assinar ou trocar de plano**
(`POST /api/billing/subscription { plan, method: 'pix' }`, admins):

1. O serviço cria o cliente no gateway, se ainda não houver.
2. Cria a assinatura no gateway; a primeira cobrança volta com o Pix
   copia e cola.
3. Grava a assinatura como **pendente**: `pending_plan_code` e
   `pending_external_id`. **O plano em vigor não muda até o pagamento.**
4. Webhook com status **pago**:
   - o plano novo passa a valer;
   - a assinatura fica `active` e o período vai até `periodEnd`;
   - a assinatura antiga é cancelada no gateway;
   - organização em `trial` ou `past_due` volta a `active`.

**Renovação:**

- paga: estende o período;
- vencida: assinatura e organização ficam `past_due`, e depois da
  carência a organização é suspensa ([DELINQUENCY.md](./DELINQUENCY.md));
- paga depois do vencimento: voltam a `active`, inclusive se a
  suspensão tiver sido feita pelo sistema.

**Cancelar** (`DELETE`, só o dono):

- cancela no fim do período pago; o plano continua valendo até lá;
- `GET /api/billing/cron` (diário, header `x-cron-secret`) devolve ao
  plano padrão as assinaturas canceladas com período encerrado;
- **nenhum dado é apagado.** Os limites do plano padrão só impedem novas
  criações (ver [USAGE.md](./USAGE.md)).

**Webhook** (`POST /api/billing/webhooks/:provider`, público):

1. O adaptador valida a assinatura; se não for autêntica, responde 401.
2. Cada evento é **reservado atomicamente** em `billing_webhook_events`
   (`billing_claim_webhook_event`, 910) com a chave `(provider, event_id)`;
   entregas simultâneas do mesmo evento não processam duas vezes:
   - **reentrega** de evento já processado é ignorada;
   - evento que **falhou** é reprocessado na próxima tentativa (a resposta
     500 faz o gateway reenviar);
   - além disso, as regras não repetem efeitos de um status que já foi
     aplicado.
3. Para achar a organização, o serviço usa o pagamento, depois a
   assinatura (atual ou pendente) e depois o cliente.
4. Só um resumo normalizado é gravado, nunca o payload bruto, que traz
   dados pessoais.

**O que a cobrança nunca faz:**

- não reativa uma organização suspensa **pela equipe** nem uma
  **cancelada**, porque isso é decisão da equipe
  ([PLATFORM_ADMIN.md](./PLATFORM_ADMIN.md)). A suspensão por falta de
  pagamento é liberada pelo pagamento ([DELINQUENCY.md](./DELINQUENCY.md));
- a troca de status é condicional, então uma suspensão aplicada no meio
  do processo não é sobrescrita.

## 4. Banco (909)

| Tabela/coluna | Para quê | Quem lê |
|---|---|---|
| `billing_plans.price_cents`, `currency`, `billing_interval` | preço (vazio = não vendido online) | todos os logados (catálogo) |
| `billing_subscriptions.provider`, `status`, `pending_*`, `cancel_at_period_end`, `canceled_at` | estado da assinatura | membros (sem os IDs do gateway) |
| `billing_customers` | organização ↔ cliente em cada gateway | só o servidor |
| `billing_payments` | cobranças, status normalizado, Pix copia e cola | **admins da própria organização** |
| `billing_webhook_events` | idempotência e trilha | só o servidor |

- **Cliente não grava nada.** Pagamento, assinatura e status são escritos
  só pelo servidor; um cliente não consegue marcar a própria cobrança
  como paga.
- **Status de pagamento é restrito** aos valores normalizados (`CHECK`):
  vocabulário de gateway não entra no banco.
- **Preços** são editados no painel e auditados como
  `billing_plan.updated` (`platform_update_plan_price`).
- A migration não define preços. No banco local coloquei Start R$ 99,90,
  Pro R$ 199,90 e Business R$ 499,90 **só para desenvolver**; ajuste em
  `/platform/plans`.

## 5. Gateway mock

- Clientes, assinaturas e cobranças ficam em memória do processo. Reiniciar
  o servidor esquece tudo, mas as tabelas do app guardam o histórico.
- Gera um **Pix copia e cola em formato BR Code válido** (EMV com CRC16
  correto). A chave é aleatória: o código não paga nada de verdade.
- Os webhooks são assinados com HMAC-SHA256 (header `x-mock-signature`,
  segredo `BILLING_MOCK_WEBHOOK_SECRET`) e passam pelo **mesmo caminho dos
  reais**: rota pública, assinatura, regras e banco.
- `simulate(paymentId, status)` e `simulateRenewal(subscriptionId)` fazem o
  papel do gateway. Na tela, em ambiente de teste, aparecem **“Simular
  pagamento”** e **“Simular atraso”**, que chamam
  `POST /api/billing/mock/payments/:id`. Essa rota responde 404 se o
  pagamento não for do mock ou se o mock não estiver permitido.
- **Em produção o mock é recusado.** `BILLING_PROVIDER=mock` lança erro, a
  menos que `BILLING_ALLOW_MOCK=true` (para staging).

## 6. Adicionar um gateway (ex.: Asaas)

1. Crie `src/integrations/payments/asaas/index.ts` com
   `class AsaasBillingProvider implements BillingProvider`:
   - **traduza status:** `RECEIVED`/`CONFIRMED` → `paid`, `OVERDUE` →
     `overdue`, `REFUNDED` → `refunded` etc.;
   - **converta valores** de reais para centavos;
   - **Pix:** `payload` → `copyPaste` e `encodedImage` →
     `qrCodeImage: 'data:image/png;base64,…'`;
   - **webhook:** confira o header `asaas-access-token` e mapeie
     `PAYMENT_*` → `payment.updated`; o id do evento é a chave de
     idempotência.
2. Registre em `src/integrations/payments/index.ts`:
   `registerBillingProvider('asaas', () => new AsaasBillingProvider({ apiKey: process.env.ASAAS_API_KEY! }))`.
3. Teste com `describeBillingProviderContract('asaas', { create, settle })`,
   usando o sandbox do gateway ou fixtures HTTP gravadas.
4. Configure `BILLING_PROVIDER=asaas` e cadastre no painel do gateway o
   webhook `https://SEU_DOMINIO/api/billing/webhooks/asaas`.

Mercado Pago, Efí e Pagar.me seguem o mesmo roteiro. Credenciais do
gateway ficam em variáveis de ambiente do servidor, nunca no navegador nem
no banco.

## 7. Verificado

- **Vitest:**
  - contrato do provider rodado contra o mock: assinatura com primeira
    cobrança Pix, cobrança avulsa, webhook autêntico, adulterado ou sem
    assinatura, cancelamento;
  - BR Code com CRC16 conferido pelo valor-padrão `29B1`;
  - regras: ativação, upgrade cancelando a assinatura antiga, renovação,
    atraso, reentrega, organização suspensa intocada, cancelamento no fim
    do período, troca de plano abandonada;
  - registro: mock recusado em produção;
  - travas de “nenhum gateway nas regras”;
  - parser de preço do painel.
- **pgTAP** (`billing_payments.test.sql`): chaves de idempotência, status
  só normalizados, admin vê só as cobranças da própria organização, agente
  não vê, cliente não forja nem marca como pago, expiração respeitando o
  período pago, preço só por platform admin e auditado.
- **Navegador**, organização QA no Pro manual:
  1. “Assinar Business” gerou um Pix de R$ 499,90 e a assinatura ficou
     pendente com o Pro ainda valendo;
  2. webhook sem assinatura devolveu 401 e o estado não mudou; gateway
     desconhecido devolveu 404;
  3. “Simular pagamento” levou a Business ativo até 06/11/2026, com o
     limite de WhatsApp passando a 3;
  4. cancelar deixou a assinatura cancelada, com o plano valendo até o fim
     do período;
  5. no painel, preço inválido foi recusado e o preço válido foi gravado e
     auditado.

  O estado local foi restaurado.

## 8. Pendências

- **Nota fiscal (NFS-e):** fica fora deste módulo. Alguns gateways emitem
  nota (o Asaas, por exemplo); quando chegar a hora, vale uma interface
  própria (`InvoiceProvider`).
- **Cobrança proporcional** em upgrade no meio do período: hoje o plano
  novo começa um período cheio no pagamento.
- **Boleto e cartão:** o contrato e as tabelas já aceitam; a tela oferece
  só Pix.
- **Dunning** (e-mails de cobrança e prazo antes de restringir): hoje
  vencido marca `past_due`, sem bloquear nada.
