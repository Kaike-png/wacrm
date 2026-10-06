/**
 * POST /api/billing/payments/:id — ask the gateway for the payment's
 * current state and apply it ("Já paguei" / polling fallback). Admins.
 */
import { NextResponse } from 'next/server';

import '@/integrations/payments';
import { requireRole } from '@/custom/core/server';
import { BillingService } from '@/billing/payments/service';

import { billingError } from '../../_respond';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { accountId } = await requireRole('admin');
    const { id } = await params;
    return NextResponse.json(
      await BillingService.refreshPayment(accountId, id),
      {
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (err) {
    return billingError(err);
  }
}
