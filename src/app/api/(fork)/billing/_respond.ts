/**
 * Error mapping for the billing routes (fork, docs/BILLING.md). Gateway
 * messages are not echoed to clients (they may carry customer data).
 */
import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/custom/core/server';
import { BillingError } from '@/billing/payments/service';
import {
  BillingProviderError,
  BillingProviderUnavailableError,
} from '@/billing/payments/types';
import { UnknownBillingProviderError } from '@/billing/providers';

export function billingError(err: unknown): NextResponse {
  if (err instanceof BillingError) {
    return NextResponse.json({ error: err.code }, { status: err.httpStatus });
  }
  if (err instanceof BillingProviderError) {
    console.error(`[billing] provider ${err.provider} failed:`, err.message);
    return NextResponse.json(
      { error: 'provider_error' },
      { status: err.retryable ? 503 : 502 }
    );
  }
  if (err instanceof BillingProviderUnavailableError) {
    console.error('[billing] provider unavailable:', err.message);
    return NextResponse.json(
      { error: 'provider_unavailable' },
      { status: 503 }
    );
  }
  if (err instanceof UnknownBillingProviderError) {
    return NextResponse.json(
      { error: 'provider_unavailable' },
      { status: 503 }
    );
  }
  return toErrorResponse(err);
}
