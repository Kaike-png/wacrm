import { beforeEach, describe, expect, it } from 'vitest';

import { describeBillingProviderContract } from '../../payments/contract';
import { InvalidWebhookError } from '../../payments/types';

import {
  MockBillingProvider,
  resetMockGateway,
  signMockWebhook,
} from './index';
import { buildPixCopyPaste, crc16, hasValidCrc } from './pix';

describeBillingProviderContract('mock', {
  create: () => new MockBillingProvider('test-secret'),
  settle: async (p, paymentId, status) => {
    const { headers, rawBody } = (p as MockBillingProvider).simulate(
      paymentId,
      status
    );
    return { headers, rawBody };
  },
});

describe('mock gateway specifics', () => {
  beforeEach(() => resetMockGateway());

  it('Pix copia e cola is a valid BR Code (CRC16/CCITT-FALSE)', () => {
    expect(crc16('123456789')).toBe('29B1'); // standard check value
    const code = buildPixCopyPaste({
      key: 'chave',
      amountCents: 19990,
      merchantName: 'Padaria São João',
      merchantCity: 'São Paulo',
      txid: 'pay_mock_abc',
    });
    expect(code.startsWith('000201')).toBe(true);
    expect(code).toContain('br.gov.bcb.pix');
    expect(code).toContain('5406199.90');
    expect(code).toContain('5303986');
    expect(code).toContain('PADARIA SAO JOAO');
    expect(hasValidCrc(code)).toBe(true);
    expect(
      hasValidCrc(code.slice(0, -1) + (code.endsWith('0') ? '1' : '0'))
    ).toBe(false);
  });

  it('signature uses the configured secret', async () => {
    const a = new MockBillingProvider('secret-a');
    const b = new MockBillingProvider('secret-b');
    const { id } = await a.createCustomer({
      accountId: 'x',
      name: 'X',
      email: null,
      taxId: null,
      phone: null,
    });
    const pay = await a.createPixCharge({
      customerId: id,
      accountId: 'x',
      amountCents: 100,
      currency: 'BRL',
      description: 'x',
    });
    const hook = a.simulate(pay.id, 'paid');
    expect(hook.headers.get('x-mock-signature')).toBe(
      signMockWebhook(hook.rawBody, 'secret-a')
    );
    await expect(b.parseWebhook(hook)).rejects.toBeInstanceOf(
      InvalidWebhookError
    );
  });

  it('paying the first charge activates the subscription at the gateway; renewal extends it', async () => {
    const p = new MockBillingProvider('s');
    const { id: customerId } = await p.createCustomer({
      accountId: 'x',
      name: 'X',
      email: null,
      taxId: null,
      phone: null,
    });
    const { subscription, firstPayment } = await p.createSubscription({
      customerId,
      accountId: 'x',
      planCode: 'pro',
      description: 'Plano Pro',
      amountCents: 100,
      currency: 'BRL',
      interval: 'month',
      method: 'pix',
    });
    expect(firstPayment.periodEnd).toBeTruthy();
    p.simulate(firstPayment.id, 'paid');
    const renewal = p.simulateRenewal(subscription.id).event.payment!;
    expect(renewal.subscriptionId).toBe(subscription.id);
    expect(new Date(renewal.periodStart!).getTime()).toBe(
      new Date(firstPayment.periodEnd!).getTime()
    );
    expect(new Date(renewal.periodEnd!).getTime()).toBeGreaterThan(
      new Date(firstPayment.periodEnd!).getTime()
    );
  });

  it('unknown ids fail like a gateway would', async () => {
    const p = new MockBillingProvider('s');
    await expect(p.getPayment('nope')).rejects.toThrow(/unknown payment/);
    await expect(
      p.cancelSubscription('nope', { atPeriodEnd: true })
    ).rejects.toThrow(/unknown subscription/);
  });
});
