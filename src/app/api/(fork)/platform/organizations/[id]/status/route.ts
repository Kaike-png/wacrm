/**
 * POST /api/platform/organizations/:id/status — suspend / reactivate an
 * organization (platform admins only; audited). docs/PLATFORM_ADMIN.md
 * Body: { action: 'suspend' | 'reactivate', reason?: string } — reason is
 * required to suspend.
 */
import { NextResponse } from 'next/server';

import {
  requestMeta,
  requirePlatformAdminMutation,
} from '@/modules/platform/server/auth';
import { setOrganizationStatus } from '@/modules/platform/server/data';

import { platformError } from '../../../_respond';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requirePlatformAdminMutation(request);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      reason?: unknown;
    } | null;
    const action = body?.action;
    if (action !== 'suspend' && action !== 'reactivate') {
      return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const reason = typeof body?.reason === 'string' ? body.reason : null;
    const result = await setOrganizationStatus(
      admin,
      id,
      action,
      reason,
      await requestMeta()
    );
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return platformError(err);
  }
}
