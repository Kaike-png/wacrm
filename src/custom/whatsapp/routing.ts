/**
 * Meta webhook → tenant routing (fork, docs/WHATSAPP_SAAS.md,
 * docs/MVP_FOUNDATION_AUDIT.md F-19/F-20). Server only.
 *
 * Every `messages` change from Meta (inbound messages AND delivery
 * statuses) is attributed to exactly one organization, or dropped:
 *
 *   1. `value.metadata.phone_number_id` → the ONE whatsapp_config row
 *      with that number (unique since 013). None / several → drop.
 *   2. `entry.id` (the WABA that sent the delivery) is mandatory.
 *   3. The saved `waba_id` must equal it. A config saved without a WABA
 *      is NOT a free pass: the delivery's WABA is confirmed with Meta
 *      using that tenant's own token (the number must be listed under
 *      it), then pinned on the config (`waba_id`, unique). Afterwards the
 *      fast path (step 3) applies. Confirmation failing, or the WABA
 *      already pinned by another organization, → drop.
 *
 * There is no fallback: when the tenant cannot be determined with
 * certainty the delivery is ignored, with a technical log line (ids
 * only, never tokens) and, when the number's owner is known, an entry
 * in that organization's connection log.
 *
 * Status updates are then applied only to rows of the routed
 * organization (`tenantMessageRows`, `tenantBroadcastRecipient`): a
 * matching wamid in another organization is never touched.
 */
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { listWabaPhoneNumbers } from '@/lib/whatsapp/meta-api';
import { phoneNumberBelongsToWaba } from '@/lib/whatsapp/waba-pairing';

import { logConnectionEvent } from './connection';
import { safeMessage } from './redact';

if (typeof window !== 'undefined') {
  throw new Error('custom/whatsapp/routing is server-only');
}

/** Columns the webhook needs (`*`: the route reads the encrypted token). */
export interface RoutedConfig {
  account_id: string;
  user_id: string;
  phone_number_id: string;
  waba_id?: string | null;
  access_token: string;
  mirror_inbound_media?: boolean | null;
  last_webhook_at?: string | null;
  [column: string]: unknown;
}

export type RoutingFailure =
  | 'missing_phone_number_id'
  | 'missing_delivery_waba'
  | 'lookup_failed'
  | 'unknown_number'
  | 'ambiguous_number'
  | 'waba_mismatch'
  | 'waba_unverified'
  | 'waba_taken';

export type RoutingResult =
  | { ok: true; config: RoutedConfig; pinned: boolean }
  | { ok: false; reason: RoutingFailure; accountId: string | null };

/** Pure decision for a config already found by its number. */
export function wabaDecision(
  savedWaba: string | null | undefined,
  deliveryWaba: string | null | undefined
): 'match' | 'mismatch' | 'unpinned' | 'missing_delivery' {
  if (!deliveryWaba) return 'missing_delivery';
  if (!savedWaba) return 'unpinned';
  return savedWaba === deliveryWaba ? 'match' : 'mismatch';
}

export interface RoutingDeps {
  /** Rows of whatsapp_config with this phone_number_id (service role). */
  findConfigs(
    phoneNumberId: string
  ): Promise<{ data: RoutedConfig[] | null; error: unknown }>;
  /** Does Meta list `phoneNumberId` under `wabaId`, for this tenant's token? */
  numberIsUnderWaba(config: RoutedConfig, wabaId: string): Promise<boolean>;
  /** Pin the confirmed WABA on the config. False = refused (unique: another org has it). */
  pinWaba(config: RoutedConfig, wabaId: string): Promise<boolean>;
}

