/**
 * /api/billing/subscription (fork, docs/BILLING.md)
 *   GET    plans with prices, current subscription, recent payments (admins)
 *   POST   { plan, method? } — subscribe / change plan; returns the first
 *          charge (Pix code). Admins.
 *   DELETE cancel at the end of the paid period. Owner only.
 */
import { NextResponse } from 'next/server';

import '@/integrations/payments';
import { requireRole } from '@/custom/core/server';
import { BillingService } from '@/billing/payments/service';
import type { PaymentMethod } from '@/billing/payments/types';

import { billingError } from '../_respond';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const { accountId } = await requireRole('admin');
    return NextResponse.json(await BillingService.getOverview(accountId), {
      headers: noStore,
    });
  } catch (err) {
    return billingError(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as {
      plan?: unknown;
      method?: unknown;
    } | null;
    const { plan: rawPlan, method: rawMethod } = body ?? {};
    const plan = typeof rawPlan === 'string' ? rawPlan : '';
    const method = (
      typeof rawMethod === 'string' ? rawMethod : 'pix'
    ) as PaymentMethod;
    if (
      !/^[a-z][a-z0-9_-]{0,39}$/.test(plan) ||
      !['pix', 'boleto', 'card'].includes(method)
    ) {
      return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    return NextResponse.json(
      await BillingService.subscribe(accountId, plan, method),
      { status: 201, headers: noStore }
    );
  } catch (err) {
    return billingError(err);
  }
}

export async function DELETE() {
  try {
    const { accountId } = await requireRole('owner');
    await BillingService.cancel(accountId);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (err) {
    return billingError(err);
  }
}
