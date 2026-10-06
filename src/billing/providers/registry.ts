/**
 * Payment provider registry (fork, docs/BILLING.md).
 *
 * Gateways register themselves; the billing domain asks for one by id
 * (the id stored with each subscription / payment) or for the active
 * one (`BILLING_PROVIDER`, default `mock` outside production). Billing
 * never imports a gateway: built-in providers live in ./ (mock), real
 * gateways in src/integrations/payments/<name> and register through
 * src/integrations/payments/index.ts, loaded by the fork routes.
 */
import type { BillingProvider } from '../payments/types';

type Factory = () => BillingProvider;

interface RegistryState {
  factories: Map<string, Factory>;
  instances: Map<string, BillingProvider>;
}

// globalThis: one registry per process, surviving dev-server module reloads.
const g = globalThis as typeof globalThis & {
  __billingProviders?: RegistryState;
};
const state: RegistryState = (g.__billingProviders ??= {
  factories: new Map(),
  instances: new Map(),
});

export function registerBillingProvider(id: string, factory: Factory): void {
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(id))
    throw new Error(`invalid provider id: ${id}`);
  state.factories.set(id, factory);
  state.instances.delete(id);
}

export function registeredBillingProviders(): string[] {
  return [...state.factories.keys()].sort();
}

export class UnknownBillingProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`billing provider "${providerId}" is not registered`);
    this.name = 'UnknownBillingProviderError';
  }
}

/** Provider to use for NEW customers / subscriptions. */
export function activeBillingProviderId(
  env: NodeJS.ProcessEnv = process.env
): string {
  const id = (env.BILLING_PROVIDER ?? '').trim() || 'mock';
  if (
    id === 'mock' &&
    env.NODE_ENV === 'production' &&
    env.BILLING_ALLOW_MOCK !== 'true'
  ) {
    throw new Error(
      'BILLING_PROVIDER=mock is not allowed in production (set a real gateway, or BILLING_ALLOW_MOCK=true for a staging deploy)'
    );
  }
  return id;
}

/** Provider by id (existing records keep their gateway), else the active one. */
export function getBillingProvider(id?: string | null): BillingProvider {
  const key = id ?? activeBillingProviderId();
  const cached = state.instances.get(key);
  if (cached) return cached;
  const factory = state.factories.get(key);
  if (!factory) throw new UnknownBillingProviderError(key);
  const instance = factory();
  if (instance.id !== key)
    throw new Error(
      `provider registered as "${key}" reports id "${instance.id}"`
    );
  state.instances.set(key, instance);
  return instance;
}
