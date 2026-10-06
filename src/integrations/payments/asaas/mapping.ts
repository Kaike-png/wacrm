/**
 * Asaas ↔ normalized billing shapes (fork, docs/ASAAS.md). Pure.
 *
 * Everything Asaas-specific (status names, billingType, reais as floats,
 * "YYYY-MM-DD HH:mm:ss" dates in Brasília time, event names) stops here.
 */
import type {
  BillingEvent,
  BillingInterval,
  PaymentMethod,
  PaymentStatus,
  ProviderPayment,
  ProviderSubscription,
  ProviderSubscriptionStatus,
} from '@/billing/payments/types';

// ------------------------------------------------------------------ API types

export type AsaasBillingType =
  | 'UNDEFINED'
  | 'BOLETO'
  | 'CREDIT_CARD'
  | 'DEBIT_CARD'
  | 'TRANSFER'
  | 'DEPOSIT'
  | 'PIX';

export interface AsaasPayment {
  object?: 'payment';
  id: string;
  customer?: string | null;
  subscription?: string | null;
  externalReference?: string | null;
  status: string;
  billingType?: AsaasBillingType | string;
  value: number;
  description?: string | null;
  dueDate?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  deleted?: boolean;
}

export interface AsaasSubscription {
  object?: 'subscription';
  id: string;
  customer: string;
  value: number;
  nextDueDate?: string | null;
  cycle?: string;
  billingType?: string;
  status?: 'ACTIVE' | 'EXPIRED' | 'INACTIVE' | string;
  deleted?: boolean;
  externalReference?: string | null;
}

export interface AsaasPixQrCode {
  encodedImage?: string | null;
  payload?: string | null;
  expirationDate?: string | null;
}

export interface AsaasWebhookBody {
  id?: string;
  event?: string;
  dateCreated?: string;
  account?: { id?: string | null } | null;
  payment?: AsaasPayment;
  subscription?: AsaasSubscription;
}

// ------------------------------------------------------------------ values

/** R$ 199.9 → 19990 (floats from JSON, rounded — never truncated). */
export const toCents = (value: number | null | undefined): number =>
  Math.round((Number(value) || 0) * 100);
export const toReais = (cents: number): number => Math.round(cents) / 100;

/**
 * Asaas dates are Brasília time without offset ("2024-06-12 16:45:03" or
 * "2024-06-12"). Brazil has no DST since 2019 → fixed -03:00.
 */