const defaultDeps: RoutingDeps = {
  async findConfigs(phoneNumberId) {
    const { data, error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('*')
      .eq('phone_number_id', phoneNumberId);
    return { data: (data as RoutedConfig[] | null) ?? null, error };
  },
  async numberIsUnderWaba(config, wabaId) {
    const numbers = await listWabaPhoneNumbers({
      wabaId,
      accessToken: decrypt(config.access_token),
    });
    return phoneNumberBelongsToWaba(numbers, config.phone_number_id);
  },
  async pinWaba(config, wabaId) {
    const { error } = await supabaseAdmin()
      .from('whatsapp_config')
      .update({ waba_id: wabaId })
      .eq('account_id', config.account_id)
      .eq('phone_number_id', config.phone_number_id)
      .is('waba_id', null);
    return !error;
  },
};

// Failed confirmations are remembered for a while, so a stream of
// deliveries that cannot be attributed does not turn into a stream of
// Graph API calls with the tenant's token.
const NEGATIVE_TTL_MS = 10 * 60_000;
const g = globalThis as { __forkWabaNegative?: Map<string, number> };
const negative = (g.__forkWabaNegative ??= new Map<string, number>());

export function forgetWabaConfirmations(): void {
  negative.clear();
}

/** Decide which organization a Meta delivery belongs to. Never guesses. */
export async function resolveDeliveryTenant(
  phoneNumberId: string | null | undefined,
  deliveryWaba: string | null | undefined,
  deps: RoutingDeps = defaultDeps
): Promise<RoutingResult> {
  if (!phoneNumberId)
    return { ok: false, reason: 'missing_phone_number_id', accountId: null };

  const { data, error } = await deps.findConfigs(phoneNumberId);
  if (error) return { ok: false, reason: 'lookup_failed', accountId: null };
  if (!data || data.length === 0)
    return { ok: false, reason: 'unknown_number', accountId: null };
  if (data.length > 1)
    return { ok: false, reason: 'ambiguous_number', accountId: null };
  const config = data[0];
  const accountId = config.account_id;

  switch (wabaDecision(config.waba_id, deliveryWaba)) {
    case 'match':
      return { ok: true, config, pinned: false };
    case 'missing_delivery':
      return { ok: false, reason: 'missing_delivery_waba', accountId };
    case 'mismatch':
      return { ok: false, reason: 'waba_mismatch', accountId };
    case 'unpinned':
      break;
  }

  const waba = deliveryWaba as string;
  const key = `${phoneNumberId}:${waba}`;
  const until = negative.get(key);
  if (until && until > Date.now())
    return { ok: false, reason: 'waba_unverified', accountId };

  let confirmed = false;
  try {
    confirmed = await deps.numberIsUnderWaba(config, waba);
  } catch (err) {
    console.warn(
      '[webhook] could not confirm the delivery WABA with Meta:',
      safeMessage(err)
    );
    confirmed = false;
  }
  if (!confirmed) {
    negative.set(key, Date.now() + NEGATIVE_TTL_MS);
    return { ok: false, reason: 'waba_unverified', accountId };
  }
  if (!(await deps.pinWaba(config, waba))) {
    negative.set(key, Date.now() + NEGATIVE_TTL_MS);
    return { ok: false, reason: 'waba_taken', accountId };
  }
  negative.delete(key);
  return { ok: true, config: { ...config, waba_id: waba }, pinned: true };
}

const REASON_TEXT: Record<RoutingFailure, string> = {
  missing_phone_number_id: 'Delivery without phone_number_id.',
  missing_delivery_waba: 'Delivery without the WABA id (entry.id).',
  lookup_failed: 'Could not look up the number.',
  unknown_number: 'No organization has this number.',
  ambiguous_number: 'More than one organization has this number.',
  waba_mismatch:
    'Delivery from a WABA other than the one saved for this number.',
  waba_unverified:
    'This number has no WABA saved and Meta did not confirm the delivery WABA owns it.',
  waba_taken: 'The delivery WABA is already linked to another organization.',
};

/**
 * Route one webhook change (statuses and/or messages) for the inbound
 * route. Returns the tenant's config, or null after logging why the
 * delivery was ignored. Never throws.
 */
export async function routeWebhookDelivery(
  phoneNumberId: string | null | undefined,
  deliveryWaba: string | null | undefined
): Promise<RoutedConfig | null> {
  let result: RoutingResult;
  try {
    result = await resolveDeliveryTenant(phoneNumberId, deliveryWaba);
  } catch (err) {
    console.error('[webhook] routing failed:', safeMessage(err));
    return null;
  }
  if (result.ok) {
    if (result.pinned) {
      console.info(
        `[webhook] WABA ${deliveryWaba} confirmed with Meta and saved for phone_number_id ${phoneNumberId}`
      );
      void logConnectionEvent({
        accountId: result.config.account_id,
        event: 'webhook_received',
        status: 'connected',
        phoneNumberId: phoneNumberId ?? null,
        wabaId: deliveryWaba ?? null,
        message: `WABA ${deliveryWaba} confirmed with Meta and saved for this number.`,
      });
    }
    return result.config;
  }
  console.warn(
    `[webhook] delivery ignored: reason=${result.reason} phone_number_id=${phoneNumberId ?? '-'} waba=${deliveryWaba ?? '-'}`
  );
  if (result.accountId) {
    void logConnectionEvent({
      accountId: result.accountId,
      event: 'webhook_rejected',
      status: 'error',
      phoneNumberId: phoneNumberId ?? null,
      wabaId: deliveryWaba ?? null,
      message: REASON_TEXT[result.reason],
    });
  }
  return null;
}

/**
 * The organization's `messages` rows carrying this Meta message id.
 * Meta ids may repeat across numbers, and a member can write any
 * message_id through RLS, so the lookup is always scoped by account.
 */
export async function tenantMessageRows(
  accountId: string,
  wamid: string
): Promise<{ id: string; conversation_id: string }[]> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id, conversation_id, conversations!inner(account_id)')
    .eq('message_id', wamid)
    .eq('conversations.account_id', accountId);
  if (error) {
    console.error('[webhook] status lookup failed:', safeMessage(error));
    return [];
  }
  return ((data ?? []) as { id: string; conversation_id: string }[]).map(
    (r) => ({ id: r.id, conversation_id: r.conversation_id })
  );
}

/** The organization's broadcast recipient for this Meta message id, if any. */
export async function tenantBroadcastRecipient(
  accountId: string,
  wamid: string
): Promise<{ data: { id: string; status: string } | null; error: unknown }> {
  const { data, error } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status, broadcasts!inner(account_id)')
    .eq('whatsapp_message_id', wamid)
    .eq('broadcasts.account_id', accountId)
    .maybeSingle();
  const row = data as { id: string; status: string } | null;
  return { data: row ? { id: row.id, status: row.status } : null, error };
}
