/**
 * GET /api/billing/usage — usage report of the caller's organization
 * (UsageService.getUsage). With ?feature=<key>[&increment=n] it answers
 * UsageService.canUseFeature instead: { allowed, limit, used, remaining,
 * plan, upgrade, message }. Any member. docs/USAGE.md
 */
import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/custom/core/server';
import { isFlagFeature, isLimitFeature } from '@/billing/features';
import { UsageService } from '@/billing/usage';

export async function GET(request: Request) {
  try {
    const { accountId } = await getCurrentAccount();
    const url = new URL(request.url);
    const feature = url.searchParams.get('feature');
    const headers = { 'Cache-Control': 'no-store' };
    if (feature !== null) {
      if (!isLimitFeature(feature) && !isFlagFeature(feature)) {
        return NextResponse.json({ error: 'unknown_feature' }, { status: 400 });
      }
      const increment = Math.min(
        Math.max(Number(url.searchParams.get('increment') ?? 1) || 1, 1),
        100_000
      );
      return NextResponse.json(
        await UsageService.canUseFeature(accountId, feature, increment),
        { headers }
      );
    }
    return NextResponse.json(await UsageService.getUsage(accountId), {
      headers,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
