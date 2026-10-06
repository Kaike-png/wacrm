/**
 * GET /api/billing/cron — scheduled (daily is enough): canceled
 * subscriptions whose paid period ended go back to the default plan, and
 * organizations past_due beyond the grace period are suspended
 * (docs/DELINQUENCY.md).
 * Header x-cron-secret = BILLING_CRON_SECRET (falls back to
 * AUTOMATION_CRON_SECRET, so one scheduler secret can serve all crons).
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { graceDaysFromEnv } from '@/billing/access-policy';
import { BillingService } from '@/billing/payments/service';

export async function GET(request: Request) {
  const expected =
    process.env.BILLING_CRON_SECRET || process.env.AUTOMATION_CRON_SECRET;
  if (!expected)
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '');
  const want = Buffer.from(expected);
  if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const expired = await BillingService.expireSubscriptions();
  // Delinquency (docs/DELINQUENCY.md): past_due beyond BILLING_GRACE_DAYS → suspended.
  const suspended = await BillingService.enforceDelinquency(graceDaysFromEnv());
  return NextResponse.json({ ok: true, expired, suspended });
}
