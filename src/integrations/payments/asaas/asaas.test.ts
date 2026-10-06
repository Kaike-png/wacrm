import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeBillingProviderContract } from '@/billing/payments/contract';
import { decideEffects, type RuleContext } from '@/billing/payments/rules';
import {
  BillingProviderError,
  InvalidWebhookError,
} from '@/billing/payments/types';
import { redactSecrets } from '@/custom/whatsapp/redact';

import { AsaasBillingProvider } from './index';
import { readAsaasConfig, type AsaasConfig } from './config';
import {
  asaasDateToIso,
  eventsFromWebhook,
  paymentStatusFromAsaas,
  toCents,
} from './mapping';
import { createFakeAsaas, type FakeAsaas } from './testing/fake-asaas';

const API_KEY =
  '$aact_hmlg_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OmFiY2RlZg';
const WEBHOOK_TOKEN = 'whk_9f8e7d6c5b4a39281706f5e4d3c2b1a0_test';

const config = (over: Partial<AsaasConfig> = {}): AsaasConfig => ({
  apiKey: API_KEY,
  environment: 'sandbox',
  baseUrl: 'https://api-sandbox.asaas.com/v3',
  webhookToken: WEBHOOK_TOKEN,
  accountId: null,
  userAgent: 'CRM (billing)',
  ...over,
});

const customer = {
  accountId: '00000000-0000-4000-8000-000000000001',
  name: 'Padaria Pão Quente Ltda',
  email: 'financeiro@paoquente.com.br',
  taxId: '11.222.333/0001-81',
  phone: '+55 11 98765-4321',
};

function setup(over: Partial<AsaasConfig> = {}) {
  const fake = createFakeAsaas({
    apiKey: API_KEY,
    webhookToken: WEBHOOK_TOKEN,
  });
  const provider = new AsaasBillingProvider(config(over), fake.fetch, 0);
  return { fake, provider };
}

// --------------------------------------------------------------- contract

let contractFake: FakeAsaas;
describeBillingProviderContract('asaas', {
  create: () => {
    contractFake = createFakeAsaas({
      apiKey: API_KEY,
      webhookToken: WEBHOOK_TOKEN,
    });
    return new AsaasBillingProvider(config(), contractFake.fetch, 0);
  },
  settle: async (_p, paymentId, status) => {
    const event =
      status === 'paid'
        ? 'PAYMENT_RECEIVED'
        : status === 'overdue'
          ? 'PAYMENT_OVERDUE'
          : 'PAYMENT_DELETED';
    const { headers, rawBody } = contractFake.settle(paymentId, event);
    return { headers, rawBody };
  },
  signsBody: false, // token-only: state is confirmed with the API instead (tests below)
});

// --------------------------------------------------------------- configuration

