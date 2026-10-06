/**
 * Plan features — keys and value semantics (fork, docs/PLANS.md). Pure.
 *
 * The VALUES of each plan live in the database (billing_plans /
 * billing_plan_features, migration 907) and are edited in the platform
 * panel. Code only knows the keys it enforces. Never branch on a plan
 * code: ask for a feature (see ./entitlements.ts).
 */

export const LIMIT_FEATURES = [
  'max_users',
  'max_whatsapp_accounts',
  'max_contacts',
  'max_automations',
] as const;

export const FLAG_FEATURES = ['ai_enabled', 'api_enabled'] as const;

export type LimitFeature = (typeof LIMIT_FEATURES)[number];
export type FlagFeature = (typeof FLAG_FEATURES)[number];
export type FeatureKey = LimitFeature | FlagFeature;

/** `null` = unlimited. */
export type LimitValue = number | null;

export interface FeatureState {
  key: string;
  kind: 'limit' | 'flag';
  /** limit: number | null (unlimited); flag: boolean. */
  value: number | boolean | null;
  /** Current count, limits only. */
  used: number | null;
  /** Cheapest plan that would raise / enable it (908); null if none. */
  upgrade?: {
    code: string;
    name: string;
    value: number | boolean | null;
  } | null;
}

export interface Entitlements {
  plan: {
    code: string;
    name: string;
    started_at: string;
    current_period_end: string | null;
  } | null;
  features: FeatureState[];
}

export function isLimitFeature(key: string): key is LimitFeature {
  return (LIMIT_FEATURES as readonly string[]).includes(key);
}

export function isFlagFeature(key: string): key is FlagFeature {
  return (FLAG_FEATURES as readonly string[]).includes(key);
}

export function featureState(
  ent: Entitlements | null | undefined,
  key: FeatureKey
): FeatureState | null {
  return ent?.features.find((f) => f.key === key) ?? null;
}

/**
 * Is a flag on? Unknown / not loaded → true (the database is the
 * authority; the UI must not hide things on a missing answer).
 */
export function flagEnabled(
  ent: Entitlements | null | undefined,
  key: FlagFeature
): boolean {
  const f = featureState(ent, key);
  return f ? f.value !== false : true;
}

/** Limit and usage of a limit feature; `limit: null` = unlimited. */
export function limitOf(
  ent: Entitlements | null | undefined,
  key: LimitFeature
): { limit: LimitValue; used: number | null; reached: boolean } {
  const f = featureState(ent, key);
  const limit = typeof f?.value === 'number' ? f.value : null;
  const used = f?.used ?? null;
  return {
    limit,
    used,
    reached: limit !== null && used !== null && used >= limit,
  };
}

/** 0..1 share of a limit in use (0 when unlimited). */
export function usageRatio(limit: LimitValue, used: number | null): number {
  if (limit === null || used === null) return 0;
  if (limit === 0) return 1;
  return Math.min(1, used / limit);
}

/** Validate a value typed in the plan editor. */
export function parseFeatureValue(
  kind: 'limit' | 'flag',
  raw: unknown
): { ok: true; value: number | boolean | null } | { ok: false } {
  if (kind === 'flag')
    return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false };
  if (raw === null || raw === '') return { ok: true, value: null };
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isInteger(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
}
