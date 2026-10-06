/**
 * Entitlements service (fork, docs/PLANS.md) — server only. The public
 * face for app code is UsageService (./usage.ts); this module is the
 * lower layer core imports through the P-010 seam.
 *
 * The single place the app asks "may this organization do X?". It reads
 * the plan's feature values from the database (migration 907); nothing
 * here knows plan codes or numbers.
 *
 *   await assertWithinLimit(accountId, 'max_automations')   // before creating
 *   if (!(await isFeatureEnabled(accountId, 'ai_enabled'))) …
 *
 * The database enforces the same rules with triggers (backstop for paths
 * that skip this service); this layer exists to fail early with a clean
 * 403 and to serve the UI.
 */
import { supabaseAdmin } from '@/custom/core/admin';

import { PlanLimitError } from './errors';
import type {
  Entitlements,
  FeatureKey,
  FlagFeature,
  LimitFeature,
} from './features';

if (typeof window !== 'undefined') {
  throw new Error('src/billing/entitlements.ts is server-only');
}

/** Result of `billing_can_use` (migration 908). */
export interface LimitCheck {
  feature: string;
  allowed: boolean;
  kind?: 'limit' | 'flag';
  /** limit: number | null (unlimited); flag: boolean. */
  limit?: number | boolean | null;
  used?: number | null;
  /** limits only; null = unlimited. */
  remaining?: number | null;
  plan?: { code: string; name: string } | null;
  /** Cheapest plan that would allow it, when refused. */
  upgrade?: {
    code: string;
    name: string;
    value: number | boolean | null;
  } | null;
}

/** PlanLimitError carrying plan + upgrade, for a refused check. */
export function planLimitErrorFrom(check: LimitCheck): PlanLimitError {
  return new PlanLimitError(check.feature, {
    limit: typeof check.limit === 'number' ? check.limit : null,
    used: check.used ?? null,
    plan: check.plan?.name ?? null,
    upgrade: check.upgrade?.name ?? null,
    upgradeValue: check.upgrade ? check.upgrade.value : null,
  });
}

// Flags are read on hot paths (every public API call, every AI reply).
// A plan change takes effect within FLAG_TTL_MS.
const FLAG_TTL_MS = 30_000;
const flagCache = new Map<string, { value: boolean; at: number }>();

export function forgetEntitlements(accountId?: string): void {
  if (!accountId) {
    flagCache.clear();
    return;
  }
  for (const key of flagCache.keys())
    if (key.startsWith(`${accountId}:`)) flagCache.delete(key);
}

/** Plan + every feature value + usage. */
export async function getEntitlements(
  accountId: string
): Promise<Entitlements> {
  const { data, error } = await supabaseAdmin().rpc('billing_entitlements', {
    p_account: accountId,
  });
  if (error) throw new Error(`entitlements lookup failed: ${error.message}`);
  return data as Entitlements;
}

/**
 * Can `increment` more be added (limits) / is the flag on (flags)?
 * Fails OPEN on lookup errors (logged): the database triggers still
 * refuse the write itself, so an outage here never blocks valid work.
 */
export async function checkLimit(
  accountId: string,
  feature: FeatureKey,
  increment = 1
): Promise<LimitCheck> {
  try {
    const { data, error } = await supabaseAdmin().rpc('billing_can_use', {
      p_account: accountId,
      p_key: feature,
      p_increment: increment,
    });
    if (error) throw new Error(error.message);
    return data as LimitCheck;
  } catch (err) {
    console.error(
      `[billing] ${feature} check failed:`,
      err instanceof Error ? err.message : err
    );
    return { feature, allowed: true };
  }
}

/** Throws PlanLimitError when `increment` more would exceed the plan. */
export async function assertWithinLimit(
  accountId: string,
  feature: LimitFeature,
  increment = 1
): Promise<void> {
  const r = await checkLimit(accountId, feature, increment);
  if (!r.allowed) throw planLimitErrorFrom(r);
}

/**
 * Is a flag feature on for the organization? Fails OPEN on lookup errors
 * (migration missing, transient DB error, test double): a billing outage
 * must not take paying customers down. The database triggers still guard
 * the writes.
 */
export async function isFeatureEnabled(
  accountId: string,
  feature: FlagFeature
): Promise<boolean> {
  const cacheKey = `${accountId}:${feature}`;
  const hit = flagCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FLAG_TTL_MS) return hit.value;
  let value = true;
  try {
    const { data, error } = await supabaseAdmin().rpc('billing_feature_value', {
      p_account: accountId,
      p_key: feature,
    });
    if (error) throw new Error(error.message);
    value = data !== false;
  } catch (err) {
    console.error(
      `[billing] ${feature} lookup failed:`,
      err instanceof Error ? err.message : err
    );
    return true;
  }
  flagCache.set(cacheKey, { value, at: Date.now() });
  if (flagCache.size > 10_000) flagCache.clear();
  return value;
}

export async function assertFeatureEnabled(
  accountId: string,
  feature: FlagFeature
): Promise<void> {
  if (await isFeatureEnabled(accountId, feature)) return;
  // Refused: one more round trip for the plan / upgrade names.
  const r = await checkLimit(accountId, feature);
  throw planLimitErrorFrom({ ...r, allowed: false });
}
