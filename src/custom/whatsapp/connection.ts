/**
 * WhatsApp connection — server part (fork, docs/WHATSAPP_SAAS.md):
 * summary for the status screen, "Testar conexão", and the connection
 * log. Service role, always scoped to the caller's account_id. Nothing
 * returned or stored here contains a token, verify token or PIN.
 */
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  getSubscribedApps,
  listWabaPhoneNumbers,
  verifyPhoneNumber,
  type MetaPhoneInfo,
} from '@/lib/whatsapp/meta-api';
import { explainMetaError } from '@/lib/whatsapp/meta-error-explain';
import {
  appSubscriptionState,
  phoneNumberBelongsToWaba,
} from '@/lib/whatsapp/waba-pairing';

import { getWhatsAppConfigRow } from './config-store';
import { safeMessage, tokenHint } from './redact';
import {
  computeConnectionStatus,
  statusFromChecks,
  webhookIsRecent,
  type ConnectionChecks,
  type ConnectionEvent,
  type ConnectionStatus,
  type ConnectionSummary,
} from './status';

export interface LogConnectionEventInput {
  accountId: string;
  event: ConnectionEvent;
  status?: ConnectionStatus | null;
  phoneNumberId?: string | null;
  wabaId?: string | null;
  metaErrorCode?: number | null;
  message?: unknown;
  actorUserId?: string | null;
}

/** Append to whatsapp_connection_events. Redacted; never throws. */
export async function logConnectionEvent(
  input: LogConnectionEventInput
): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from('whatsapp_connection_events')
      .insert({
        account_id: input.accountId,
        event: input.event,
        status: input.status ?? null,
        phone_number_id: input.phoneNumberId ?? null,
        waba_id: input.wabaId ?? null,
        meta_error_code: input.metaErrorCode ?? null,
        message: safeMessage(input.message),
        actor_user_id: input.actorUserId ?? null,
      });
    if (error)
      console.warn('[whatsapp-connection] event not logged:', error.message);
  } catch (err) {
    console.warn('[whatsapp-connection] event not logged:', safeMessage(err));
  }
}

