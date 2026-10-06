/**
 * POST /api/billing/mock/payments/:id { status } — DEVELOPMENT ONLY.
 * Makes the mock gateway change a payment and deliver the signed webhook
 * through the real handler (signature → rules → database).
 * 404 unless the payment belongs to the mock provider and mock is allowed.
 */
import { NextResponse } from 'next/server';

import '@/integrations/payments';
import { requireRole } from '@/custom/core/server';
import { BillingService } from '@/billing/payments/service';
import type { PaymentStatus } from '@/billing/payments/types';
import { getBillingProvider } from '@/billing/providers';
import {
  mockAllowed,
  MockBillingProvider,
  MOCK_PROVIDER_ID,
} from '@/billing/providers/mock';

import { billingError } from '../../../_respond';

const STATUSES: PaymentStatus[] = [
  'paid',
  'overdue',
  'refunded',
  'canceled',
  'failed',
];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!mockAllowed())
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const { accountId } = await requireRole('admin');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      status?: unknown;
    } | null;
    const status = (body?.status ?? 'paid') as PaymentStatus;
    if (!STATUSES.includes(status))
      return NextResponse.json({ error: 'invalid_input' }, { status: 400 });

    const payment = await BillingService.getPayment(accountId, id);
    if (payment.provider !== MOCK_PROVIDER_ID)
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const mock = getBillingProvider(MOCK_PROVIDER_ID) as MockBillingProvider;
    const { rawBody, headers } = mock.simulate(payment.external_id, status);
    const result = await BillingService.handleWebhook(MOCK_PROVIDER_ID, {
      headers,
      rawBody,
    });
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return billingError(err);
  }
}
