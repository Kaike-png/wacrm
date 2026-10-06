/**
 * Column lists of `whatsapp_config` (migration 905). Pure: usable from
 * the browser (public columns) and the server.
 */

/** Columns a browser may select (mirrors the GRANT in migration 905). */
export const WHATSAPP_CONFIG_PUBLIC_COLUMNS = [
  'id',
  'user_id',
  'account_id',
  'phone_number_id',
  'waba_id',
  'business_id',
  'status',
  'connected_at',
  'created_at',
  'updated_at',
  'registered_at',
  'subscribed_apps_at',
  'last_registration_error',
  'mirror_inbound_media',
  'last_checked_at',
  'last_check_error',
  'last_webhook_at',
  'has_access_token',
  'has_verify_token',
  'has_pin',
].join(', ');

/** The secrets: server-only, encrypted at rest. */
export const WHATSAPP_SECRET_COLUMNS = [
  'access_token',
  'verify_token',
  'pin',
] as const;
