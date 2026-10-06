# `src/billing` — planos, assinaturas e limites

Domínio de cobrança do SaaS: planos, assinatura por `account_id`,
contadores de uso e checagem de quota (ex.: `assertQuota(accountId, 'messages')`).

Regras:

- Pode importar: core **via** `@/custom/core/*` e `@/custom/*`.
- Não pode importar: `@/lib/**` diretamente, `@/modules/*`, `@/integrations/*`.
- Gateways de pagamento (Asaas, Iugu, Stripe, Pix…) **não** ficam aqui.
  O billing define a interface (`PaymentProvider`) e o adapter concreto fica em
  `src/integrations/payments/<gateway>`.
- Tabelas: prefixo `billing_` em migrations `9NN_billing_*.sql`, com RLS
  `is_account_member(...)` igual ao core.
- Strings: namespace `Billing.*`.

Conteúdo atual: `account-status.ts` — ciclo de vida da organização
(`accounts.status`, migration 902: trial → active → past_due → suspended →
cancelled), transições e helpers. Ver [`docs/TENANCY.md`](../../docs/TENANCY.md).

Conteúdo:

- `features.ts` — chaves de recurso (`max_users`, `ai_enabled`…) e regras puras.
- `entitlements.ts` — **serviço central** (servidor): `assertWithinLimit`,
  `assertFeatureEnabled`, `isFeatureEnabled`, `checkLimit`, `getEntitlements`.
- `usage.ts` — **UsageService** (`getUsage`, `canUseFeature`): uso por organização e
  checagem com mensagem e sugestão de upgrade ([`docs/USAGE.md`](../../docs/USAGE.md)).
- `usage-types.ts`, `usage-ui.tsx` — formato do relatório e o card “Uso neste mês”.
- `errors.ts` — `PlanLimitError`, reconhecimento do erro 53400 do banco, mensagem.
- `use-entitlements.ts`, `plan-ui.tsx` — leitura e telas no navegador.
- `access-policy.ts` — **política de inadimplência**: o que cada status
  bloqueia (uma matriz, igual ao SQL da 911 — `access-policy.test.ts`).
- `enforcement.ts` — `assertTenantCan` / `tenantCan` / `assertPhoneCan`, a
  única API que o app usa; `access-errors.ts` — recusa → 403 amigável;
  `access-notice.tsx` — aviso no painel ([`docs/DELINQUENCY.md`](../../docs/DELINQUENCY.md)).

Planos e valores ficam no banco (migration 907), nunca no código. Ver
[`docs/PLANS.md`](../../docs/PLANS.md).

## Pagamentos (P-012, [`docs/BILLING.md`](../../docs/BILLING.md))

- `payments/types.ts` — contrato `BillingProvider` e formatos normalizados.
- `payments/rules.ts` — regras puras (pagamento → plano/assinatura/status).
- `payments/service.ts` — `BillingService`, o único que fala com gateway e banco.
- `payments/contract.ts` — suíte de testes que todo gateway deve passar.
- `providers/` — registro + gateway `mock`. Gateways reais ficam em
  `src/integrations/payments/<nome>`; nada aqui fora de `providers/` pode citá-los.
- `subscription-card.tsx` — card “Assinatura”.
