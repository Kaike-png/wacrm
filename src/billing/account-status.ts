/**
 * Organization (tenant) lifecycle status (fork, docs/TENANCY.md).
 *
 * Stored in `accounts.status` (migration 902). Only billing / operators
 * (service role) can change it — the database rejects client writes —
 * so the UI shows it read-only. Enforcement (what each state blocks) is
 * decided only by the delinquency policy (src/billing/access-policy.ts,
 * docs/DELINQUENCY.md); this file only knows the values and transitions.
 */

export const ACCOUNT_STATUSES = [
  'trial',
  'active',
  'past_due',
  'suspended',
  'cancelled',
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export function isAccountStatus(value: unknown): value is AccountStatus {
  return (
    typeof value === 'string' &&
    (ACCOUNT_STATUSES as readonly string[]).includes(value)
  );
}

/** Unknown/missing (migration 902 not applied) reads as `active`, like before. */
export function toAccountStatus(value: unknown): AccountStatus {
  return isAccountStatus(value) ? value : 'active';
}

/** Something needs the customer's attention (shown as a warning). */
export function needsAttention(status: AccountStatus): boolean {
  return (
    status === 'past_due' || status === 'suspended' || status === 'cancelled'
  );
}

/**
 * Allowed lifecycle transitions — the organization state machine.
 * Enforced by the database for every writer (trigger
 * accounts_guard_status_transition, migration 912, same matrix in
 * account_status_transition_allowed; account-status.test.ts keeps both
 * equal). Who moves the status:
 *
 *   trial → active             first payment (billing)
 *   active → past_due          renewal overdue (billing)
 *   past_due → active          payment (billing)
 *   past_due → suspended       grace period over (billing cron)
 *   trial|active|past_due → suspended   team (platform panel)
 *   suspended → active         payment (billing suspension only) or team
 *   suspended → trial|past_due team reactivation restores the previous status
 *   cancelled → active         team
 *   * → cancelled              reserved (no automatic path yet)
 */
export const ACCOUNT_STATUS_TRANSITIONS: Record<
  AccountStatus,
  readonly AccountStatus[]
> = {
  trial: ['active', 'past_due', 'suspended', 'cancelled'],
  active: ['past_due', 'suspended', 'cancelled'],
  past_due: ['active', 'suspended', 'cancelled'],
  suspended: ['active', 'trial', 'past_due', 'cancelled'],
  cancelled: ['active'],
};

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return from !== to && ACCOUNT_STATUS_TRANSITIONS[from].includes(to);
}

/** Days left in the trial (ceil), or null when not in trial / no end date. */
export function trialDaysLeft(
  status: AccountStatus,
  trialEndsAt: string | Date | null | undefined,
  now: Date = new Date()
): number | null {
  if (status !== 'trial' || !trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000));
}
