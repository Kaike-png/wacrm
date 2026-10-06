/**
 * Asaas configuration (fork, docs/ASAAS.md) — from environment only.
 *
 *   ASAAS_API_KEY        required. `$aact_prod_…` (production) or
 *                        `$aact_hmlg_…` (sandbox); never logged, never sent
 *                        to the browser, never stored in the database.
 *   ASAAS_ENVIRONMENT    sandbox | production. Optional when the key prefix
 *                        tells; a mismatch is refused (the Asaas API would
 *                        answer 401 invalid_environment anyway).
 *   ASAAS_WEBHOOK_TOKEN  required to accept webhooks: the `authToken` set
 *                        on the Asaas webhook (32–255 chars, no spaces, not
 *                        an API key — Asaas rules).
 *   ASAAS_ACCOUNT_ID     optional. When set, webhooks for any other Asaas
 *                        account are refused (defense if the token leaks
 *                        across environments).
 *   ASAAS_API_URL        optional override (tests / local fake server).
 */

import { BillingProviderUnavailableError } from '@/billing/payments/types';

export type AsaasEnvironment = 'sandbox' | 'production';

export interface AsaasConfig {
  apiKey: string;
  environment: AsaasEnvironment;
  baseUrl: string;
  webhookToken: string | null;
  accountId: string | null;
  userAgent: string;
}

export const ASAAS_BASE_URLS: Record<AsaasEnvironment, string> = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};

/** Configuration problem — message never contains a secret. */
export class AsaasConfigError extends BillingProviderUnavailableError {
  constructor(message: string) {
    super(`[asaas] ${message}`);
    this.name = 'AsaasConfigError';
  }
}

function environmentFromKey(key: string): AsaasEnvironment | null {
  if (key.startsWith('$aact_prod_')) return 'production';
  if (key.startsWith('$aact_hmlg_')) return 'sandbox';
  return null;
}

export function isAsaasConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return !!env.ASAAS_API_KEY?.trim();
}

export function readAsaasConfig(
  env: NodeJS.ProcessEnv = process.env
): AsaasConfig {
  const apiKey = env.ASAAS_API_KEY?.trim() ?? '';
  if (!apiKey) throw new AsaasConfigError('ASAAS_API_KEY is not set');

  const declared = env.ASAAS_ENVIRONMENT?.trim().toLowerCase() || null;
  if (declared && declared !== 'sandbox' && declared !== 'production') {
    throw new AsaasConfigError(
      'ASAAS_ENVIRONMENT must be "sandbox" or "production"'
    );
  }
  const fromKey = environmentFromKey(apiKey);
  if (declared && fromKey && declared !== fromKey) {
    throw new AsaasConfigError(
      `ASAAS_ENVIRONMENT=${declared} but the API key belongs to ${fromKey}`
    );
  }
  const environment = (declared ?? fromKey ?? 'sandbox') as AsaasEnvironment;

  const webhookToken = env.ASAAS_WEBHOOK_TOKEN?.trim() || null;
  if (webhookToken) {
    if (
      webhookToken.length < 32 ||
      webhookToken.length > 255 ||
      /\s/.test(webhookToken)
    ) {
      throw new AsaasConfigError(
        'ASAAS_WEBHOOK_TOKEN must have 32–255 characters and no spaces'
      );
    }
    if (webhookToken === apiKey || webhookToken.startsWith('$aact_')) {
      throw new AsaasConfigError('ASAAS_WEBHOOK_TOKEN must not be an API key');
    }
  }

  const override = env.ASAAS_API_URL?.trim().replace(/\/+$/, '') || null;
  if (
    override &&
    environment === 'production' &&
    env.NODE_ENV === 'production' &&
    !override.startsWith('https://')
  ) {
    throw new AsaasConfigError('ASAAS_API_URL must be https in production');
  }

  return {
    apiKey,
    environment,
    baseUrl: override ?? ASAAS_BASE_URLS[environment],
    webhookToken,
    accountId: env.ASAAS_ACCOUNT_ID?.trim() || null,
    // Required by Asaas for accounts created after 13/06/2024.
    userAgent:
      env.ASAAS_USER_AGENT?.trim() ||
      `${env.NEXT_PUBLIC_APP_NAME?.trim() || 'CRM'} (billing)`,
  };
}
