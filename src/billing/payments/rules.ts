/**
 * Billing rules (fork, docs/BILLING.md). Pure — no gateway, no database.
 *
 * Given a normalized gateway event and the organization's current state,
 * decide what changes. The service applies the effects; adapters never
 * decide anything. Same input → same effects, and re-delivering an event
 * that was already applied changes nothing.
 *
 *   first payment of a plan change paid  → plan switches, subscription
 *                                          active, previous gateway
 *                                          subscription canceled,
 *                                          organization trial/past_due → active
 *   renewal paid                         → period extended, past_due → active
 *   renewal overdue                      → subscription and organization past_due
 *   paid → pending/overdue (late, reordered) → ignored
 *   subscription canceled at the gateway → keeps the plan until the period
 *                                          ends (then the default plan, cron)
 *
 * Paying lifts a suspension made by billing (delinquency, see
 * docs/DELINQUENCY.md); a suspension by the platform team, or a cancelled
 * organization, is never touched here.
 */
import { paymentReopens, type SuspensionSource } from '../access-policy';
import type { AccountStatus } from '../account-status';

import type {
  BillingEvent,
  BillingInterval,
  PaymentStatus,
  ProviderPayment,
} from './types';

export type SubscriptionStatus =
  'manual' | 'pending' | 'active' | 'past_due' | 'canceled';

export interface SubscriptionState {
  plan_code: string | null;
  status: SubscriptionStatus;
  provider: string | null;
  external_id: string | null;
  pending_external_id: string | null;
  pending_plan_code: string | null;
  current_period_end: string | null;
}

export interface SubscriptionChanges {
  plan_code?: string;
  status?: SubscriptionStatus;
  external_id?: string | null;
  pending_external_id?: string | null;
  pending_plan_code?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  canceled_at?: string | null;
}

export type BillingEffect =
  | { kind: 'record_payment'; payment: ProviderPayment }
  | { kind: 'update_subscription'; changes: SubscriptionChanges }
  | { kind: 'set_account_status'; from: AccountStatus; to: AccountStatus }
  | { kind: 'cancel_provider_subscription'; subscriptionId: string };

export interface RuleContext {
  subscription: SubscriptionState | null;
  accountStatus: AccountStatus;
  /** Who suspended the organization (only a billing suspension is lifted by paying). */
  suspendedBy?: SuspensionSource | null;
  /** Interval of the plan being paid (fallback period length). */
  interval: BillingInterval;
  /** Status we already recorded for this payment, if any. */
  previousPaymentStatus: PaymentStatus | null;
  now: Date;
}

export function addInterval(from: Date, interval: BillingInterval): Date {
  const d = new Date(from.getTime());
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** Delinquency policy (access-policy.ts) decides what a payment re-opens. */
function reopen(
  status: AccountStatus,
  suspendedBy: SuspensionSource | null | undefined
): AccountStatus | null {
  return paymentReopens(status, suspendedBy ?? null) ? 'active' : null;
}

export function decideEffects(
  event: BillingEvent,
  ctx: RuleContext
): BillingEffect[] {
  const effects: BillingEffect[] = [];
  const s = ctx.subscription;
  const setAccount = (to: AccountStatus | null) => {
    if (to && to !== ctx.accountStatus)
      effects.push({ kind: 'set_account_status', from: ctx.accountStatus, to });
  };

  if (event.type === 'payment.updated' && event.payment) {
    const p = event.payment;
    const prev = ctx.previousPaymentStatus;
    // Out-of-order delivery (gateways do not guarantee order): a paid
    // payment never goes back to pending/overdue. Ignore the stale event.
    if (prev === 'paid' && (p.status === 'pending' || p.status === 'overdue'))
      return [];
    effects.push({ kind: 'record_payment', payment: p });
    // Re-delivery of something already applied: record only.
    if (prev === p.status) return effects;
    if (!s || !p.subscriptionId) return effects;

    const isActivation = p.subscriptionId === s.pending_external_id;
    const isRenewal = !isActivation && p.subscriptionId === s.external_id;

    // Only the first time a payment becomes paid grants service (a
    // chargeback won and re-confirmed later must not extend twice).
    const firstPaid =
      prev === null ||
      prev === 'pending' ||
      prev === 'overdue' ||
      prev === 'failed';
    if (p.status === 'paid' && firstPaid) {
      if (isActivation) {
        const periodEnd =
          p.periodEnd ?? addInterval(ctx.now, ctx.interval).toISOString();
        effects.push({
          kind: 'update_subscription',
          changes: {
            plan_code: s.pending_plan_code ?? s.plan_code ?? undefined,
            status: 'active',
            external_id: p.subscriptionId,
            pending_external_id: null,
            pending_plan_code: null,
            current_period_end: periodEnd,
            cancel_at_period_end: false,
            canceled_at: null,
          },
        });
        if (s.external_id && s.external_id !== p.subscriptionId) {
          effects.push({
            kind: 'cancel_provider_subscription',
            subscriptionId: s.external_id,
          });
        }
        setAccount(reopen(ctx.accountStatus, ctx.suspendedBy));
      } else if (isRenewal) {
        const base = s.current_period_end
          ? new Date(s.current_period_end)
          : ctx.now;
        const from = base > ctx.now ? base : ctx.now;
        effects.push({
          kind: 'update_subscription',
          changes: {
            status: s.status === 'canceled' ? 'canceled' : 'active',
            current_period_end:
              p.periodEnd ?? addInterval(from, ctx.interval).toISOString(),
          },
        });
        setAccount(reopen(ctx.accountStatus, ctx.suspendedBy));
      }
    } else if (p.status === 'overdue' && isRenewal && s.status === 'active') {
      effects.push({
        kind: 'update_subscription',
        changes: { status: 'past_due' },
      });
      if (ctx.accountStatus === 'active') setAccount('past_due');
    }
    return effects;
  }

  if (event.type === 'subscription.updated' && event.subscription && s) {
    const sub = event.subscription;
    if (sub.status === 'canceled') {
      if (sub.id === s.external_id && s.status !== 'canceled') {
        effects.push({
          kind: 'update_subscription',
          changes: {
            status: 'canceled',
            cancel_at_period_end: true,
            canceled_at: ctx.now.toISOString(),
            current_period_end: sub.currentPeriodEnd ?? s.current_period_end,
          },
        });
      } else if (sub.id === s.pending_external_id) {
        // A plan change abandoned before its first payment.
        effects.push({
          kind: 'update_subscription',
          changes: {
            pending_external_id: null,
            pending_plan_code: null,
            ...(s.status === 'pending' ? { status: 'manual' as const } : {}),
          },
        });
      }
    } else if (
      sub.status === 'past_due' &&
      sub.id === s.external_id &&
      s.status === 'active'
    ) {
      effects.push({
        kind: 'update_subscription',
        changes: { status: 'past_due' },
      });
      if (ctx.accountStatus === 'active') setAccount('past_due');
    }
  }
  return effects;
}
