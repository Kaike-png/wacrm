import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  hasMinRole,
  requireRole,
  toErrorResponse,
} from '@/custom/core/server';
import {
  getConnectionSummary,
  updateBusinessId,
} from '@/custom/whatsapp/connection';

/**
 * GET /api/whatsapp/connection — status of the caller's WhatsApp
 * connection (docs/WHATSAPP_SAAS.md). Any member may read it; only
 * admins get the token hint (`••••ab12`). Never returns a token,
 * verify token or PIN.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const summary = await getConnectionSummary(ctx.accountId, {
      includeTokenHint: hasMinRole(ctx.role, 'admin'),
    });
    return NextResponse.json(summary, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH /api/whatsapp/connection — non-secret metadata (Meta Business ID).
 * Admins only. Credentials still go through POST /api/whatsapp/config,
 * which validates them with Meta.
 */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as {
      business_id?: unknown;
    } | null;
    const raw =
      typeof body?.business_id === 'string' ? body.business_id.trim() : '';
    if (raw && !/^\d{5,25}$/.test(raw)) {
      return NextResponse.json(
        { error: 'invalid_business_id', field: 'business_id' },
        { status: 400 }
      );
    }
    const updated = await updateBusinessId(ctx.accountId, raw || null);
    if (!updated)
      return NextResponse.json({ error: 'not_configured' }, { status: 404 });
    const summary = await getConnectionSummary(ctx.accountId, {
      includeTokenHint: true,
    });
    return NextResponse.json(summary, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