describe('asaas config (environment variables only)', () => {
  const base = {
    NODE_ENV: 'test',
    ASAAS_API_KEY: API_KEY,
    ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
  } as NodeJS.ProcessEnv;

  it('derives the environment and base URL from the key prefix', () => {
    expect(readAsaasConfig({ ...base }).baseUrl).toBe(
      'https://api-sandbox.asaas.com/v3'
    );
    expect(
      readAsaasConfig({
        ...base,
        ASAAS_API_KEY: '$aact_prod_abc123456789',
        ASAAS_WEBHOOK_TOKEN: '',
      }).baseUrl
    ).toBe('https://api.asaas.com/v3');
  });

  it('refuses inconsistent or unsafe configuration without echoing secrets', () => {
    const fail = (env: NodeJS.ProcessEnv) => {
      try {
        readAsaasConfig(env);
      } catch (e) {
        return (e as Error).message;
      }
      return 'no error';
    };
    expect(fail({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toMatch(
      /ASAAS_API_KEY is not set/
    );
    const mismatch = fail({ ...base, ASAAS_ENVIRONMENT: 'production' });
    expect(mismatch).toMatch(/belongs to sandbox/);
    expect(fail({ ...base, ASAAS_WEBHOOK_TOKEN: 'short' })).toMatch(/32–255/);
    expect(
      fail({
        ...base,
        ASAAS_WEBHOOK_TOKEN: 'a'.repeat(20) + ' ' + 'b'.repeat(20),
      })
    ).toMatch(/no spaces/);
    expect(
      fail({ ...base, ASAAS_WEBHOOK_TOKEN: '$aact_prod_' + 'x'.repeat(40) })
    ).toMatch(/not be an API key/);
    for (const msg of [mismatch]) expect(msg).not.toContain(API_KEY);
  });
});

// --------------------------------------------------------------- API usage

describe('asaas API calls', () => {
  it('customer: CPF/CNPJ without mask, phone without +55, our id as externalReference', async () => {
    const { fake, provider } = setup();
    await provider.createCustomer(customer);
    const req = fake.requests.find((r) => r.path === '/customers')!;
    expect(req.body).toMatchObject({
      name: 'Padaria Pão Quente Ltda',
      cpfCnpj: '11222333000181',
      mobilePhone: '11987654321',
      externalReference: customer.accountId,
    });
    await expect(
      provider.createCustomer({ ...customer, taxId: null })
    ).rejects.toThrow(/CPF\/CNPJ/);
  });

  it('API key only in the access_token header (with User-Agent), never in URL or body', async () => {
    const { fake, provider } = setup();
    const { id } = await provider.createCustomer(customer);
    await provider.createPixCharge({
      customerId: id,
      accountId: 'acc',
      amountCents: 4990,
      currency: 'BRL',
      description: 'x',
    });
    for (const r of fake.requests) {
      expect(r.headers['access_token']).toBe(API_KEY);
      expect(r.headers['user-agent']).toBeTruthy();
      expect(r.path).not.toContain('aact');
      expect(JSON.stringify(r.body ?? {})).not.toContain('aact');
    }
  });

  it('recurring Pix: cycle, value in reais, first charge with QR code and copia e cola', async () => {
    const { fake, provider } = setup();
    const { id } = await provider.createCustomer(customer);
    const { subscription, firstPayment } = await provider.createSubscription({
      customerId: id,
      accountId: customer.accountId,
      planCode: 'pro',
      description: 'Plano Pro',
      amountCents: 19990,
      currency: 'BRL',
      interval: 'year',
      method: 'pix',
    });
    expect(
      fake.requests.find(
        (r) => r.method === 'POST' && r.path === '/subscriptions'
      )!.body
    ).toMatchObject({
      billingType: 'PIX',
      value: 199.9,
      cycle: 'YEARLY',
      externalReference: customer.accountId,
    });
    expect(subscription.status).toBe('pending');
    expect(firstPayment).toMatchObject({
      status: 'pending',
      method: 'pix',
      amountCents: 19990,
      subscriptionId: subscription.id,
    });
    expect(firstPayment.pix?.copyPaste).toMatch(/^000201/);
    expect(firstPayment.pix?.qrCodeImage).toMatch(/^data:image\/png;base64,/);
  });

  it('recurring boleto: linha digitável and PDF', async () => {
    const { provider } = setup();
    const { id } = await provider.createCustomer(customer);
    const { firstPayment } = await provider.createSubscription({
      customerId: id,
      accountId: 'acc',
      planCode: 'pro',
      description: 'Plano Pro',
      amountCents: 19990,
      currency: 'BRL',
      interval: 'month',
      method: 'boleto',
    });
    expect(firstPayment.method).toBe('boleto');
    expect(firstPayment.boleto?.digitableLine).toMatch(/^\d{47}$/);
    expect(firstPayment.boleto?.url).toMatch(/^https:\/\//);
  });

  it('recurring card: no card data sent — the customer pays on the Asaas invoice page', async () => {
    const { fake, provider } = setup();
    const { id } = await provider.createCustomer(customer);
    const { firstPayment } = await provider.createSubscription({
      customerId: id,
      accountId: 'acc',
      planCode: 'pro',
      description: 'Plano Pro',
      amountCents: 19990,
      currency: 'BRL',
      interval: 'month',
      method: 'card',
    });
    const body = fake.requests.find(
      (r) => r.method === 'POST' && r.path === '/subscriptions'
    )!.body as Record<string, unknown>;
    expect(body.billingType).toBe('CREDIT_CARD');
    expect(body).not.toHaveProperty('creditCard');
    expect(body).not.toHaveProperty('creditCardHolderInfo');
    expect(firstPayment.method).toBe('card');
    expect(firstPayment.invoiceUrl).toMatch(/^https:\/\//);
    expect(firstPayment.pix).toBeNull();
  });

  it('lookup and cancellation (already removed at Asaas is fine)', async () => {
    const { fake, provider } = setup();
    const { id } = await provider.createCustomer(customer);
    const { subscription, firstPayment } = await provider.createSubscription({
      customerId: id,
      accountId: 'acc',
      planCode: 'pro',
      description: 'Plano Pro',
      amountCents: 19990,
      currency: 'BRL',
      interval: 'month',
      method: 'pix',
    });
    fake.settle(firstPayment.id, 'PAYMENT_RECEIVED');
    const paid = await provider.getPayment(firstPayment.id);
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).toBe('2026-10-06T03:00:00.000Z');
    expect(paid.pix).toBeNull(); // nothing left to pay
    expect(
      (
        await provider.cancelSubscription(subscription.id, {
          atPeriodEnd: true,
        })
      ).status
    ).toBe('canceled');
    expect(fake.subscriptions.get(subscription.id)?.deleted).toBe(true);
    await expect(
      provider.cancelSubscription(subscription.id, { atPeriodEnd: true })
    ).resolves.toMatchObject({ status: 'canceled' });
  });

  it('errors: Asaas descriptions kept, key never included; 429/5xx retryable, 4xx not', async () => {
    const respond = (status: number, body: unknown) =>
      new AsaasBillingProvider(
        config(),
        async () => new Response(JSON.stringify(body), { status }),
        0
      );
    const err = async (
      p: AsaasBillingProvider
    ): Promise<BillingProviderError> =>
      p.getPayment('pay_1').then(
        () => {
          throw new Error('expected failure');
        },
        (e: BillingProviderError) => e
      );

    const bad = await err(
      respond(400, {
        errors: [{ code: 'invalid_value', description: 'Valor inválido' }],
      })
    );
    expect(bad).toBeInstanceOf(BillingProviderError);
    expect(bad.message).toContain('Valor inválido');
    expect(bad.retryable).toBe(false);
    expect((await err(respond(429, {}))).retryable).toBe(true);
    expect((await err(respond(503, {}))).retryable).toBe(true);
    const unauthorized = await err(
      respond(401, {
        errors: [
          { code: 'invalid_access_token', description: 'Chave inválida' },
        ],
      })
    );
    expect(unauthorized.message).not.toContain(API_KEY);
    const network = await err(
      new AsaasBillingProvider(
        config(),
        async () => {
          throw new TypeError(`fetch failed for ${API_KEY}`);
        },
        0
      )
    );
    expect(network.retryable).toBe(true);
    expect(network.message).not.toContain(API_KEY);
  });

  it('log redaction covers Asaas keys and the webhook header', () => {
    expect(redactSecrets(`key=${API_KEY} done`)).not.toContain('MzkwODA2');
    expect(
      redactSecrets(`{"asaas-access-token":"${WEBHOOK_TOKEN}"}`)
    ).not.toContain(WEBHOOK_TOKEN);
  });
});

// --------------------------------------------------------------- webhooks

describe('asaas webhooks', () => {
  let fake: FakeAsaas;
  let provider: AsaasBillingProvider;
  beforeEach(() => ({ fake, provider } = setup()));

  it('authentic (asaas-access-token) → normalized payment event, Asaas event id as idempotency key', async () => {
    const pay = await provider.createCustomer(customer).then(({ id }) =>
      provider.createPixCharge({
        customerId: id,
        accountId: 'acc',
        amountCents: 100,
        currency: 'BRL',
        description: 'x',
      })
    );
    const hook = fake.settle(pay.id, 'PAYMENT_RECEIVED');
    const [event] = await provider.parseWebhook(hook);
    expect(event.id).toBe(hook.body.id);
    expect(event.id).toContain('&'); // Asaas ids look like evt_…&123
    expect(event).toMatchObject({
      type: 'payment.updated',
      payment: { id: pay.id, status: 'paid', amountCents: 100 },
    });
  });

  it('refuses missing / wrong token, unconfigured token, other account, oversized or non-JSON bodies', async () => {
    const hook = fake.webhook({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_1', status: 'RECEIVED', value: 1 },
    });
    const bad = (headers: Headers, rawBody = hook.rawBody, p = provider) =>
      expect(p.parseWebhook({ headers, rawBody })).rejects.toBeInstanceOf(
        InvalidWebhookError
      );
    await bad(new Headers());
    await bad(new Headers({ 'asaas-access-token': WEBHOOK_TOKEN + 'x' }));
    await bad(
      new Headers({ 'asaas-access-token': WEBHOOK_TOKEN.toUpperCase() })
    );
    await bad(
      hook.headers,
      hook.rawBody,
      new AsaasBillingProvider(config({ webhookToken: null }), fake.fetch, 0)
    );
    await bad(
      hook.headers,
      hook.rawBody,
      new AsaasBillingProvider(
        config({ accountId: 'outra-conta' }),
        fake.fetch,
        0
      )
    );
    await bad(hook.headers, 'not json');
    await bad(hook.headers, JSON.stringify({ event: 'PAYMENT_RECEIVED' })); // no id → cannot be idempotent
    await bad(hook.headers, ' '.repeat(300 * 1024));
  });

  it('forged state with a leaked token: the API, not the payload, decides', async () => {
    const pay = await provider.createCustomer(customer).then(({ id }) =>
      provider.createPixCharge({
        customerId: id,
        accountId: 'acc',
        amountCents: 100,
        currency: 'BRL',
        description: 'x',
      })
    );
    // Claims RECEIVED with a different value — Asaas still has it PENDING.
    const forged = fake.webhook({
      event: 'PAYMENT_RECEIVED',
      payment: { ...fake.payments.get(pay.id)!, status: 'RECEIVED', value: 1 },
    });
    const [e] = await provider.parseWebhook(forged);
    expect(e.payment).toMatchObject({ status: 'pending', amountCents: 100 });
    // Unknown payment id → nothing granted.
    const ghost = fake.webhook({
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_ghost', status: 'RECEIVED', value: 9999 },
    });
    expect((await provider.parseWebhook(ghost))[0].payment?.status).toBe(
      'canceled'
    );
    // Out of order: OVERDUE delivered after the payment was received → API says paid.
    fake.settle(pay.id, 'PAYMENT_RECEIVED');
    const late = fake.webhook({
      event: 'PAYMENT_OVERDUE',
      payment: { ...fake.payments.get(pay.id)!, status: 'OVERDUE' },
    });
    expect((await provider.parseWebhook(late))[0].payment?.status).toBe('paid');
  });

  it('informational events are acknowledged without effects; unknown fields do not break parsing', async () => {
    for (const event of [
      'PAYMENT_CHECKOUT_VIEWED',
      'PAYMENT_BANK_SLIP_VIEWED',
      'PAYMENT_SPLIT_DONE',
      'SUBSCRIPTION_CREATED',
      'SOMETHING_NEW',
    ]) {
      const hook = fake.webhook({
        event,
        payment: { id: 'pay_1', status: 'PENDING', value: 1 },
      });
      expect(await provider.parseWebhook(hook)).toEqual([]);
    }
    const pay = await provider.createCustomer(customer).then(({ id }) =>
      provider.createPixCharge({
        customerId: id,
        accountId: 'acc',
        amountCents: 100,
        currency: 'BRL',
        description: 'x',
      })
    );
    fake.settle(pay.id, 'PAYMENT_OVERDUE');
    const withExtra = fake.webhook({
      event: 'PAYMENT_OVERDUE',
      payment: {
        ...fake.payments.get(pay.id)!,
        brandNewField: { x: 1 },
      } as never,
    });
    expect((await provider.parseWebhook(withExtra))[0].payment?.status).toBe(
      'overdue'
    );
  });

  it('subscription removed / inactivated → canceled', () => {
    for (const event of ['SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED']) {
      const [e] = eventsFromWebhook({
        id: 'evt_1',
        event,
        subscription: {
          id: 'sub_1',
          customer: 'cus_1',
          value: 10,
          status: 'ACTIVE',
        },
      });
      expect(e).toMatchObject({
        type: 'subscription.updated',
        subscription: { id: 'sub_1', status: 'canceled' },
      });
    }
  });
});

// --------------------------------------------------------------- mapping → internal states

describe('Asaas events → internal states (paid→active, overdue→past_due, cancelled→canceled)', () => {
  const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
    subscription: {
      plan_code: 'pro',
      status: 'active',
      provider: 'asaas',
      external_id: 'sub_1',
      pending_external_id: null,
      pending_plan_code: null,
      current_period_end: '2026-10-10T00:00:00.000Z',
    },
    accountStatus: 'active',
    interval: 'month',
    previousPaymentStatus: 'pending',
    now: new Date('2026-10-06T12:00:00Z'),
    ...over,
  });
  const ev = (event: string, status: string, extra: object = {}) =>
    eventsFromWebhook({
      id: 'evt_x',
      event,
      payment: {
        id: 'pay_9',
        subscription: 'sub_1',
        status,
        value: 199.9,
        billingType: 'PIX',
        ...extra,
      },
    })[0];
  const subChanges = (effects: ReturnType<typeof decideEffects>) =>
    effects.find((e) => e.kind === 'update_subscription') as
      { changes: Record<string, unknown> } | undefined;

  it('PAYMENT_RECEIVED / PAYMENT_CONFIRMED (card) → subscription active, past_due organization reopened', () => {
    for (const [event, status] of [
      ['PAYMENT_RECEIVED', 'RECEIVED'],
      ['PAYMENT_CONFIRMED', 'CONFIRMED'],
    ]) {
      const effects = decideEffects(
        ev(event, status),
        ctx({
          subscription: { ...ctx().subscription!, status: 'past_due' },
          accountStatus: 'past_due',
        })
      );
      expect(subChanges(effects)?.changes.status).toBe('active');
      expect(effects).toContainEqual({
        kind: 'set_account_status',
        from: 'past_due',
        to: 'active',
      });
    }
  });

  it('PAYMENT_OVERDUE → past_due (subscription and organization)', () => {
    const effects = decideEffects(ev('PAYMENT_OVERDUE', 'OVERDUE'), ctx());
    expect(subChanges(effects)?.changes.status).toBe('past_due');
    expect(effects).toContainEqual({
      kind: 'set_account_status',
      from: 'active',
      to: 'past_due',
    });
  });

  it('SUBSCRIPTION_DELETED → canceled (plan kept until the period ends)', () => {
    const [e] = eventsFromWebhook({
      id: 'evt_c',
      event: 'SUBSCRIPTION_DELETED',
      subscription: { id: 'sub_1', customer: 'cus_1', value: 1, deleted: true },
    });
    const effects = decideEffects(e, ctx());
    expect(subChanges(effects)?.changes).toMatchObject({
      status: 'canceled',
      cancel_at_period_end: true,
      current_period_end: '2026-10-10T00:00:00.000Z',
    });
  });

  it('out-of-order: OVERDUE arriving after RECEIVED changes nothing', () => {
    expect(
      decideEffects(
        ev('PAYMENT_OVERDUE', 'OVERDUE'),
        ctx({ previousPaymentStatus: 'paid' })
      )
    ).toEqual([]);
  });

  it('CONFIRMED then RECEIVED (card settles) grants the period once', () => {
    const second = decideEffects(
      ev('PAYMENT_RECEIVED', 'RECEIVED'),
      ctx({ previousPaymentStatus: 'paid' })
    );
    expect(second.map((e) => e.kind)).toEqual(['record_payment']);
  });

  it('status table and value/date conversion', () => {
    expect(paymentStatusFromAsaas('RECEIVED_IN_CASH')).toBe('paid');
    expect(paymentStatusFromAsaas('DUNNING_REQUESTED')).toBe('overdue');
    expect(paymentStatusFromAsaas('CHARGEBACK_REQUESTED')).toBe('refunded');
    expect(paymentStatusFromAsaas('AWAITING_RISK_ANALYSIS')).toBe('pending');
    expect(paymentStatusFromAsaas('NEW_STATUS_FROM_THE_FUTURE')).toBe(
      'pending'
    );
    expect(paymentStatusFromAsaas('PENDING', true)).toBe('canceled');
    expect(
      ev('PAYMENT_REPROVED_BY_RISK_ANALYSIS', 'PENDING').payment?.status
    ).toBe('failed');
    expect(ev('PAYMENT_DELETED', 'PENDING').payment?.status).toBe('canceled');
    expect(toCents(199.9)).toBe(19990);
    expect(toCents(0.29)).toBe(29);
    expect(asaasDateToIso('2024-06-12 16:45:03')).toBe(
      '2024-06-12T19:45:03.000Z'
    );
  });
});

describe('no secrets in logs during a full flow', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

  it('console output never contains the API key or the webhook token', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) {
      spies.push(
        vi
          .spyOn(console, m)
          .mockImplementation(
            (...a: unknown[]) => void lines.push(a.map(String).join(' '))
          )
      );
    }
    // A fetch that fails the QR lookup forces the warning path.
    const fake = createFakeAsaas({
      apiKey: API_KEY,
      webhookToken: WEBHOOK_TOKEN,
    });
    const flaky = async (url: string, init: RequestInit) =>
      url.endsWith('/pixQrCode')
        ? new Response('{"errors":[{"description":"Pix indisponível"}]}', {
            status: 400,
          })
        : fake.fetch(url, init);
    const p = new AsaasBillingProvider(config(), flaky, 0);
    const { id } = await p.createCustomer(customer);
    await p.createPixCharge({
      customerId: id,
      accountId: 'a',
      amountCents: 1,
      currency: 'BRL',
      description: 'x',
    });
    await p
      .parseWebhook({
        headers: new Headers({ 'asaas-access-token': 'wrong' }),
        rawBody: '{}',
      })
      .catch(() => {});
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toContain(API_KEY);
      expect(l).not.toContain(WEBHOOK_TOKEN);
    }
  });
});
