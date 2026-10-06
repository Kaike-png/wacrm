/**
 * BillingService (fork, docs/BILLING.md) — server only.
 *
 * The only place that talks to a payment gateway, always through the
 * BillingProvider contract (./types.ts), and the only place that applies
 * payment outcomes, always through the pure rules (./rules.ts):
 *
 *   BillingService.subscribe(accountId, 'pro')        → first charge (Pix)
 *   BillingService.cancel(accountId)                  → at period end
 *   BillingService.createPixCharge(accountId, …)      → one-off charge
 *   BillingService.refreshPayment(accountId, id)      → ask the gateway (polling)
 *   BillingService.handleWebhook('asaas', request)    → verify, dedupe, apply
 *   BillingService.getOverview(accountId)             → for the settings page
 *
 * Nothing here knows a gateway's name: which one runs is data (the
 * `provider` column of each record) plus BILLING_PROVIDER for new ones.
 */
import { supabaseAdmin } from '@/custom/core/admin';

import type { SuspensionSource } from '../access-policy';
import { toAccountStatus, type AccountStatus } from '../account-status';
import { forgetTenantStatus } from '@/custom/tenancy/access';
import { forgetEntitlements } from '../entitlements';
import { getBillingProvider } from '../providers';
import {
  decideEffects,
  type BillingEffect,
  type SubscriptionChanges,
  type SubscriptionState,
  type SubscriptionStatus,
} from './rules';
import type {
  BillingEvent,
  BillingInterval,
  BillingProvider,
  PaymentMethod,
  PaymentStatus,
  ProviderPayment,
  WebhookRequest,
} from './types';

if (typeof window !== 'undefined') {
  throw new Error('src/billing/payments/service.ts is server-only');
}

export class BillingError extends Error {
  constructor(
    readonly code:
      | 'plan_not_purchasable'
      | 'already_on_plan'
      | 'tax_id_required'
      | 'method_not_supported'
      | 'no_subscription'
      | 'provider_changed'
      | 'not_found',
    message?: string
  ) {
    super(message ?? code);
    this.name = 'BillingError';
  }
  get httpStatus(): number {
    return this.code === 'not_found' || this.code === 'no_subscription'
      ? 404
      : 409;
  }
}

interface PlanRow {
  code: string;
  name: string;
  price_cents: number | null;
  currency: string;
  billing_interval: BillingInterval;
  is_active: boolean;
}

export interface PaymentRow {
  id: string;
  provider: string;
  external_id: string;
  subscription_external_id: string | null;
  plan_code: string | null;
  method: string;
  status: PaymentStatus;
  amount_cents: number;
  currency: string;
  description: string | null;
  due_date: string | null;
  paid_at: string | null;
  period_start: string | null;
  period_end: string | null;
  pix_copy_paste: string | null;
  pix_qr_image: string | null;
  pix_expires_at: string | null;
  boleto_digitable_line: string | null;
  boleto_url: string | null;
  invoice_url: string | null;
  created_at: string;
}

interface SubscriptionRow extends SubscriptionState {
  account_id: string;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  /** Optimistic-concurrency token for billing_apply_effects (912). */
  updated_at: string;
}

const SUB_COLUMNS =
  'account_id, plan_code, status, provider, external_id, pending_external_id, pending_plan_code, current_period_end, cancel_at_period_end, canceled_at, updated_at';

/** Raised when another event changed the same payment/subscription first (SQLSTATE 40001). */
export class BillingConflictError extends Error {
  constructor() {
    super('billing state changed concurrently; retry');
    this.name = 'BillingConflictError';
  }
}

const db = () => supabaseAdmin();

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`[billing] ${context}: ${error?.message ?? 'unknown error'}`);
}

async function loadSubscription(
  accountId: string
): Promise<SubscriptionRow | null> {
  const { data, error } = await db()
    .from('billing_subscriptions')
    .select(SUB_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) fail('load subscription', error);
  return (data as SubscriptionRow | null) ?? null;
}

