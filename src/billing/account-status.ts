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
 * Allowed lifecycle transitions, for billing code and operator tools.
 * The database accepts any of the five values from the service role;
 * this is the business rule on top.
 */
const TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  trial: ['active', 'past_due', 'suspended', 'cancelled'],
  active: ['past_due', 'suspended', 'cancelled'],
  past_due: ['active', 'suspended', 'cancelled'],
  suspended: ['active', 'cancelled'],
  cancelled: ['active'],
};

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return from !== to && TRANSITIONS[from].includes(to);
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