export function asaasDateToIso(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/.exec(
    value.trim()
  );
  if (!m) return null;
  const time = m[2] ? (m[2].length === 5 ? `${m[2]}:00` : m[2]) : '00:00:00';
  const d = new Date(`${m[1]}T${time}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Today in Brasília (Asaas due dates are local dates). */
export function todayInBrazil(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
  }).format(now);
}

export const CYCLE: Record<BillingInterval, string> = {
  month: 'MONTHLY',
  year: 'YEARLY',
};
export const BILLING_TYPE: Record<PaymentMethod, AsaasBillingType> = {
  pix: 'PIX',
  boleto: 'BOLETO',
  card: 'CREDIT_CARD',
};

export function methodFromBillingType(
  t: string | null | undefined
): PaymentMethod | 'other' {
  switch (t) {
    case 'PIX':
      return 'pix';
    case 'BOLETO':
      return 'boleto';
    case 'CREDIT_CARD':
    case 'DEBIT_CARD':
      return 'card';
    default:
      return 'other';
  }
}

/**
 * Asaas payment status → internal payment status. Card CONFIRMED counts as
 * paid (Asaas only moves it to RECEIVED when the money settles, ~32 days).
 * Unknown future statuses fall back to pending (no service granted).
 */
export function paymentStatusFromAsaas(
  status: string,
  deleted = false
): PaymentStatus {
  if (deleted) return 'canceled';
  switch (status) {
    case 'RECEIVED':
    case 'CONFIRMED':
    case 'RECEIVED_IN_CASH':
    case 'DUNNING_RECEIVED':
      return 'paid';
    case 'OVERDUE':
    case 'DUNNING_REQUESTED':
      return 'overdue';
    case 'REFUNDED':
    case 'REFUND_REQUESTED':
    case 'REFUND_IN_PROGRESS':
    case 'CHARGEBACK_REQUESTED':
    case 'CHARGEBACK_DISPUTE':
    case 'AWAITING_CHARGEBACK_REVERSAL':
      return 'refunded';
    case 'PENDING':
    case 'AWAITING_RISK_ANALYSIS':
    default:
      return 'pending';
  }
}

export function subscriptionStatusFromAsaas(
  s: Pick<AsaasSubscription, 'status' | 'deleted'>
): ProviderSubscriptionStatus {
  if (s.deleted) return 'canceled';
  if (s.status === 'INACTIVE' || s.status === 'EXPIRED') return 'canceled';
  return 'active';
}

export function toProviderPayment(
  p: AsaasPayment,
  extra: Partial<ProviderPayment> = {}
): ProviderPayment {
  const status = paymentStatusFromAsaas(p.status, p.deleted === true);
  const method = methodFromBillingType(p.billingType);
  return {
    id: p.id,
    customerId: p.customer ?? null,
    subscriptionId: p.subscription ?? null,
    externalReference: p.externalReference ?? null,
    status,
    method,
    amountCents: toCents(p.value),
    currency: 'BRL',
    description: p.description ?? null,
    dueDate: p.dueDate ?? null,
    paidAt:
      status === 'paid'
        ? asaasDateToIso(
            p.clientPaymentDate ?? p.paymentDate ?? p.confirmedDate ?? null
          )
        : null,
    // Asaas payments do not carry the service period: the rules use the
    // plan interval from the activation / current period end.
    periodStart: null,
    periodEnd: null,
    pix: null,
    boleto:
      method === 'boleto' && p.bankSlipUrl
        ? { digitableLine: null, url: p.bankSlipUrl }
        : null,
    invoiceUrl: p.invoiceUrl ?? null,
    ...extra,
  };
}

export function toProviderSubscription(
  s: AsaasSubscription,
  interval: BillingInterval = 'month'
): ProviderSubscription {
  return {
    id: s.id,
    customerId: s.customer,
    status: subscriptionStatusFromAsaas(s),
    amountCents: toCents(s.value),
    currency: 'BRL',
    interval: s.cycle === 'YEARLY' ? 'year' : interval,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };
}

// ------------------------------------------------------------------ webhooks

/** Events that change state; everything else (views, split, anticipation…) is acknowledged and ignored. */
const PAYMENT_EVENTS = new Set([
  'PAYMENT_CREATED',
  'PAYMENT_UPDATED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_DELETED',
  'PAYMENT_RESTORED',
  'PAYMENT_REFUNDED',
  'PAYMENT_PARTIALLY_REFUNDED',
  'PAYMENT_REFUND_IN_PROGRESS',
  'PAYMENT_RECEIVED_IN_CASH_UNDONE',
  'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
  'PAYMENT_DUNNING_REQUESTED',
  'PAYMENT_DUNNING_RECEIVED',
  'PAYMENT_AWAITING_RISK_ANALYSIS',
  'PAYMENT_APPROVED_BY_RISK_ANALYSIS',
  'PAYMENT_REPROVED_BY_RISK_ANALYSIS',
  'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
  'PAYMENT_BANK_SLIP_CANCELLED',
]);

const SUBSCRIPTION_EVENTS = new Set([
  'SUBSCRIPTION_UPDATED',
  'SUBSCRIPTION_INACTIVATED',
  'SUBSCRIPTION_DELETED',
]);

/** The event decides when it is more specific than the embedded status. */
function statusForEvent(event: string, payment: AsaasPayment): PaymentStatus {
  switch (event) {
    case 'PAYMENT_DELETED':
    case 'PAYMENT_BANK_SLIP_CANCELLED':
      return 'canceled';
    case 'PAYMENT_REPROVED_BY_RISK_ANALYSIS':
    case 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED':
      return 'failed';
    case 'PAYMENT_RECEIVED_IN_CASH_UNDONE':
      return 'pending';
    default:
      return paymentStatusFromAsaas(payment.status, payment.deleted === true);
  }
}

/**
 * Translate one verified webhook body. Returns [] for events we do not act
 * on (still answered 200 so the Asaas queue keeps flowing). Throws on a
 * body without event id / type (cannot be made idempotent).
 */
export function eventsFromWebhook(body: AsaasWebhookBody): BillingEvent[] {
  if (
    !body ||
    typeof body.id !== 'string' ||
    !body.id ||
    typeof body.event !== 'string'
  ) {
    throw new Error('malformed Asaas webhook (missing id/event)');
  }
  const occurredAt =
    asaasDateToIso(body.dateCreated) ?? new Date().toISOString();

  if (PAYMENT_EVENTS.has(body.event) && body.payment?.id) {
    const payment = toProviderPayment(body.payment, {
      status: statusForEvent(body.event, body.payment),
    });
    return [{ id: body.id, type: 'payment.updated', occurredAt, payment }];
  }
  if (SUBSCRIPTION_EVENTS.has(body.event) && body.subscription?.id) {
    const sub = toProviderSubscription(body.subscription);
    if (
      body.event === 'SUBSCRIPTION_DELETED' ||
      body.event === 'SUBSCRIPTION_INACTIVATED'
    )
      sub.status = 'canceled';
    return [
      {
        id: body.id,
        type: 'subscription.updated',
        occurredAt,
        subscription: sub,
      },
    ];
  }
  return [];
}
