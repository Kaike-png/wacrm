/**
 * POST /api/platform/plans/:code — edit a plan's name, active/default
 * flags and feature values (platform admins only; audited).
 * Body: { name?, is_active?, is_default?, features: { key: value },
 *         price_cents? (integer >= 0, null = not sold online), reason? }
 * Values: limit → integer >= 0 or null (unlimited); flag → boolean.
 * docs/PLANS.md
 */
import { NextResponse } from 'next/server';

import {
  requestMeta,
  requirePlatformAdminMutation,
} from '@/modules/platform/server/auth';
import { updatePlan } from '@/modules/platform/server/data';

import { platformError } from '../../_respond';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const admin = await requirePlatformAdminMutation(request);
    const { code } = await params;
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      is_active?: unknown;
      is_default?: unknown;
      features?: unknown;
      price_cents?: unknown;
      reason?: unknown;
    } | null;
    const features = body?.features;
    if (
      !features ||
      typeof features !== 'object' ||
      Array.isArray(features) ||
      !Object.values(features).every(
        (v) => v === null || typeof v === 'boolean' || typeof v === 'number'
      )
    ) {
      return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    const price = body?.price_cents;
    if (
      price !== undefined &&
      price !== null &&
      !(Number.isSafeInteger(price) && (price as number) >= 0)
    ) {
      return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    }
    await updatePlan(
      admin,
      code,
      {
        name: typeof body?.name === 'string' ? body.name.slice(0, 60) : null,
        isActive: typeof body?.is_active === 'boolean' ? body.is_active : null,
        isDefault:
          typeof body?.is_default === 'boolean' ? body.is_default : null,
        features: features as Record<string, number | boolean | null>,
        priceCents: price as number | null | undefined,
      },
      typeof body?.reason === 'string' ? body.reason : null,
      await requestMeta()
    );
    return NextResponse.json(
      { ok: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return platformError(err);
  }
}
