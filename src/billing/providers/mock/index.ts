/**
 * Mock payment gateway (fork, docs/BILLING.md) — development and tests.
 *
 * Behaves like a real gateway from the app's point of view: customers,
 * subscriptions with a first Pix charge, one-off Pix charges, signed
 * webhooks. State lives in this process (globalThis, survives dev reloads;
 * a server restart forgets it — the app's own tables keep the history).
 *
 * Extra, mock-only: `simulate(paymentId, status)` changes a payment "at the
 * gateway" and returns the signed webhook it would send, so the whole path
 * (signature → parse → rules → database) runs for real in development.
 *
 * Webhook auth: header `x-mock-signature` = hex HMAC-SHA256 of the raw body
 * with BILLING_MOCK_WEBHOOK_SECRET (a fixed dev default when unset).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  BillingProviderError,
  InvalidWebhookError,
  type BillingEvent,
  type BillingInterval,
  type BillingProvider,
  type CustomerInput,
  type PaymentStatus,
  type PixChargeInput,
  type ProviderPayment,
  type ProviderSubscription,
  type SubscriptionInput,
  type WebhookRequest,
} from '../../payments/types';
import { addInterval } from '../../payments/rules';

import { buildPixCopyPaste } from './pix';

export const MOCK_PROVIDER_ID = 'mock';
export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';
const DEV_SECRET = 'mock-webhook-secret-dev';

interface MockState {
  customers: Map<string, CustomerInput & { id: string }>;
  subscriptions: Map<
    string,
    ProviderSubscription & { accountId: string; planCode: string }
  >;
  payments: Map<string, ProviderPayment>;
}

const g = globalThis as typeof globalThis & { __mockGateway?: MockState };

function store(): MockState {
  return (g.__mockGateway ??= {
    customers: new Map(),
    subscriptions: new Map(),
    payments: new Map(),
  });
}

/** Tests: forget everything. */
export function resetMockGateway(): void {
  g.__mockGateway = undefined;
}

