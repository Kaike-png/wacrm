import { NextResponse } from 'next/server';

import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
  requireRole,
  toErrorResponse,
} from '@/custom/core/server';
import { testConnection } from '@/custom/whatsapp/connection';

/**
 * POST /api/whatsapp/connection/test — "Testar conexão": checks the saved
 * credentials with Meta (number, WABA pairing, app subscription), stores
 * the resulting status and logs it (docs/WHATSAPP_SAAS.md). Admins only;
 * rate-limited because every call hits the Graph API.
 */
export async function POST() {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(
      `whatsapp:test:${ctx.accountId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);
    const result = await testConnection(ctx.accountId, ctx.userId);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
