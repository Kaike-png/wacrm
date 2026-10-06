/**
 * WhatsApp connection status of a tenant — pure part (fork,
 * docs/WHATSAPP_SAAS.md). Shared by the server (test, summary) and the
 * status card.
 */

export const CONNECTION_STATUSES = [
  'connected',
  'pending',
  'error',
  'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_EVENTS = [
  'saved',
  'save_failed',
  'tested',
  'registered',
  'registration_failed',
  'disconnected',
  'webhook_received',
  'webhook_rejected',
] as const;
export type ConnectionEvent = (typeof CONNECTION_EVENTS)[number];

/** The non-secret part of a whatsapp_config row that drives the status. */
export interface ConnectionRow {
  status?: string | null;
  waba_id?: string | null;
  registered_at?: string | null;
  subscribed_apps_at?: string | null;
  last_registration_error?: string | null;
  last_check_error?: string | null;
  last_webhook_at?: string | null;
}

/**
 * Status shown to the tenant:
 *   disconnected — no configuration saved;
 *   error        — the last save, registration or test failed;
 *   pending      — saved and valid, but a step is missing (WABA not
 *                  subscribed to the app, number registration pending);
 *   connected    — credentials valid and the WABA subscribed.
 * A webhook received recently overrides "pending" (Meta is delivering).
 */
export function computeConnectionStatus(
  row: ConnectionRow | null | undefined,
  now: Date = new Date()
): ConnectionStatus {
  if (!row) return 'disconnected';
  if (
    row.status === 'error' ||
    row.last_check_error ||
    row.last_registration_error
  )
    return 'error';
  if (webhookIsRecent(row.last_webhook_at, now)) return 'connected';
  if (row.status === 'pending' || row.status === 'disconnected')
    return 'pending';
  if (row.waba_id && !row.subscribed_apps_at) return 'pending';
  return 'connected';
}

const RECENT_WEBHOOK_MS = 7 * 24 * 3600_000;

export function webhookIsRecent(
  at: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!at) return false;
  const t = new Date(at).getTime();
  return !Number.isNaN(t) && now.getTime() - t < RECENT_WEBHOOK_MS;
}

/** Checks reported by "Testar conexão". `null` = not applicable / unknown. */
export interface ConnectionChecks {
  /** Token decrypts and Meta accepts it for the number. */
  credentials: boolean;
  /** The number is listed under the saved WABA. */
  wabaMatch: boolean | null;
  /** The WABA is subscribed to an app (webhooks are delivered). */
  subscribed: boolean | null;
  /** …and to this deploy's META_APP_ID, when configured. */
  appIdMatch: boolean | null;
  registered: boolean;
  webhookRecent: boolean;
}

/** Status after a test, from its checks. */
export function statusFromChecks(checks: ConnectionChecks): ConnectionStatus {
  if (!checks.credentials || checks.wabaMatch === false) return 'error';
  if (checks.webhookRecent) return 'connected';
  if (checks.subscribed === false || checks.appIdMatch === false)
    return 'pending';
  return 'connected';
}

/** What the API returns about a connection. Never secrets. */
export interface ConnectionSummary {
  status: ConnectionStatus;
  phoneNumberId: string | null;
  wabaId: string | null;
  businessId: string | null;
  /** `••••ab12` for admins, null otherwise. */
  tokenHint: string | null;
  hasVerifyToken: boolean;
  hasPin: boolean;
  registeredAt: string | null;
  subscribedAt: string | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastWebhookAt: string | null;
  events: {
    id: number;
    event: ConnectionEvent;
    status: ConnectionStatus | null;
    message: string | null;
    meta_error_code: number | null;
    created_at: string;
  }[];
}
