/**
 * Contract every BillingProvider must pass (fork, docs/BILLING.md).
 * Each adapter's test file calls it with a factory and a way to make the
 * gateway "settle" a payment (the mock simulates; a real adapter's test
 * uses its sandbox or recorded HTTP fixtures):
 *
 *   describeBillingProviderContract('asaas', { create: () => …, settle: … });
 */
import { describe, expect, it } from 'vitest';

import type { BillingProvider, PaymentStatus, WebhookRequest } from './types';
import { InvalidWebhookError } from './types';

export interface ContractHarness {
  create: () => BillingProvider;
  /** Make the gateway mark a payment and return the webhook it sends. */
  settle: (
    provider: BillingProvider,
    paymentId: string,
    status: PaymentStatus
  ) => Promise<WebhookRequest>;
  /**
   * Gateway signs the body (HMAC). Token-only gateways (e.g. Asaas) cannot
   * detect a modified body — their adapter must confirm the state with the
   * gateway API instead (covered by the adapter's own tests).
   */
  signsBody?: boolean;
}

const customer = {
  accountId: '00000000-0000-4000-8000-000000000001',
  name: 'Padaria Pão Quente Ltda',
  email: 'financeiro@paoquente.com.br',
  taxId: '11222333000181',
  phone: '+5511987654321',
};

export function describeBillingProviderContract(
  name: string,
  h: ContractHarness
) {
  describe(`BillingProvider contract: ${name}`, () => {
    it('declares a stable id and its capabilities', () => {
      const p = h.create();
      expect(p.id).toMatch(/^[a-z][a-z0-9_-]{0,30}$/);
      expect(p.capabilities.methods.length).toBeGreaterThan(0);
    });

    it('subscription → first charge pending with Pix, amounts in cents', async () => {
      const p = h.create();
      const { id: customerId } = await p.createCustomer(customer);
      const { subscription, firstPayment } = await p.createSubscription({
        customerId,
        accountId: customer.accountId,
        planCode: 'pro',
        description: 'Plano Pro',
        amountCents: 19990,
        currency: 'BRL',
        interval: 'month',
        method: 'pix',
      });
      expect(subscription.customerId).toBe(customerId);
      expect(firstPayment).toMatchObject({
        status: 'pending',
        method: 'pix',
        amountCents: 19990,
        currency: 'BRL',
        subscriptionId: subscription.id,
      });
      expect(firstPayment.pix?.copyPaste).toBeTruthy();
      expect((await p.getPayment(firstPayment.id)).status).toBe('pending');
    });

    it('one-off Pix charge', async () => {
      const p = h.create();
      const { id: customerId } = await p.createCustomer(customer);
      const pay = await p.createPixCharge({
        customerId,
        accountId: customer.accountId,
        amountCents: 4990,
        currency: 'BRL',
        description: 'Pacote extra',
      });
      expect(pay).toMatchObject({
        status: 'pending',
        method: 'pix',
        amountCents: 4990,
        subscriptionId: null,
      });
      expect(pay.pix?.copyPaste).toBeTruthy();
    });

    it('webhook: authentic → normalized event; tampered → InvalidWebhookError', async () => {
      const p = h.create();
      const { id: customerId } = await p.createCustomer(customer);
      const pay = await p.createPixCharge({
        customerId,
        accountId: customer.accountId,
        amountCents: 1000,
        currency: 'BRL',
        description: 'x',
      });
      const req = await h.settle(p, pay.id, 'paid');
      const events = await p.parseWebhook(req);
      expect(events.length).toBeGreaterThan(0);
      const ev = events.find((e) => e.payment?.id === pay.id);
      expect(ev?.type).toBe('payment.updated');
      expect(ev?.payment?.status).toBe('paid');
      expect(ev?.id).toBeTruthy();
      expect((await p.getPayment(pay.id)).status).toBe('paid');

      if (h.signsBody !== false) {
        await expect(
          p.parseWebhook({ headers: req.headers, rawBody: req.rawBody + ' ' })
        ).rejects.toBeInstanceOf(InvalidWebhookError);
      }
      await expect(
        p.parseWebhook({ headers: new Headers(), rawBody: req.rawBody })
      ).rejects.toBeInstanceOf(InvalidWebhookError);
    });

    it('cancel at period end', async () => {
      const p = h.create();
      const { id: customerId } = await p.createCustomer(customer);
      const { subscription } = await p.createSubscription({
        customerId,
        accountId: customer.accountId,
        planCode: 'pro',
        description: 'Plano Pro',
        amountCents: 19990,
        currency: 'BRL',
        interval: 'month',
        method: 'pix',
      });
      const canceled = await p.cancelSubscription(subscription.id, {
        atPeriodEnd: true,
      });
      expect(canceled.status).toBe('canceled');
      expect(canceled.cancelAtPeriodEnd).toBe(true);
    });
  });
}