async function loadAccountState(
  accountId: string
): Promise<{ status: AccountStatus; suspendedBy: SuspensionSource | null }> {
  const { data, error } = await db().rpc('billing_access_state', {
    p_account: accountId,
  });
  if (error) fail('load account', error);
  const row = data as { status?: unknown; suspended_by?: unknown } | null;
  if (!row || !row.status)
    throw new BillingError('not_found', 'organization not found');
  return {
    status: toAccountStatus(row.status),
    suspendedBy:
      row.suspended_by === 'billing' || row.suspended_by === 'platform'
        ? row.suspended_by
        : null,
  };
}

async function loadPlan(code: string): Promise<PlanRow | null> {
  const { data, error } = await db()
    .from('billing_plans')
    .select('code, name, price_cents, currency, billing_interval, is_active')
    .eq('code', code)
    .maybeSingle();
  if (error) fail('load plan', error);
  return (data as PlanRow | null) ?? null;
}

/** Organization data for the gateway's customer record. */
async function customerInput(accountId: string) {
  const [{ data: account }, { data: profile }] = await Promise.all([
    db()
      .from('accounts')
      .select('name, owner_user_id')
      .eq('id', accountId)
      .maybeSingle(),
    db()
      .from('br_account_profiles')
      .select('legal_name, trade_name, tax_id, email, phone')
      .eq('account_id', accountId)
      .maybeSingle(),
  ]);
  const a = account as { name: string; owner_user_id: string | null } | null;
  const p = profile as {
    legal_name: string | null;
    trade_name: string | null;
    tax_id: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  let ownerEmail: string | null = null;
  if (!p?.email && a?.owner_user_id) {
    const { data: owner } = await db()
      .from('profiles')
      .select('email')
      .eq('user_id', a.owner_user_id)
      .maybeSingle();
    ownerEmail = (owner as { email: string | null } | null)?.email ?? null;
  }
  return {
    accountId,
    name: p?.legal_name || p?.trade_name || a?.name || 'Organização',
    email: p?.email || ownerEmail,
    taxId: p?.tax_id || null,
    phone: p?.phone || null,
  };
}

async function ensureCustomer(
  provider: BillingProvider,
  accountId: string
): Promise<string> {
  const { data: existing, error } = await db()
    .from('billing_customers')
    .select('external_id')
    .eq('account_id', accountId)
    .eq('provider', provider.id)
    .maybeSingle();
  if (error) fail('load customer', error);
  if (existing) return (existing as { external_id: string }).external_id;
  const input = await customerInput(accountId);
  if (provider.capabilities.requiresTaxId && !input.taxId)
    throw new BillingError('tax_id_required');
  const customer = await provider.createCustomer(input);
  const { error: insertErr } = await db().from('billing_customers').insert({
    account_id: accountId,
    provider: provider.id,
    external_id: customer.id,
  });
  if (insertErr) fail('save customer', insertErr);
  return customer.id;
}

function paymentRow(
  provider: string,
  accountId: string,
  planCode: string | null,
  p: ProviderPayment
) {
  return {
    account_id: accountId,
    provider,
    external_id: p.id,
    subscription_external_id: p.subscriptionId,
    plan_code: planCode,
    method: p.method,
    status: p.status,
    amount_cents: p.amountCents,
    currency: p.currency,
    description: p.description?.slice(0, 300) ?? null,
    due_date: p.dueDate,
    paid_at: p.paidAt,
    period_start: p.periodStart,
    period_end: p.periodEnd,
    pix_copy_paste: p.pix?.copyPaste ?? null,
    pix_qr_image: p.pix?.qrCodeImage ?? null,
    pix_expires_at: p.pix?.expiresAt ?? null,
    boleto_digitable_line: p.boleto?.digitableLine ?? null,
    boleto_url: p.boleto?.url ?? null,
    invoice_url: p.invoiceUrl,
    updated_at: new Date().toISOString(),
  };
}

async function savePayment(
  provider: string,
  accountId: string,
  planCode: string | null,
  p: ProviderPayment
) {
  const { data, error } = await db()
    .from('billing_payments')
    .upsert(paymentRow(provider, accountId, planCode, p), {
      onConflict: 'provider,external_id',
    })
    .select('*')
    .single();
  if (error) fail('save payment', error);
  return data as PaymentRow;
}

// --------------------------------------------------------------------------
// Applying gateway outcomes
// --------------------------------------------------------------------------

/** Which organization an event belongs to (gateway ids we stored, then the reference we sent). */
async function resolveAccount(
  provider: string,
  event: BillingEvent
): Promise<string | null> {
  const p = event.payment;
  if (p) {
    const { data } = await db()
      .from('billing_payments')
      .select('account_id')
      .eq('provider', provider)
      .eq('external_id', p.id)
      .maybeSingle();
    if (data) return (data as { account_id: string }).account_id;
  }
  const subId = p?.subscriptionId ?? event.subscription?.id ?? null;
  // Gateway ids go into a PostgREST filter: accept only plain id characters.
  if (subId && /^[A-Za-z0-9_.:-]{1,200}$/.test(subId)) {
    const { data } = await db()
      .from('billing_subscriptions')
      .select('account_id')
      .eq('provider', provider)
      .or(`external_id.eq.${subId},pending_external_id.eq.${subId}`)
      .maybeSingle();
    if (data) return (data as { account_id: string }).account_id;
  }
  const customerId = p?.customerId ?? event.subscription?.customerId ?? null;
  if (customerId) {
    const { data } = await db()
      .from('billing_customers')
      .select('account_id')
      .eq('provider', provider)
      .eq('external_id', customerId)
      .maybeSingle();
    if (data) return (data as { account_id: string }).account_id;
  }
  return null;
}

/**
 * Apply the decided effects. Payment, subscription and organization status
 * are written in ONE database transaction (billing_apply_effects, 912),
 * conditional on the state they were decided from: a failure leaves
 * nothing half-applied, and a concurrent event for the same payment makes
 * this one fail with BillingConflictError (the gateway retries and the
 * rules decide again). Gateway calls happen only after the commit.
 */
async function applyEffects(
  provider: string,
  accountId: string,
  before: SubscriptionRow | null,
  effects: BillingEffect[],
  previousPaymentStatus: PaymentStatus | null = null
): Promise<void> {
  let payment: ReturnType<typeof paymentRow> | null = null;
  let subscription: Record<string, unknown> | null = null;
  let status: { from: AccountStatus; to: AccountStatus } | null = null;
  const cancels: string[] = [];
  for (const effect of effects) {
    switch (effect.kind) {
      case 'record_payment': {
        const p = effect.payment;
        const plan =
          before && p.subscriptionId
            ? p.subscriptionId === before.pending_external_id
              ? before.pending_plan_code
              : before.plan_code
            : null;
        payment = paymentRow(provider, accountId, plan, p);
        break;
      }
      case 'update_subscription':
        subscription = { ...(subscription ?? {}), ...effect.changes };
        if (effect.changes.external_id) subscription.provider = provider;
        break;
      case 'set_account_status':
        status = { from: effect.from, to: effect.to };
        break;
      case 'cancel_provider_subscription':
        cancels.push(effect.subscriptionId);
        break;
    }
  }

  if (payment || subscription || status) {
    const { error } = await db().rpc('billing_apply_effects', {
      p_account: accountId,
      p_provider: provider,
      p_payment: payment,
      p_expected_payment_status: payment ? previousPaymentStatus : null,
      p_subscription: subscription,
      p_expected_subscription_at:
        subscription && before ? before.updated_at : null,
      p_account_from: status?.from ?? null,
      p_account_to: status?.to ?? null,
    });
    if (error) {
      if ((error as { code?: string }).code === '40001')
        throw new BillingConflictError();
      fail('apply billing effects', error);
    }
    if (subscription) forgetEntitlements(accountId);
    if (status) forgetTenantStatus(accountId); // the policy applies right away
  }

  for (const subscriptionId of cancels) {
    try {
      await getBillingProvider(before?.provider ?? provider).cancelSubscription(
        subscriptionId,
        { atPeriodEnd: false }
      );
    } catch (err) {
      // The new plan is already paid; a leftover old subscription is
      // reconciled by hand rather than failing the webhook.
      console.error(
        '[billing] could not cancel replaced subscription',
        subscriptionId,
        err
      );
    }
  }
}

async function applyEvent(
  provider: string,
  event: BillingEvent,
  accountId: string
): Promise<BillingEffect[]> {
  const [subscription, accountState] = await Promise.all([
    loadSubscription(accountId),
    loadAccountState(accountId),
  ]);
  const accountStatus = accountState.status;
  let previousPaymentStatus: PaymentStatus | null = null;
  if (event.payment) {
    const { data } = await db()
      .from('billing_payments')
      .select('status')
      .eq('provider', provider)
      .eq('external_id', event.payment.id)
      .maybeSingle();
    previousPaymentStatus =
      (data as { status: PaymentStatus } | null)?.status ?? null;
  }
  const planForInterval =
    subscription?.pending_plan_code &&
    event.payment?.subscriptionId === subscription.pending_external_id
      ? subscription.pending_plan_code
      : subscription?.plan_code;
  const interval =
    (planForInterval && (await loadPlan(planForInterval))?.billing_interval) ||
    'month';
  // Only events about this provider's records may touch the subscription.
  const sameProvider =
    !subscription?.provider ||
    subscription.provider === provider ||
    !!subscription.pending_external_id;
  const effects = decideEffects(event, {
    subscription: sameProvider ? subscription : null,
    accountStatus,
    suspendedBy: accountState.suspendedBy,
    interval,
    previousPaymentStatus,
    now: new Date(),
  });
  await applyEffects(
    provider,
    accountId,
    subscription,
    effects,
    previousPaymentStatus
  );
  return effects;
}

export interface WebhookResult {
  received: number;
  processed: number;
  duplicates: number;
  inProgress: number;
  ignored: number;
}

async function handleWebhook(
  providerId: string,
  request: WebhookRequest
): Promise<WebhookResult> {
  const provider = getBillingProvider(providerId);
  const events = await provider.parseWebhook(request); // throws InvalidWebhookError
  const result: WebhookResult = {
    received: events.length,
    processed: 0,
    duplicates: 0,
    inProgress: 0,
    ignored: 0,
  };

  for (const event of events) {
    const accountId = await resolveAccount(provider.id, event);
    // Atomic claim (910): concurrent or repeated deliveries of the same
    // event cannot both get here — exactly one request processes it.
    const { data: claim, error } = await db().rpc(
      'billing_claim_webhook_event',
      {
        p_provider: provider.id,
        p_event_id: event.id,
        p_type: event.type,
        p_account: accountId,
        p_payment: event.payment?.id ?? null,
      }
    );
    if (error) fail('claim webhook event', error);
    if (claim === 'duplicate') {
      result.duplicates++;
      continue;
    }
    if (claim === 'in_progress') {
      // Another request is applying it right now: nothing to do here.
      result.inProgress++;
      continue;
    }
    const finish = (
      status: 'processed' | 'ignored' | 'failed',
      message: string | null = null
    ) =>
      db().rpc('billing_finish_webhook_event', {
        p_provider: provider.id,
        p_event_id: event.id,
        p_status: status,
        p_error: message,
      });

    if (!accountId) {
      await finish('ignored', 'no organization matches this event');
      result.ignored++;
      continue;
    }
    try {
      await applyEvent(provider.id, event, accountId);
      await finish('processed');
      result.processed++;
    } catch (err) {
      await finish('failed', err instanceof Error ? err.message : String(err));
      throw err; // 5xx → the gateway retries; the failed claim can be taken again
    }
  }
  return result;
}

// --------------------------------------------------------------------------
// Actions started by the organization
// --------------------------------------------------------------------------

async function subscribe(
  accountId: string,
  planCode: string,
  method: PaymentMethod = 'pix'
): Promise<{ payment: PaymentRow }> {
  const plan = await loadPlan(planCode);
  if (!plan || !plan.is_active || plan.price_cents === null)
    throw new BillingError('plan_not_purchasable');
  const provider = getBillingProvider();
  if (!provider.capabilities.methods.includes(method))
    throw new BillingError('method_not_supported');

  const current = await loadSubscription(accountId);
  if (
    current?.plan_code === planCode &&
    (current.status === 'active' || current.status === 'past_due')
  ) {
    throw new BillingError('already_on_plan');
  }
  if (
    current?.external_id &&
    current.provider &&
    current.provider !== provider.id &&
    current.status !== 'canceled'
  ) {
    throw new BillingError(
      'provider_changed',
      'cancel the current subscription before switching gateways'
    );
  }
  // A previous plan change still waiting for payment is replaced.
  if (current?.pending_external_id) {
    await provider
      .cancelSubscription(current.pending_external_id, { atPeriodEnd: false })
      .catch((err) => {
        console.error(
          '[billing] could not cancel abandoned pending subscription',
          err
        );
      });
  }

  const customerId = await ensureCustomer(provider, accountId);
  const { subscription, firstPayment } = await provider.createSubscription({
    customerId,
    accountId,
    planCode: plan.code,
    description: `Plano ${plan.name}`,
    amountCents: plan.price_cents,
    currency: plan.currency,
    interval: plan.billing_interval,
    method,
  });

  try {
    return await recordNewSubscription(
      provider,
      accountId,
      plan,
      current,
      subscription.id,
      firstPayment
    );
  } catch (err) {
    // The gateway already has the subscription; without our row nothing
    // would ever match its charges. Remove it so the customer is not billed
    // for a plan we never recorded (best effort, then surface the error).
    await provider
      .cancelSubscription(subscription.id, { atPeriodEnd: false })
      .catch((cancelErr) =>
        console.error(
          '[billing] could not cancel orphan subscription',
          subscription.id,
          cancelErr
        )
      );
    throw err;
  }
}

async function recordNewSubscription(
  provider: BillingProvider,
  accountId: string,
  plan: PlanRow,
  current: SubscriptionRow | null,
  subscriptionId: string,
  firstPayment: ProviderPayment
): Promise<{ payment: PaymentRow }> {
  const keepsActive =
    current && (current.status === 'active' || current.status === 'past_due');
  // No row yet (organization from before plans existed): it stays on the
  // default plan until the first payment confirms the new one.
  let basePlan = current?.plan_code ?? null;
  if (!basePlan) {
    const { data: def } = await db()
      .from('billing_plans')
      .select('code')
      .eq('is_default', true)
      .maybeSingle();
    basePlan = (def as { code: string } | null)?.code ?? plan.code;
  }
  const row = {
    account_id: accountId,
    plan_code: basePlan,
    status: (keepsActive ? current.status : 'pending') as SubscriptionStatus,
    provider: keepsActive ? current.provider : provider.id,
    pending_external_id: subscriptionId,
    pending_plan_code: plan.code,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db()
    .from('billing_subscriptions')
    .upsert(row, { onConflict: 'account_id' });
  if (error) fail('save subscription', error);
  const payment = await savePayment(
    provider.id,
    accountId,
    plan.code,
    firstPayment
  );
  return { payment };
}

async function cancel(accountId: string): Promise<void> {
  const current = await loadSubscription(accountId);
  if (!current) throw new BillingError('no_subscription');
  const provider = current.provider
    ? getBillingProvider(current.provider)
    : getBillingProvider();
  if (current.pending_external_id) {
    await provider.cancelSubscription(current.pending_external_id, {
      atPeriodEnd: false,
    });
  }
  const changes: SubscriptionChanges = {};
  if (current.external_id && current.status !== 'canceled') {
    const sub = await provider.cancelSubscription(current.external_id, {
      atPeriodEnd: true,
    });
    Object.assign(changes, {
      status: 'canceled',
      cancel_at_period_end: true,
      canceled_at: new Date().toISOString(),
      current_period_end: sub.currentPeriodEnd ?? current.current_period_end,
    });
  }
  if (current.pending_external_id) {
    Object.assign(changes, {
      pending_external_id: null,
      pending_plan_code: null,
      ...(current.status === 'pending' ? { status: 'manual' as const } : {}),
    });
  }
  if (Object.keys(changes).length > 0) {
    // One write (912 checks the subscription did not change meanwhile).
    await applyEffects(provider.id, accountId, current, [
      { kind: 'update_subscription', changes },
    ]);
  }
  if (!current.external_id && !current.pending_external_id)
    throw new BillingError('no_subscription');
}

async function createPixCharge(
  accountId: string,
  input: {
    amountCents: number;
    description: string;
    expiresInSeconds?: number;
    currency?: string;
  }
): Promise<PaymentRow> {
  const provider = getBillingProvider();
  if (!provider.capabilities.methods.includes('pix'))
    throw new BillingError('method_not_supported');
  const customerId = await ensureCustomer(provider, accountId);
  const payment = await provider.createPixCharge({
    customerId,
    accountId,
    amountCents: input.amountCents,
    currency: input.currency ?? 'BRL',
    description: input.description,
    expiresInSeconds: input.expiresInSeconds,
  });
  return savePayment(provider.id, accountId, null, payment);
}

/** Ask the gateway for a payment's current state and apply it (polling fallback). */
async function refreshPayment(
  accountId: string,
  paymentId: string
): Promise<PaymentRow> {
  const { data, error } = await db()
    .from('billing_payments')
    .select('provider, external_id')
    .eq('id', paymentId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) fail('load payment', error);
  if (!data) throw new BillingError('not_found');
  const row = data as { provider: string; external_id: string };
  const fresh = await getBillingProvider(row.provider).getPayment(
    row.external_id
  );
  await applyEvent(
    row.provider,
    {
      id: `poll:${fresh.id}:${fresh.status}`,
      type: 'payment.updated',
      occurredAt: new Date().toISOString(),
      payment: fresh,
    },
    accountId
  );
  const { data: updated } = await db()
    .from('billing_payments')
    .select('*')
    .eq('id', paymentId)
    .single();
  return updated as PaymentRow;
}

async function getPayment(
  accountId: string,
  paymentId: string
): Promise<PaymentRow> {
  const { data, error } = await db()
    .from('billing_payments')
    .select('*')
    .eq('id', paymentId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) fail('load payment', error);
  if (!data) throw new BillingError('not_found');
  return data as PaymentRow;
}

async function getOverview(accountId: string) {
  const provider = getBillingProvider();
  const [subscription, plans, payments] = await Promise.all([
    loadSubscription(accountId),
    db()
      .from('billing_plans')
      .select(
        'code, name, price_cents, currency, billing_interval, is_active, sort_order'
      )
      .eq('is_active', true)
      .order('sort_order'),
    db()
      .from('billing_payments')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);
  if (plans.error) fail('load plans', plans.error);
  if (payments.error) fail('load payments', payments.error);
  return {
    provider: {
      id: provider.id,
      name: provider.displayName,
      sandbox: provider.capabilities.sandbox,
      methods: provider.capabilities.methods,
      simulator: provider.capabilities.simulator === true,
    },
    subscription,
    plans: (plans.data ?? []) as (PlanRow & { sort_order: number })[],
    payments: (payments.data ?? []) as PaymentRow[],
  };
}

/** Canceled subscriptions whose period ended go back to the default plan. */
/** past_due longer than the grace period → suspended (by billing). Never deletes anything. */
async function enforceDelinquency(graceDays: number): Promise<number> {
  const { data, error } = await db().rpc('billing_enforce_delinquency', {
    p_grace_days: graceDays,
  });
  if (error) fail('enforce delinquency', error);
  forgetTenantStatus();
  return Number(data ?? 0);
}

async function expireSubscriptions(): Promise<number> {
  const { data, error } = await db().rpc('billing_expire_subscriptions');
  if (error) fail('expire subscriptions', error);
  forgetEntitlements();
  return Number(data ?? 0);
}

/** Trials past trial_ends_at → past_due (then the delinquency grace period). */
async function expireTrials(): Promise<number> {
  const { data, error } = await db().rpc('billing_expire_trials');
  if (error) fail('expire trials', error);
  forgetTenantStatus();
  return Number(data ?? 0);
}

export const BillingService = {
  subscribe,
  cancel,
  createPixCharge,
  refreshPayment,
  getPayment,
  handleWebhook,
  getOverview,
  expireSubscriptions,
  expireTrials,
  enforceDelinquency,
} as const;
