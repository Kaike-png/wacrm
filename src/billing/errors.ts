/**
 * Plan-limit errors and messages (fork, docs/PLANS.md, docs/USAGE.md).
 * Pure — usable in the browser.
 *
 * The database refuses an action over the plan with SQLSTATE 53400
 * (configuration_limit_exceeded), message 'plan_limit_exceeded', the
 * feature key in DETAIL and a JSON HINT (migration 908):
 *   {"feature","limit","used","plan","upgrade","upgrade_value"}
 * The server throws PlanLimitError with the same context, which
 * toErrorResponse turns into 403 { error, code, feature, limit, plan, upgrade }.
 *
 * Message: "Você atingiu o limite de 2.000 contatos do plano Start.
 *           Faça upgrade para o plano Pro (até 10.000)."
 */
import { FLAG_FEATURES, LIMIT_FEATURES, type FeatureKey } from './features';

export const PLAN_LIMIT_SQLSTATE = '53400';
export const PLAN_LIMIT_CODE = 'plan_limit_exceeded';

/** What a refusal knows; every field optional except the feature. */
export interface LimitContext {
  limit: number | null;
  used: number | null;
  /** Current plan's display name (null: no plan / unknown). */
  plan: string | null;
  /** Cheapest plan that allows it (null: none — talk to support). */
  upgrade: string | null;
  /** That plan's value: number, null = unlimited, true for flags. */
  upgradeValue: number | boolean | null;
}

const EMPTY: LimitContext = {
  limit: null,
  used: null,
  plan: null,
  upgrade: null,
  upgradeValue: null,
};

export class PlanLimitError extends Error {
  readonly code = PLAN_LIMIT_CODE;
  readonly context: LimitContext;
  constructor(
    readonly feature: string,
    context: Partial<LimitContext> = {}
  ) {
    super(`${PLAN_LIMIT_CODE}: ${feature}`);
    this.name = 'PlanLimitError';
    this.context = { ...EMPTY, ...context };
  }
  get limit(): number | null {
    return this.context.limit;
  }
}

/**
 * The feature key when `err` is a plan-limit refusal — a PlanLimitError,
 * a Postgres/PostgREST error (code 53400) or an API JSON body — else null.
 */
export function planLimitFeature(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  if (err instanceof PlanLimitError) return err.feature;
  const e = err as { code?: unknown; details?: unknown; feature?: unknown };
  if (e.code === PLAN_LIMIT_SQLSTATE || e.code === PLAN_LIMIT_CODE) {
    if (typeof e.feature === 'string') return e.feature;
    if (typeof e.details === 'string' && e.details) return e.details;
    return 'unknown';
  }
  return null;
}

export function isPlanLimitError(err: unknown): boolean {
  return planLimitFeature(err) !== null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && /^\d+$/.test(v)
      ? Number(v)
      : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

/**
 * HINT of the database error → context. Accepts the JSON hint (908) and
 * the older "limit=2000 used=2000" form (907).
 */
export function parseLimitHint(hint: unknown): LimitContext {
  const text = typeof hint === 'string' ? hint.trim() : '';
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      return {
        limit: num(j.limit),
        used: num(j.used),
        plan: str(j.plan),
        upgrade: str(j.upgrade),
        upgradeValue:
          typeof j.upgrade_value === 'boolean'
            ? j.upgrade_value
            : (num(j.upgrade_value) ?? null),
      };
    } catch {
      return { ...EMPTY };
    }
  }
  const field = (k: string) => {
    const m = new RegExp(`${k}=(\\d+)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  return { ...EMPTY, limit: field('limit'), used: field('used') };
}

/** Context of any plan-limit refusal (error object or API JSON body). */
export function limitContextOf(err: unknown): LimitContext {
  if (err instanceof PlanLimitError) return err.context;
  const e = (err ?? {}) as Record<string, unknown>;
  if ('hint' in e) return parseLimitHint(e.hint);
  // API body from planLimitBody()
  return {
    limit: num(e.limit),
    used: num(e.used),
    plan: str(e.plan),
    upgrade: str(e.upgrade),
    upgradeValue:
      typeof e.upgrade_value === 'boolean'
        ? e.upgrade_value
        : num(e.upgrade_value),
  };
}

export type { FeatureKey };

export type Translate = (
  key: string,
  values?: Record<string, string | number>
) => string;

/** Friendly sentence + upgrade suggestion. `t` is bound to `Custom.billing`. */
export function planLimitMessage(
  feature: string,
  ctx: Partial<LimitContext>,
  t: Translate
): string {
  const c = { ...EMPTY, ...ctx };
  const plan = c.plan ?? 'none';
  let first: string;
  if (
    (LIMIT_FEATURES as readonly string[]).includes(feature) &&
    c.limit !== null
  ) {
    first = t(`limitReached.${feature}`, { limit: c.limit, plan });
  } else if ((FLAG_FEATURES as readonly string[]).includes(feature)) {
    first = t(`limitReached.${feature}`, { plan });
  } else {
    return t('limitReached.generic');
  }
  let second: string;
  if (!c.upgrade) second = t('upgrade.none');
  else if (typeof c.upgradeValue === 'boolean')
    second = t('upgrade.flag', { upgrade: c.upgrade });
  else if (c.upgradeValue === null)
    second = t('upgrade.unlimited', { upgrade: c.upgrade });
  else
    second = t('upgrade.limited', {
      upgrade: c.upgrade,
      value: c.upgradeValue,
    });
  return `${first} ${second}`;
}

/**
 * JSON body for a refused action: { error, code, feature, limit, used,
 * plan, upgrade, upgrade_value }.
 */
export function planLimitBody(
  err: unknown,
  t: Translate
): {
  error: string;
  code: typeof PLAN_LIMIT_CODE;
  feature: string;
  limit: number | null;
  used: number | null;
  plan: string | null;
  upgrade: string | null;
  upgrade_value: number | boolean | null;
} {
  const feature = planLimitFeature(err) ?? 'unknown';
  const c = limitContextOf(err);
  return {
    error: planLimitMessage(feature, c, t),
    code: PLAN_LIMIT_CODE,
    feature,
    limit: c.limit,
    used: c.used,
    plan: c.plan,
    upgrade: c.upgrade,
    upgrade_value: c.upgradeValue,
  };
}
