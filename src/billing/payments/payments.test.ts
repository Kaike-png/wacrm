import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  activeBillingProviderId,
  getBillingProvider,
  registerBillingProvider,
  registeredBillingProviders,
  UnknownBillingProviderError,
} from '../providers';
import { MockBillingProvider } from '../providers/mock';

import {
  addInterval,
  decideEffects,
  type RuleContext,
  type SubscriptionState,
} from './rules';
import type { BillingEvent, ProviderPayment } from './types';

const NOW = new Date('2026-10-06T12:00:00Z');

function payment(over: Partial<ProviderPayment> = {}): ProviderPayment {
  return {
    id: 'pay_1',
    customerId: 'cus_1',
    subscriptionId: 'sub_new',
    externalReference: 'acc',
    status: 'paid',
    method: 'pix',
    amountCents: 19990,
    currency: 'BRL',
    description: 'Plano Pro',
    dueDate: '2026-10-06',
    paidAt: NOW.toISOString(),
    periodStart: NOW.toISOString(),
    periodEnd: '2026-11-06T12:00:00.000Z',
    pix: null,
    invoiceUrl: null,
    ...over,
  };
}

const paymentEvent = (p: Partial<ProviderPayment> = {}): BillingEvent => ({
  id: 'evt_1',
  type: 'payment.updated',
  occurredAt: NOW.toISOString(),
  payment: payment(p),
});

function sub(over: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    plan_code: 'start',
    status: 'manual',
    provider: 'mock',
    external_id: null,
    pending_external_id: 'sub_new',
    pending_plan_code: 'pro',
    current_period_end: null,
    ...over,
  };
}

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    subscription: sub(),
    accountStatus: 'trial',
    interval: 'month',
    previousPaymentStatus: 'pending',
    now: NOW,
    ...over,
  };
}

const kinds = (effects: ReturnType<typeof decideEffects>) =>
  effects.map((e) => e.kind);

describe('billing rules (gateway-agnostic)', () => {
  it('first payment of a plan change: plan switches, subscription active, trial → active', () => {
    const effects = decideEffects(paymentEvent(), ctx());
    expect(kinds(effects)).toEqual([
      'record_payment',
      'update_subscription',
      'set_account_status',
    ]);
    expect(effects[1]).toMatchObject({
      changes: {
        plan_code: 'pro',
        status: 'active',
        external_id: 'sub_new',
        pending_external_id: null,
        pending_plan_code: null,
        current_period_end: '2026-11-06T12:00:00.000Z',
      },
    });
    expect(effects[2]).toEqual({
      kind: 'set_account_status',
      from: 'trial',
      to: 'active',
    });
  });

  it('upgrade from a paid plan also cancels the replaced gateway subscription', () => {
    const effects = decideEffects(
      paymentEvent(),
      ctx({
        subscription: sub({ status: 'active', external_id: 'sub_old' }),
        accountStatus: 'active',
      })
    );
    expect(kinds(effects)).toEqual([
      'record_payment',
      'update_subscription',
      'cancel_provider_subscription',
    ]);
    expect(effects[2]).toEqual({
      kind: 'cancel_provider_subscription',
      subscriptionId: 'sub_old',
    });
  });

  it('without the gateway period, the plan interval is used', () => {
    const effects = decideEffects(
      paymentEvent({ periodEnd: null }),
      ctx({ interval: 'year' })
    );
    expect(effects[1]).toMatchObject({
      changes: { current_period_end: '2027-10-06T12:00:00.000Z' },
    });
  });

  it('renewal paid: extends from the current end, past_due → active', () => {
    const effects = decideEffects(
      paymentEvent({ id: 'pay_2', subscriptionId: 'sub_1', periodEnd: null }),
      ctx({
        subscription: sub({
          status: 'past_due',
          external_id: 'sub_1',
          pending_external_id: null,
          pending_plan_code: null,
          plan_code: 'pro',
          current_period_end: '2026-10-20T00:00:00.000Z',
        }),
        accountStatus: 'past_due',
      })
    );
    expect(effects[1]).toMatchObject({
      changes: {
        status: 'active',
        current_period_end: '2026-11-20T00:00:00.000Z',
      },
    });
    expect(effects[2]).toEqual({
      kind: 'set_account_status',
      from: 'past_due',
      to: 'active',
    });
  });

  it('renewal overdue: subscription and organization past_due', () => {
    const effects = decideEffects(
      paymentEvent({
        id: 'pay_2',
        subscriptionId: 'sub_1',
        status: 'overdue',
        paidAt: null,
      }),
      ctx({
        subscription: sub({
          status: 'active',
          external_id: 'sub_1',
          pending_external_id: null,
        }),
        accountStatus: 'active',
      })
    );
    expect(kinds(effects)).toEqual([
      'record_payment',
      'update_subscription',
      'set_account_status',
    ]);
    expect(effects[2]).toEqual({
      kind: 'set_account_status',
      from: 'active',
      to: 'past_due',
    });
  });

  it('never touches a suspended or cancelled organization', () => {
    for (const accountStatus of ['suspended', 'cancelled'] as const) {
      const effects = decideEffects(paymentEvent(), ctx({ accountStatus }));
      expect(kinds(effects)).not.toContain('set_account_status');
    }
    const overdue = decideEffects(
      paymentEvent({ subscriptionId: 'sub_1', status: 'overdue' }),
      ctx({
        subscription: sub({ status: 'active', external_id: 'sub_1' }),
        accountStatus: 'suspended',
      })
    );
    expect(kinds(overdue)).not.toContain('set_account_status');
  });

  it('re-delivery of an applied status only records the payment (idempotent)', () => {
    expect(
      kinds(
        decideEffects(paymentEvent(), ctx({ previousPaymentStatus: 'paid' }))
      )
    ).toEqual(['record_payment']);
  });

  it('one-off charge or unknown subscription: recorded, nothing else changes', () => {
    expect(
      kinds(decideEffects(paymentEvent({ subscriptionId: null }), ctx()))
    ).toEqual(['record_payment']);
    expect(
      kinds(decideEffects(paymentEvent({ subscriptionId: 'sub_other' }), ctx()))
    ).toEqual(['record_payment']);
    expect(
      kinds(decideEffects(paymentEvent(), ctx({ subscription: null })))
    ).toEqual(['record_payment']);
  });

  it('gateway cancels the subscription: plan kept until the end of the period', () => {
    const effects = decideEffects(
      {
        id: 'evt_c',
        type: 'subscription.updated',
        occurredAt: NOW.toISOString(),
        subscription: {
          id: 'sub_1',
          customerId: 'cus_1',
          status: 'canceled',
          amountCents: 1,
          currency: 'BRL',
          interval: 'month',
          currentPeriodEnd: '2026-10-31T00:00:00.000Z',
          cancelAtPeriodEnd: true,
        },
      },
      ctx({
        subscription: sub({
          status: 'active',
          external_id: 'sub_1',
          pending_external_id: null,
        }),
      })
    );
    expect(effects).toEqual([
      {
        kind: 'update_subscription',
        changes: {
          status: 'canceled',
          cancel_at_period_end: true,
          canceled_at: NOW.toISOString(),
          current_period_end: '2026-10-31T00:00:00.000Z',
        },
      },
    ]);
  });

  it('abandoned plan change (pending subscription canceled) clears the pending state', () => {
    const effects = decideEffects(
      {
        id: 'evt_p',
        type: 'subscription.updated',
        occurredAt: NOW.toISOString(),
        subscription: {
          id: 'sub_new',
          customerId: 'cus_1',
          status: 'canceled',
          amountCents: 1,
          currency: 'BRL',
          interval: 'month',
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        },
      },
      ctx({ subscription: sub({ status: 'pending' }) })
    );
    expect(effects).toEqual([
      {
        kind: 'update_subscription',
        changes: {
          pending_external_id: null,
          pending_plan_code: null,
          status: 'manual',
        },
      },
    ]);
  });

  it('addInterval handles month and year in UTC', () => {
    expect(
      addInterval(new Date('2026-01-15T00:00:00Z'), 'month').toISOString()
    ).toBe('2026-02-15T00:00:00.000Z');
    expect(
      addInterval(new Date('2026-01-15T00:00:00Z'), 'year').toISOString()
    ).toBe('2027-01-15T00:00:00.000Z');
  });
});

