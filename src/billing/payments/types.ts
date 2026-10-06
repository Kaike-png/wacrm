/**
 * Payment gateway contract (fork, docs/BILLING.md). Pure types.
 *
 * Every gateway (mock, Asaas, Mercado Pago, Efí, Pagar.me…) implements
 * BillingProvider and translates to/from these normalized shapes. Business
 * rules (./rules.ts) and the service (./service.ts) only ever see these
 * types — never a gateway's own statuses, field names or SDK.
 *
 * Money is always integer cents + ISO currency. Ids are the gateway's.
 */

export type PaymentMethod = 'pix' | 'boleto' | 'card';

/** Normalized payment lifecycle (gateway statuses map onto these). */
export type PaymentStatus =
  'pending' | 'paid' | 'overdue' | 'refunded' | 'canceled' | 'failed';

/** Normalized subscription lifecycle at the gateway. */
export type ProviderSubscriptionStatus =
  'pending' | 'active' | 'past_due' | 'canceled';

export type BillingInterval = 'month' | 'year';

export interface ProviderCapabilities {
  methods: readonly PaymentMethod[];
  /** Gateway charges every period by itself (else the app must create charges). */
  recurring: boolean;
  /** Development / test only — never in production. */
  sandbox: boolean;
  /** The gateway refuses customers without CPF/CNPJ (common for Pix / boleto in BR). */
  requiresTaxId: boolean;
  /** Payments can be settled from the app (development simulator). */
  simulator?: boolean;
}

export interface CustomerInput {
  /** Our organization id — stored by the gateway as external reference. */
  accountId: string;
  name: string;
  email: string | null;
  /** CPF / CNPJ, digits (or the alphanumeric CNPJ), no mask. Required for Pix by most BR gateways. */
  taxId: string | null;
  phone: string | null;
}

export interface ProviderCustomer {
  id: string;
}

export interface PixData {
  /** "Pix copia e cola" (BR Code / EMV payload). */
  copyPaste: string;
  /** data: URL or https URL of the QR image, when the gateway provides one. */
  qrCodeImage: string | null;
  expiresAt: string | null;
}

export interface BoletoData {
  /** Linha digitável. */
  digitableLine: string | null;
  /** PDF / page of the boleto. */
  url: string | null;
}

export interface ProviderPayment {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  /** Echo of what we sent (our account id) when the gateway supports it. */
  externalReference: string | null;
  status: PaymentStatus;
  /** 'other' when the gateway reports a method we do not sell (cash, transfer…). */
  method: PaymentMethod | 'other';
  amountCents: number;
  currency: string;
  description: string | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
  paidAt: string | null;
  /** Service period this payment covers (subscriptions). */
  periodStart: string | null;
  periodEnd: string | null;
  pix: PixData | null;
  boleto?: BoletoData | null;
  /** Gateway-hosted page to pay (card entry, boleto, Pix) — no card data ever touches us. */
  invoiceUrl: string | null;
}

export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: ProviderSubscriptionStatus;
  amountCents: number;
  currency: string;
  interval: BillingInterval;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface SubscriptionInput {
  customerId: string;
  accountId: string;
  planCode: string;
  description: string;
  amountCents: number;
  currency: string;
  interval: BillingInterval;
  method: PaymentMethod;
}

export interface PixChargeInput {
  customerId: string;
  accountId: string;
  amountCents: number;
  currency: string;
  description: string;
  /** Seconds until the Pix code expires. */
  expiresInSeconds?: number;
}

/** A gateway notification, already verified and normalized. */
export interface BillingEvent {
  /** Gateway's event id — the idempotency key. */
  id: string;
  type: 'payment.updated' | 'subscription.updated';
  occurredAt: string;
  payment?: ProviderPayment;
  subscription?: ProviderSubscription;
}

export interface WebhookRequest {
  headers: Headers;
  /** Exact bytes as received (signatures are computed over them). */
  rawBody: string;
}

export interface BillingProvider {
  /** Stable id stored in the database ('mock', 'asaas', …). */
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  createCustomer(input: CustomerInput): Promise<ProviderCustomer>;
  /** Creates the subscription and returns its first charge (to be paid to activate). */
  createSubscription(input: SubscriptionInput): Promise<{
    subscription: ProviderSubscription;
    firstPayment: ProviderPayment;
  }>;
  cancelSubscription(
    subscriptionId: string,
    opts: { atPeriodEnd: boolean }
  ): Promise<ProviderSubscription>;
  /** One-off Pix charge (e.g. setup fee, extra usage). */
  createPixCharge(input: PixChargeInput): Promise<ProviderPayment>;
  getPayment(paymentId: string): Promise<ProviderPayment>;
  /**
   * Verify the notification's authenticity (signature / token) and
   * translate it. Throws InvalidWebhookError when it cannot be trusted.
   * Must not touch the database: the service applies the events.
   */
  parseWebhook(request: WebhookRequest): Promise<BillingEvent[]>;
}

/** The gateway refused or failed; `retryable` when it may succeed later. */
export class BillingProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'BillingProviderError';
  }
}

export class InvalidWebhookError extends Error {
  constructor(message = 'invalid webhook') {
    super(message);
    this.name = 'InvalidWebhookError';
  }
}

/** The gateway is registered but not usable here (missing / invalid configuration). */
export class BillingProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingProviderUnavailableError';
  }
}