export async function getConnectionSummary(
  accountId: string,
  { includeTokenHint }: { includeTokenHint: boolean }
): Promise<ConnectionSummary> {
  const [{ data: row }, { data: events }] = await Promise.all([
    getWhatsAppConfigRow(accountId),
    supabaseAdmin()
      .from('whatsapp_connection_events')
      .select('id, event, status, message, meta_error_code, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);
  let hint: string | null = null;
  if (row && includeTokenHint && row.access_token) {
    try {
      hint = tokenHint(decrypt(row.access_token));
    } catch {
      hint = null;
    }
  }
  return {
    status: computeConnectionStatus(row),
    phoneNumberId: row?.phone_number_id ?? null,
    wabaId: row?.waba_id ?? null,
    businessId: row?.business_id ?? null,
    tokenHint: hint,
    hasVerifyToken: !!row?.verify_token,
    hasPin: !!row?.pin,
    registeredAt: row?.registered_at ?? null,
    subscribedAt: row?.subscribed_apps_at ?? null,
    connectedAt: row?.connected_at ?? null,
    lastCheckedAt: row?.last_checked_at ?? null,
    lastError: safeMessage(
      row?.last_check_error ?? row?.last_registration_error ?? null
    ),
    lastWebhookAt: row?.last_webhook_at ?? null,
    events: (events ?? []) as ConnectionSummary['events'],
  };
}

export interface ConnectionTestResult {
  status: ConnectionStatus;
  checks: ConnectionChecks | null;
  phone: Pick<
    MetaPhoneInfo,
    'display_phone_number' | 'verified_name' | 'quality_rating'
  > | null;
  error: string | null;
  metaErrorCode: number | null;
}

/** "Testar conexão": validate with Meta, persist the status, log it. */
export async function testConnection(
  accountId: string,
  actorUserId: string | null
): Promise<ConnectionTestResult> {
  const { data: row } = await getWhatsAppConfigRow(accountId);
  if (!row) {
    return {
      status: 'disconnected',
      checks: null,
      phone: null,
      error: null,
      metaErrorCode: null,
    };
  }

  const fail = async (
    step: string,
    err: unknown
  ): Promise<ConnectionTestResult> => {
    const explained =
      step === 'decrypt'
        ? null
        : explainMetaError(
            err,
            step as Parameters<typeof explainMetaError>[1],
            {
              phoneNumberId: row.phone_number_id,
              wabaId: row.waba_id,
            }
          );
    const error = safeMessage(
      explained?.summary ??
        'The saved token cannot be decrypted (ENCRYPTION_KEY changed?). Save the configuration again.'
    );
    await persist('error', error);
    await logConnectionEvent({
      accountId,
      event: 'tested',
      status: 'error',
      phoneNumberId: row.phone_number_id,
      wabaId: row.waba_id,
      metaErrorCode: explained?.code ?? null,
      message: error,
      actorUserId,
    });
    return {
      status: 'error',
      checks: null,
      phone: null,
      error,
      metaErrorCode: explained?.code ?? null,
    };
  };

  const persist = async (status: ConnectionStatus, error: string | null) => {
    const now = new Date().toISOString();
    await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        status,
        last_checked_at: now,
        last_check_error: error,
        ...(status === 'connected' && !row.connected_at
          ? { connected_at: now }
          : {}),
      })
      .eq('account_id', accountId);
  };

  let accessToken: string;
  try {
    accessToken = decrypt(row.access_token);
  } catch (err) {
    return fail('decrypt', err);
  }

  let phone: MetaPhoneInfo;
  try {
    phone = await verifyPhoneNumber({
      phoneNumberId: row.phone_number_id,
      accessToken,
    });
  } catch (err) {
    return fail('verify_number', err);
  }

  const checks: ConnectionChecks = {
    credentials: true,
    wabaMatch: null,
    subscribed: null,
    appIdMatch: null,
    registered: !!row.registered_at,
    webhookRecent: webhookIsRecent(row.last_webhook_at),
  };

  if (row.waba_id) {
    try {
      const numbers = await listWabaPhoneNumbers({
        wabaId: row.waba_id,
        accessToken,
      });
      checks.wabaMatch = phoneNumberBelongsToWaba(numbers, row.phone_number_id);
    } catch (err) {
      return fail('waba_phone_numbers', err);
    }
    if (checks.wabaMatch === false) {
      const error = safeMessage(
        `Phone number ${row.phone_number_id} is not listed under WABA ${row.waba_id}.`
      );
      await persist('error', error);
      await logConnectionEvent({
        accountId,
        event: 'tested',
        status: 'error',
        phoneNumberId: row.phone_number_id,
        wabaId: row.waba_id,
        message: error,
        actorUserId,
      });
      return {
        status: 'error',
        checks,
        phone: pickPhone(phone),
        error,
        metaErrorCode: null,
      };
    }
    try {
      const subs = await getSubscribedApps({
        wabaId: row.waba_id,
        accessToken,
      });
      const state = appSubscriptionState(subs, process.env.META_APP_ID);
      checks.subscribed = state.subscribed;
      checks.appIdMatch = state.appIdMatch;
    } catch {
      // A token without whatsapp_business_management can still send:
      // unknown, not an error.
      checks.subscribed = null;
    }
  }

  const status = statusFromChecks(checks);
  await persist(status, null);
  await logConnectionEvent({
    accountId,
    event: 'tested',
    status,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    message:
      status === 'pending'
        ? 'Credentials valid; the WABA is not subscribed to this app yet (no webhooks).'
        : `OK — ${phone.display_phone_number}`,
    actorUserId,
  });
  return {
    status,
    checks,
    phone: pickPhone(phone),
    error: null,
    metaErrorCode: null,
  };
}

function pickPhone(p: MetaPhoneInfo): ConnectionTestResult['phone'] {
  return {
    display_phone_number: p.display_phone_number,
    verified_name: p.verified_name,
    quality_rating: p.quality_rating,
  };
}

const WEBHOOK_TOUCH_MS = 5 * 60_000;

/**
 * Called by the inbound webhook once a delivery is matched to a tenant
 * (FORK-PATCH(P-008)): stamps last_webhook_at at most every 5 minutes,
 * and logs the first delivery after a gap. Never throws.
 */
export async function noteWebhookReceived(row: {
  account_id: string;
  phone_number_id: string;
  waba_id?: string | null;
  last_webhook_at?: string | null;
}): Promise<void> {
  try {
    const last = row.last_webhook_at
      ? new Date(row.last_webhook_at).getTime()
      : 0;
    if (Date.now() - last < WEBHOOK_TOUCH_MS) return;
    await supabaseAdmin()
      .from('whatsapp_config')
      .update({ last_webhook_at: new Date().toISOString() })
      .eq('account_id', row.account_id);
    if (!webhookIsRecent(row.last_webhook_at)) {
      await logConnectionEvent({
        accountId: row.account_id,
        event: 'webhook_received',
        status: 'connected',
        phoneNumberId: row.phone_number_id,
        wabaId: row.waba_id ?? null,
        message: 'Meta is delivering webhooks for this number.',
      });
    }
  } catch (err) {
    console.warn(
      '[whatsapp-connection] webhook stamp failed:',
      safeMessage(err)
    );
  }
}

/** Set the Meta Business ID of the account's connection. False when there is no row. */
export async function updateBusinessId(
  accountId: string,
  businessId: string | null
): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .update({ business_id: businessId, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .select('id');
  if (error) throw new Error(safeMessage(error.message) ?? 'update failed');
  return (data ?? []).length > 0;
}
