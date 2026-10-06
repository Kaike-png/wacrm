/**
 * Built-in payment providers (fork, docs/BILLING.md). Importing this
 * module registers them. Real gateways (Asaas, Mercado Pago, Efí,
 * Pagar.me…) live in src/integrations/payments/<name> and register from
 * src/integrations/payments/index.ts.
 */
import { MockBillingProvider, MOCK_PROVIDER_ID } from './mock';
import { registerBillingProvider } from './registry';

registerBillingProvider(MOCK_PROVIDER_ID, () => new MockBillingProvider());

export {
  activeBillingProviderId,
  getBillingProvider,
  registerBillingProvider,
  registeredBillingProviders,
  UnknownBillingProviderError,
} from './registry';
