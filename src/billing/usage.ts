/**
 * UsageService (fork, docs/USAGE.md) — server only.
 *
 *   const usage = await UsageService.getUsage(accountId);
 *   const check = await UsageService.canUseFeature(accountId, 'max_contacts', 500);
 *   if (!check.allowed) return { error: check.message };   // friendly + upgrade
 *
 * getUsage: users (total / active in 30 days / pending invitations),
 * contacts, WhatsApp accounts, automations, messages sent / received,
 * campaigns and AI — stock plus the current month in the organization's
 * time zone (billing_usage_report, migration 908) — with the plan limits.
 *
 * canUseFeature: may the organization add `increment` more (limits) / use
 * it (flags)? Answers with limit, used, remaining, plan, the cheapest plan
 * that would allow it, and a ready message. Read-only: reaching a limit
 * never deletes anything; the database refuses only new rows.
 */
import { getT } from '@/custom/core/server';

import {
  checkLimit,
  getEntitlements,
  isFeatureEnabled,
  planLimitErrorFrom,
  type LimitCheck,
} from './entitlements';
import { planLimitMessage } from './errors';
import type { Entitlements, FeatureKey } from './features';
import type { UsageReport } from './usage-types';
import { supabaseAdmin } from '@/custom/core/admin';

if (typeof window !== 'undefined') {
  throw new Error('src/billing/usage.ts is server-only');
}

export type { UsageReport } from './usage-types';

export interface CanUseResult extends LimitCheck {
  /** Friendly refusal + upgrade suggestion; null when allowed. */
  message: string | null;
}

async function getUsage(accountId: string): Promise<UsageReport | null> {
  const { data, error } = await supabaseAdmin().rpc('billing_usage_report', {
    p_account: accountId,
  });
  if (error) throw new Error(`usage report failed: ${error.message}`);
  return (data as UsageReport | null) ?? null;
}

async function canUseFeature(
  accountId: string,
  feature: FeatureKey,
  increment = 1
): Promise<CanUseResult> {
  const check = await checkLimit(accountId, feature, increment);
  if (check.allowed) return { ...check, message: null };
  const err = planLimitErrorFrom(check);
  const t = getT('Custom.billing');
  return {
    ...check,
    message: planLimitMessage(feature, err.context, (key, values) =>
      t(key, values)
    ),
  };
}

export const UsageService = {
  getUsage,
  canUseFeature,
  /** Plan + feature values + current counts (lighter than getUsage). */
  getEntitlements: (accountId: string): Promise<Entitlements> =>
    getEntitlements(accountId),
  /** Cached flag lookup for hot paths (API calls, AI replies). */
  isFeatureEnabled,
} as const;
