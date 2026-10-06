/**
 * Payment gateway adapters (fork, docs/BILLING.md) — composition root.
 *
 * Each gateway lives in ./<name>/ and implements BillingProvider
 * (src/billing/payments/types.ts). Registered here; the fork routes import
 * this module once, so the billing domain finds gateways by id without
 * ever importing one.
 *
 * Available: asaas (docs/ASAAS.md). Planned: mercadopago, efi, pagarme.
 * `mock` (built into src/billing/providers) covers development.
 */
import '@/billing/providers';
import { registerBillingProvider } from '@/billing/providers';

import { ASAAS_PROVIDER_ID, AsaasBillingProvider } from './asaas';

// The factory runs on first use; a missing ASAAS_API_KEY then surfaces as
// "billing unavailable" (503) instead of breaking unrelated routes.
registerBillingProvider(ASAAS_PROVIDER_ID, () => new AsaasBillingProvider());

export {};
