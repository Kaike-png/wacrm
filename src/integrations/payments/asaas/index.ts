/**
 * Asaas payment gateway (fork, docs/ASAAS.md) — implements BillingProvider.
 *
 * Supported: customers, recurring subscriptions (Pix, boleto, credit
 * card), one-off Pix charges, payment lookup (with Pix QR code and the
 * boleto linha digitável), cancellation, webhooks.
 *
 * Card data never touches this application: card subscriptions are
 * created without card fields and the customer pays on the Asaas invoice
 * page (`invoiceUrl`), so the platform stays out of PCI scope.
 *
 * Webhook authenticity (Asaas docs, "Receba eventos do Asaas"): the
 * `authToken` configured on the webhook arrives in the header
 * `asaas-access-token`; compared in constant time with
 * ASAAS_WEBHOOK_TOKEN. Optionally the Asaas account id must match
 * ASAAS_ACCOUNT_ID.
 *
 * The token authenticates the sender but does not sign the body, so the
 * state is never taken from the payload alone: every payment/subscription
 * event is re-read from the Asaas API (authoritative, also immune to
 * out-of-order delivery). ASAAS_WEBHOOK_VERIFY=false disables it (tests).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BillingProviderError,
  InvalidWebhookError,
  type BillingEvent,
  type BillingProvider,
  type CustomerInput,
  type PixChargeInput,
  type ProviderPayment,
  type SubscriptionInput,
  type WebhookRequest,
} from '@/billing/payments/types';

import { AsaasApiError, AsaasClient, type FetchLike } from './client';
import { readAsaasConfig, type AsaasConfig } from './config';
import {
  asaasDateToIso,
  BILLING_TYPE,
  CYCLE,
  eventsFromWebhook,
  toProviderPayment,
  toProviderSubscription,
  todayInBrazil,
  toReais,
  type AsaasPayment,
  type AsaasPixQrCode,
  type AsaasSubscription,
  type AsaasWebhookBody,
} from './mapping';

export const ASAAS_PROVIDER_ID = 'asaas';
export const ASAAS_WEBHOOK_HEADER = 'asaas-access-token';
const MAX_WEBHOOK_BYTES = 256 * 1024;

function digitsOnly(v: string | null): string | null {
  const d = v?.replace(/\D/g, '') ?? '';
  return d || null;
}

/** +55 11 98765-4321 → 11987654321 (Asaas mobilePhone has no country code). */
function brazilianPhone(phone: string | null): string | null {
  let d = digitsOnly(phone);
  if (!d) return null;
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

function sameSecret(given: string, expected: string): boolean {
  // Hash first: constant time regardless of the length of what was sent.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AsaasBillingProvider implements BillingProvider {
  readonly id = ASAAS_PROVIDER_ID;
  readonly displayName: string;
  readonly capabilities;
  private readonly api: AsaasClient;

  constructor(
    private readonly config: AsaasConfig = readAsaasConfig(),
    fetchImpl?: FetchLike,
    private readonly pollDelayMs = 400,
    private readonly verifyWebhook = process.env.ASAAS_WEBHOOK_VERIFY !==
      'false'
  ) {
    this.api = new AsaasClient(config, fetchImpl);
    this.displayName =
      config.environment === 'sandbox' ? 'Asaas (sandbox)' : 'Asaas';
    this.capabilities = {
      methods: ['pix', 'boleto', 'card'] as const,
      recurring: true,
      sandbox: config.environment === 'sandbox',
      // Asaas requires CPF/CNPJ to create a customer.
      requiresTaxId: true,
    };
  }

  // ---------------------------------------------------------------- customers

  async createCustomer(input: CustomerInput) {
    const cpfCnpj =
      input.taxId?.replace(/[^0-9A-Za-z]/g, '').toUpperCase() || null;
    if (!cpfCnpj)
      throw new BillingProviderError(
        this.id,
        'Asaas requires CPF/CNPJ to create a customer'
      );
    const customer = await this.api.request<{ id: string }>(
      'POST',
      '/customers',
      {
        name: input.name.slice(0, 100),
        cpfCnpj,
        email: input.email ?? undefined,
        mobilePhone: brazilianPhone(input.phone) ?? undefined,
        externalReference: input.accountId,
      }
    );
    return { id: customer.id };
  }

  // ---------------------------------------------------------------- payments

  /** Payment + what is needed to pay it now (Pix QR / linha digitável). */
  private async enrich(p: AsaasPayment): Promise<ProviderPayment> {
    const base = toProviderPayment(p);
    if (base.status !== 'pending' && base.status !== 'overdue') return base;
    try {
      if (base.method === 'pix') {
        const qr = await this.api.request<AsaasPixQrCode>(
          'GET',
          `/payments/${encodeURIComponent(p.id)}/pixQrCode`
        );
        if (qr.payload) {
          base.pix = {
            copyPaste: qr.payload,
            qrCodeImage: qr.encodedImage
              ? `data:image/png;base64,${qr.encodedImage}`
              : null,
            expiresAt: asaasDateToIso(qr.expirationDate),
          };
        }
      } else if (base.method === 'boleto') {
        const line = await this.api.request<{ identificationField?: string }>(
          'GET',
          `/payments/${encodeURIComponent(p.id)}/identificationField`
        );
        base.boleto = {
          digitableLine: line.identificationField ?? null,
          url: p.bankSlipUrl ?? null,
        };
      }
    } catch (err) {
      // The charge exists; the customer can still pay on invoiceUrl.
      if (!(err instanceof AsaasApiError)) throw err;
      console.warn(
        `[asaas] could not load payment instructions for ${p.id}: ${err.message}`
      );
    }
    return base;
  }

  async getPayment(paymentId: string) {
    const p = await this.api.request<AsaasPayment>(
      'GET',
      `/payments/${encodeURIComponent(paymentId)}`
    );
    return this.enrich(p);
  }

  async createPixCharge(input: PixChargeInput) {
    const p = await this.api.request<AsaasPayment>('POST', '/payments', {
      customer: input.customerId,
      billingType: 'PIX',
      value: toReais(input.amountCents),
      dueDate: todayInBrazil(),
      description: input.description.slice(0, 500),
      externalReference: input.accountId,
    });
    return this.enrich(p);
  }

  // ---------------------------------------------------------------- subscriptions

  async createSubscription(input: SubscriptionInput) {
    if (input.currency !== 'BRL')
      throw new BillingProviderError(this.id, 'Asaas charges in BRL only');
    const sub = await this.api.request<AsaasSubscription>(
      'POST',
      '/subscriptions',
      {
        customer: input.customerId,
        billingType: BILLING_TYPE[input.method],
        value: toReais(input.amountCents),
        nextDueDate: todayInBrazil(),
        cycle: CYCLE[input.interval],
        description: input.description.slice(0, 500),
        externalReference: input.accountId,
      }
    );

    // Asaas generates the first charge right after creating the subscription.
    let first: AsaasPayment | undefined;
    for (let attempt = 0; attempt < 4 && !first; attempt++) {
      if (attempt > 0) await sleep(this.pollDelayMs * attempt);
      const list = await this.api.request<{ data?: AsaasPayment[] }>(
        'GET',
        `/subscriptions/${encodeURIComponent(sub.id)}/payments`
      );
      first = (list.data ?? []).sort((a, b) =>
        (a.dueDate ?? '').localeCompare(b.dueDate ?? '')
      )[0];
    }
    if (!first) {
      throw new BillingProviderError(
        this.id,
        `subscription ${sub.id} has no first charge yet`,
        true
      );
    }
    return {
      subscription: {
        ...toProviderSubscription(sub, input.interval),
        status: 'pending' as const,
      },
      firstPayment: await this.enrich(first),
    };
  }

  /**
   * Asaas has no "cancel at period end": removing the subscription stops
   * future charges. The paid period is honoured by our side
   * (current_period_end + the billing cron), so both modes remove it.
   */
  async cancelSubscription(
    subscriptionId: string,
    opts: { atPeriodEnd: boolean }
  ) {
    try {
      await this.api.request<{ deleted?: boolean }>(
        'DELETE',
        `/subscriptions/${encodeURIComponent(subscriptionId)}`
      );
    } catch (err) {
      // Already removed at Asaas: the desired end state holds.
      if (!(err instanceof AsaasApiError && err.status === 404)) throw err;
    }
    return {
      id: subscriptionId,
      customerId: '',
      status: 'canceled' as const,
      amountCents: 0,
      currency: 'BRL',
      interval: 'month' as const,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: opts.atPeriodEnd,
    };
  }

  // ---------------------------------------------------------------- webhooks

  async parseWebhook(request: WebhookRequest): Promise<BillingEvent[]> {
    const expected = this.config.webhookToken;
    if (!expected)
      throw new InvalidWebhookError('ASAAS_WEBHOOK_TOKEN is not configured');
    const given = request.headers.get(ASAAS_WEBHOOK_HEADER) ?? '';
    if (!given || !sameSecret(given, expected))
      throw new InvalidWebhookError('bad asaas-access-token');
    if (request.rawBody.length > MAX_WEBHOOK_BYTES)
      throw new InvalidWebhookError('body too large');

    let body: AsaasWebhookBody;
    try {
      body = JSON.parse(request.rawBody) as AsaasWebhookBody;
    } catch {
      throw new InvalidWebhookError('body is not JSON');
    }
    if (
      this.config.accountId &&
      body.account?.id &&
      body.account.id !== this.config.accountId
    ) {
      throw new InvalidWebhookError('event from another Asaas account');
    }
    let events: BillingEvent[];
    try {
      events = eventsFromWebhook(body);
    } catch (err) {
      throw new InvalidWebhookError(
        err instanceof Error ? err.message : 'malformed event'
      );
    }
    return this.verifyWebhook
      ? Promise.all(events.map((e) => this.confirmWithApi(e)))
      : events;
  }

  /** Replace the payload's state with what the Asaas API says now. */
  private async confirmWithApi(event: BillingEvent): Promise<BillingEvent> {
    if (event.payment) {
      const claimed = event.payment;
      let fresh: ProviderPayment;
      try {
        fresh = toProviderPayment(
          await this.api.request<AsaasPayment>(
            'GET',
            `/payments/${encodeURIComponent(claimed.id)}`
          )
        );
      } catch (err) {
        if (err instanceof AsaasApiError && err.status === 404) {
          // Removed at Asaas (PAYMENT_DELETED) — or never existed: keep the
          // payload ids but grant nothing.
          return {
            ...event,
            payment: { ...claimed, status: 'canceled', paidAt: null },
          };
        }
        throw err; // retry later (5xx to Asaas)
      }
      // Events more specific than the stored status (risk analysis refused,
      // card capture refused) only ever downgrade, never grant service.
      const status =
        fresh.status === 'pending' &&
        (claimed.status === 'failed' || claimed.status === 'canceled')
          ? claimed.status
          : fresh.status;
      return { ...event, payment: { ...fresh, status } };
    }
    if (event.subscription) {
      try {
        const s = await this.api.request<AsaasSubscription>(
          'GET',
          `/subscriptions/${encodeURIComponent(event.subscription.id)}`
        );
        const fresh = toProviderSubscription(s, event.subscription.interval);
        return {
          ...event,
          subscription: {
            ...fresh,
            status: s.deleted ? 'canceled' : fresh.status,
          },
        };
      } catch (err) {
        if (err instanceof AsaasApiError && err.status === 404) {
          return {
            ...event,
            subscription: { ...event.subscription, status: 'canceled' },
          };
        }
        throw err;
      }
    }
    return event;
  }
}