const id = (prefix: string) =>
  `${prefix}_mock_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const today = () => new Date().toISOString().slice(0, 10);

export function mockWebhookSecret(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.BILLING_MOCK_WEBHOOK_SECRET?.trim() || DEV_SECRET;
}

export function signMockWebhook(
  rawBody: string,
  secret = mockWebhookSecret()
): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export class MockBillingProvider implements BillingProvider {
  readonly id = MOCK_PROVIDER_ID;
  readonly displayName = 'Mock (desenvolvimento)';
  readonly capabilities = {
    methods: ['pix', 'boleto', 'card'] as const,
    recurring: true,
    sandbox: true,
    requiresTaxId: false,
    simulator: true,
  };

  constructor(private readonly secret = mockWebhookSecret()) {}

  async createCustomer(input: CustomerInput) {
    const customer = { ...input, id: id('cus') };
    store().customers.set(customer.id, customer);
    return { id: customer.id };
  }

  private newPayment(input: {
    customerId: string;
    accountId: string;
    subscriptionId: string | null;
    amountCents: number;
    currency: string;
    description: string;
    method: ProviderPayment['method'];
    periodStart?: Date;
    interval?: BillingInterval;
    expiresInSeconds?: number;
  }): ProviderPayment {
    const paymentId = id('pay');
    const expires = new Date(
      Date.now() + (input.expiresInSeconds ?? 24 * 3600) * 1000
    );
    const payment: ProviderPayment = {
      id: paymentId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      externalReference: input.accountId,
      status: 'pending',
      method: input.method,
      amountCents: input.amountCents,
      currency: input.currency,
      description: input.description,
      dueDate: today(),
      paidAt: null,
      periodStart: input.periodStart?.toISOString() ?? null,
      periodEnd:
        input.periodStart && input.interval
          ? addInterval(input.periodStart, input.interval).toISOString()
          : null,
      pix:
        input.method === 'pix'
          ? {
              copyPaste: buildPixCopyPaste({
                key: randomUUID(),
                amountCents: input.amountCents,
                merchantName: 'CRM MOCK',
                merchantCity: 'SAO PAULO',
                txid: paymentId,
              }),
              qrCodeImage: null,
              expiresAt: expires.toISOString(),
            }
          : null,
      boleto:
        input.method === 'boleto'
          ? {
              digitableLine:
                '00190000090000000000000000000000100000000' +
                String(input.amountCents).padStart(6, '0').slice(-6),
              url: null,
            }
          : null,
      invoiceUrl: null,
    };
    store().payments.set(paymentId, payment);
    return { ...payment };
  }

  async createSubscription(input: SubscriptionInput) {
    if (!store().customers.has(input.customerId)) {
      throw new BillingProviderError(
        this.id,
        `unknown customer ${input.customerId}`
      );
    }
    const subscription: ProviderSubscription & {
      accountId: string;
      planCode: string;
    } = {
      id: id('sub'),
      customerId: input.customerId,
      status: 'pending',
      amountCents: input.amountCents,
      currency: input.currency,
      interval: input.interval,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      accountId: input.accountId,
      planCode: input.planCode,
    };
    store().subscriptions.set(subscription.id, subscription);
    const firstPayment = this.newPayment({
      customerId: input.customerId,
      accountId: input.accountId,
      subscriptionId: subscription.id,
      amountCents: input.amountCents,
      currency: input.currency,
      description: input.description,
      method: input.method,
      periodStart: new Date(),
      interval: input.interval,
    });
    return { subscription: this.publicSub(subscription), firstPayment };
  }

  async cancelSubscription(
    subscriptionId: string,
    opts: { atPeriodEnd: boolean }
  ) {
    const sub = store().subscriptions.get(subscriptionId);
    if (!sub)
      throw new BillingProviderError(
        this.id,
        `unknown subscription ${subscriptionId}`
      );
    sub.status = 'canceled';
    sub.cancelAtPeriodEnd = opts.atPeriodEnd;
    if (!opts.atPeriodEnd) sub.currentPeriodEnd = new Date().toISOString();
    return this.publicSub(sub);
  }

  async createPixCharge(input: PixChargeInput) {
    if (!store().customers.has(input.customerId)) {
      throw new BillingProviderError(
        this.id,
        `unknown customer ${input.customerId}`
      );
    }
    return this.newPayment({ ...input, subscriptionId: null, method: 'pix' });
  }

  async getPayment(paymentId: string) {
    const p = store().payments.get(paymentId);
    if (!p)
      throw new BillingProviderError(
        this.id,
        `unknown payment ${paymentId} (the mock forgets on restart)`
      );
    return { ...p };
  }

  async parseWebhook(request: WebhookRequest): Promise<BillingEvent[]> {
    const given = request.headers.get(MOCK_SIGNATURE_HEADER) ?? '';
    const expected = signMockWebhook(request.rawBody, this.secret);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new InvalidWebhookError('bad mock signature');
    let body: unknown;
    try {
      body = JSON.parse(request.rawBody);
    } catch {
      throw new InvalidWebhookError('body is not JSON');
    }
    const events = Array.isArray(body) ? body : [body];
    for (const e of events as BillingEvent[]) {
      if (
        !e ||
        typeof e.id !== 'string' ||
        (e.type !== 'payment.updated' && e.type !== 'subscription.updated')
      ) {
        throw new InvalidWebhookError('malformed mock event');
      }
    }
    return events as BillingEvent[];
  }

  // ---------------------------------------------------------------- mock-only

  private publicSub(
    s: ProviderSubscription & { accountId: string; planCode: string }
  ): ProviderSubscription {
    const { accountId: _a, planCode: _p, ...rest } = s;
    void _a;
    void _p;
    return { ...rest };
  }

  /**
   * Change a payment "at the gateway" and return the webhook it would send.
   * `paid` on a subscription's charge also activates / renews it there.
   */
  simulate(
    paymentId: string,
    status: PaymentStatus
  ): { rawBody: string; headers: Headers; event: BillingEvent } {
    const p = store().payments.get(paymentId);
    if (!p)
      throw new BillingProviderError(this.id, `unknown payment ${paymentId}`);
    p.status = status;
    if (status === 'paid') p.paidAt = new Date().toISOString();
    if (p.subscriptionId && status === 'paid') {
      const sub = store().subscriptions.get(p.subscriptionId);
      if (sub && sub.status !== 'canceled') {
        sub.status = 'active';
        sub.currentPeriodEnd = p.periodEnd;
      }
    }
    return this.webhookFor({
      id: id('evt'),
      type: 'payment.updated',
      occurredAt: new Date().toISOString(),
      payment: { ...p },
    });
  }

  /** Next period's charge of a subscription (to test renewals). */
  simulateRenewal(subscriptionId: string, status: PaymentStatus = 'paid') {
    const sub = store().subscriptions.get(subscriptionId);
    if (!sub)
      throw new BillingProviderError(
        this.id,
        `unknown subscription ${subscriptionId}`
      );
    const start = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd)
      : new Date();
    const next = this.newPayment({
      customerId: sub.customerId,
      accountId: sub.accountId,
      subscriptionId: sub.id,
      amountCents: sub.amountCents,
      currency: sub.currency,
      description: `Renovação ${sub.planCode}`,
      method: 'pix',
      periodStart: start,
      interval: sub.interval,
    });
    return this.simulate(next.id, status);
  }

  webhookFor(event: BillingEvent) {
    const rawBody = JSON.stringify(event);
    const headers = new Headers({
      'content-type': 'application/json',
      [MOCK_SIGNATURE_HEADER]: signMockWebhook(rawBody, this.secret),
    });
    return { rawBody, headers, event };
  }
}
