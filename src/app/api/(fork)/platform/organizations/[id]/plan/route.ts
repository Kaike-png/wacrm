/**
 * POST /api/platform/organizations/:id/plan — set the organization's plan
 * (platform admins only; audited). Plans live in billing_plans (907).
 * Body: { plan: string | null, reason?: string }. docs/PLATFORM_ADMIN.md
 */
import { NextResponse } from 'next/server';

import {
  requestMeta,
  requirePlatformAdminMutation,
} from '@/modules/platform/server/auth';
import { setOrganizationPlan } from '@/modules/platform/server/data';

import { platformError } from '../../../_respond';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requirePlatformAdminMutation(request);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      plan?: unknown;
      reason?: unknown;
    } | null;
    const plan = body?.plan ?? null;
    // Existence / active is checked by platform_set_plan (→ 400 invalid_input).
    if (
      plan !== null &&
      (typeof plan !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(plan))
    ) {
      return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const reason = typeof body?.reason === 'string' ? body.reason : null;
    const current = await setOrganizationPlan(
      admin,
      id,
      plan,
      reason,
      await requestMeta()
    );
    return NextResponse.json(
      { plan: current },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return platformError(err);
  }
}
