/**
 * POST /api/billing/webhooks/:provider — notifications from a payment
 * gateway (fork, docs/BILLING.md). Public: authenticity is checked by the
 * provider adapter (signature / token). Idempotent by event id.
 *
 *   200 processed (or duplicate / in progress elsewhere / unknown
 *       organization — no retry needed)
 *   401 authenticity rejected · 404 unknown provider · 413 too large
 *   503 provider not configured · 500 retry later (event left claimable)
 */
import { NextResponse } from 'next/server';

import '@/integrations/payments';
import { BillingService } from '@/billing/payments/service';
import {
  BillingProviderUnavailableError,
  InvalidWebhookError,
} from '@/billing/payments/types';
import { UnknownBillingProviderError } from '@/billing/providers';

const MAX_BODY_BYTES = 512 * 1024;

/** Body as text, or null once it exceeds `max` bytes (stops reading). */
async function readCapped(
  request: Request,
  max: number
): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  // Gateways send small JSON bodies; refuse anything large before reading it
  // all — also when the sender omits Content-Length (chunked body).
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES)
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  const rawBody = await readCapped(request, MAX_BODY_BYTES);
  if (rawBody === null)
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  try {
    const result = await BillingService.handleWebhook(provider, {
      headers: request.headers,
      rawBody,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof InvalidWebhookError) {
      console.warn(`[billing] rejected ${provider} webhook: ${err.message}`);
      return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
    }
    if (err instanceof UnknownBillingProviderError) {
      return NextResponse.json({ error: 'unknown_provider' }, { status: 404 });
    }
    if (err instanceof BillingProviderUnavailableError) {
      console.error(
        `[billing] ${provider} webhook: provider not configured: ${err.message}`
      );
      return NextResponse.json(
        { error: 'provider_unavailable' },
        { status: 503 }
      );
    }
    console.error(`[billing] ${provider} webhook failed:`, err);
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }
}
