/**
 * Delinquency refusals (fork, docs/DELINQUENCY.md). Pure — safe to import
 * from core error mapping (toErrorResponse) and from the browser.
 *
 * Two sources, one shape: TenantRestrictedError (thrown by
 * src/billing/enforcement.ts) and the database refusal raised by
 * tenant_assert_can (SQLSTATE TR403, migration 911).
 */
import { isRestrictedAction, type RestrictedAction } from './access-policy';
import { toAccountStatus, type AccountStatus } from './account-status';

/** SQLSTATE raised by tenant_assert_can (migration 911). */
export const TENANT_RESTRICTED_SQLSTATE = 'TR403';

export class TenantRestrictedError extends Error {
  readonly code = 'tenant_restricted';
  readonly status = 403;
  constructor(
    readonly action: RestrictedAction,
    readonly accountStatus: AccountStatus
  ) {
    super(`tenant_restricted:${action}`);
    this.name = 'TenantRestrictedError';
  }
}

/** Our error or the database refusal (PostgREST / supabase-js error object). */
export function tenantRestrictionOf(
  err: unknown
): { action: RestrictedAction; status: AccountStatus } | null {
  if (err instanceof TenantRestrictedError)
    return { action: err.action, status: err.accountStatus };
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  if (
    e.code !== TENANT_RESTRICTED_SQLSTATE &&
    e.message !== 'tenant_restricted'
  )
    return null;
  let status: AccountStatus = 'suspended';
  let action: RestrictedAction | null = isRestrictedAction(e.details)
    ? e.details
    : null;
  if (typeof e.hint === 'string') {
    try {
      const h = JSON.parse(e.hint) as { action?: unknown; status?: unknown };
      if (isRestrictedAction(h.action)) action = h.action;
      status = toAccountStatus(h.status);
    } catch {
      /* hint not JSON */
    }
  }
  return action ? { action, status } : null;
}

export function isTenantRestricted(err: unknown): boolean {
  return tenantRestrictionOf(err) !== null;
}

/** Friendly sentence, e.g. "Envio de mensagens bloqueado. A organização está suspensa por falta de pagamento…". */
export function restrictionMessage(
  restriction: { action: RestrictedAction; status: AccountStatus },
  t: (key: string) => string
): string {
  return `${t(`blocked.${restriction.action}`)} ${t(`reason.${restriction.status}`)}`;
}

/** JSON body for a 403 — `t` is a translator scoped to Custom.billing.access. */
export function restrictionBody(err: unknown, t: (key: string) => string) {
  const r = tenantRestrictionOf(err);
  if (!r) return null;
  return {
    error: restrictionMessage(r, t),
    code: 'tenant_restricted',
    action: r.action,
    status: r.status,
  };
}