describe('provider registry', () => {
  afterEach(() => {
    delete process.env.BILLING_PROVIDER;
  });

  it('mock is built in and is the default outside production', () => {
    expect(registeredBillingProviders()).toContain('mock');
    expect(activeBillingProviderId({ NODE_ENV: 'development' })).toBe('mock');
    expect(getBillingProvider()).toBeInstanceOf(MockBillingProvider);
  });

  it('mock is refused in production unless explicitly allowed', () => {
    expect(() => activeBillingProviderId({ NODE_ENV: 'production' })).toThrow(
      /not allowed in production/
    );
    expect(
      activeBillingProviderId({
        NODE_ENV: 'production',
        BILLING_ALLOW_MOCK: 'true',
      })
    ).toBe('mock');
    expect(
      activeBillingProviderId({
        NODE_ENV: 'production',
        BILLING_PROVIDER: 'asaas',
      })
    ).toBe('asaas');
  });

  it('records keep their own gateway; unknown ids fail clearly', () => {
    registerBillingProvider(
      'fake-gw',
      () =>
        Object.assign(new MockBillingProvider('x'), { id: 'fake-gw' }) as never
    );
    expect(getBillingProvider('fake-gw').id).toBe('fake-gw');
    expect(() => getBillingProvider('nao-existe')).toThrow(
      UnknownBillingProviderError
    );
    expect(() =>
      registerBillingProvider('Bad Id', () => new MockBillingProvider())
    ).toThrow();
  });
});

describe('no business rule depends on a gateway', () => {
  const root = join(__dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory()
        ? files(p)
        : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)
          ? [p]
          : [];
    });
  const GATEWAYS =
    /\b(asaas|mercado\s*pago|mercadopago|efi|ef[ií]\s*bank|gerencianet|pagar\.?me|stripe|iugu|pagseguro)\b/i;

  it('src/billing outside providers/ names no gateway and imports no adapter', () => {
    const offenders = files(root)
      .filter((f) => !relative(root, f).startsWith('providers'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return (
          GATEWAYS.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')) ||
          /from ['"]@\/integrations\//.test(src)
        );
      })
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });

  it('only the registry / composition root import concrete providers', () => {
    const offenders = files(root)
      .filter((f) =>
        /from ['"](\.\/mock|(\.\.\/)+providers\/mock|@\/billing\/providers\/mock)['"]/.test(
          readFileSync(f, 'utf8')
        )
      )
      .map((f) => relative(root, f));
    expect(offenders).toEqual(['providers/index.ts']);
  });
});
