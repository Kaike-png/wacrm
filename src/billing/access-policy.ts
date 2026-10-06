/**
 * Delinquency / access policy (fork, docs/DELINQUENCY.md). Pure.
 *
 * THE single place that says what each organization status allows. The
 * app asks "can this organization do X?" (src/billing/enforcement.ts),
 * never "is the status Y?". The database holds the same matrix
 * (account_status_blocks, migration 911) and enforces it on every write
 * path; policy-sync.test.ts keeps the two identical.
 */
import { ACCOUNT_STATUSES, type AccountStatus } from './account-status';

/** Actions a status can take away. Everything else is always allowed. */
export const RESTRICTABLE_ACTIONS = [
  'messages.send', // inbox, API, reactions, AI replies — anything that sends WhatsApp
  'campaigns.send', // start / schedule / resume a broadcast
  'automations.run', // automations, flows, AI auto-reply: create, switch on, execute
  'integrations.create', // new WhatsApp number, webhook, API key, AI provider
] as const;
export type RestrictedAction = (typeof RESTRICTABLE_ACTIONS)[number];

/** Never blocked by any status (documentation + tests). Data is never deleted. */
export const ALWAYS_ALLOWED = [
  'login',
  'data.read',
  'data.write',
  'data.export',
  'billing.view',
  'billing.pay',
] as const;

export type AccessNotice = 'payment_due' | 'suspended' | 'cancelled';

export interface StatusPolicy {
  blocks: readonly RestrictedAction[];
  /** Banner shown to members. */
  notice: AccessNotice | null;
  /** Inbound WhatsApp messages are stored (no automatic replies when automations.run is blocked). */
  receivesInbound: boolean;
}

const SUSPENDED_BLOCKS: readonly RestrictedAction[] = RESTRICTABLE_ACTIONS;

export const ACCESS_POLICY: Record<AccountStatus, StatusPolicy> = {
  trial: { blocks: [], notice: null, receivesInbound: true },
  active: { blocks: [], notice: null, receivesInbound: true },
  past_due: { blocks: [], notice: 'payment_due', receivesInbound: true },
  suspended: {
    blocks: SUSPENDED_BLOCKS,
    notice: 'suspended',
    receivesInbound: true,
  },
  cancelled: {
    blocks: SUSPENDED_BLOCKS,
    notice: 'cancelled',
    receivesInbound: false,
  },
};

export function policyFor(status: AccountStatus): StatusPolicy {
  return ACCESS_POLICY[status] ?? ACCESS_POLICY.active;
}

export function canPerform(
  status: AccountStatus,
  action: RestrictedAction
): boolean {
  return !policyFor(status).blocks.includes(action);
}

export function isRestrictedAction(value: unknown): value is RestrictedAction {
  return (
    typeof value === 'string' &&
    (RESTRICTABLE_ACTIONS as readonly string[]).includes(value)
  );
}

/** Statuses that block a given action (for docs, tests, SQL sync). */
export function statusesBlocking(action: RestrictedAction): AccountStatus[] {
  return ACCOUNT_STATUSES.filter((s) => !canPerform(s, action));
}

/** Who suspended — decides whether a payment lifts the suspension. */
export type SuspensionSource = 'billing' | 'platform';

/** A confirmed payment re-opens these (rules.ts); a team suspension needs the team. */
export function paymentReopens(
  status: AccountStatus,
  suspendedBy: SuspensionSource | null
): boolean {
  if (status === 'trial' || status === 'past_due') return true;
  return status === 'suspended' && suspendedBy === 'billing';
}

/** Default grace period between past_due and an automatic suspension. */
export const DEFAULT_GRACE_DAYS = 7;

export function graceDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BILLING_GRACE_DAYS);
  return Number.isInteger(n) && n >= 0 && n <= 365 ? n : DEFAULT_GRACE_DAYS;
}
