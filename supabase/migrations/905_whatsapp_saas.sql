-- 905_whatsapp_saas (fork, docs/WHATSAPP_SAAS.md)
--
-- WhatsApp connection of each tenant, hardened for a shared (SaaS) deploy.
-- `whatsapp_config` (upstream) already holds one row per account, with the
-- access token and verify token encrypted (AES-256-GCM, ENCRYPTION_KEY) and
-- a globally UNIQUE phone_number_id. Gaps fixed here:
--
--  1. Secrets readable by the browser. RLS let every member SELECT the
--     row, ciphertexts included (`select('*')` from the settings screen).
--     Column privileges now keep access_token, verify_token and pin
--     server-only: `anon`/`authenticated` can neither read nor write them.
--     The app reads/writes them with the service role after resolving the
--     caller's account (src/integrations/whatsapp/config-store.ts). The
--     `has_*` generated columns tell the UI whether a secret exists.
--  2. Missing per-tenant data: Meta Business ID, the two-step PIN
--     (encrypted, needed to re-register a number), connection health
--     (last check, last error, last webhook) and a richer status:
--     connected | pending | error | disconnected.
--  3. A WABA could be attached to two tenants, making WABA-routed events
--     (template status) ambiguous: waba_id is now unique when set.
--  4. Connection log without secrets: whatsapp_connection_events.
--
-- Idempotent.

-- ------------------------------------------------------------
-- 1. New columns
-- ------------------------------------------------------------

ALTER TABLE public.whatsapp_config ADD COLUMN IF NOT EXISTS business_id TEXT;
ALTER TABLE public.whatsapp_config ADD COLUMN IF NOT EXISTS pin TEXT;          -- encrypted
ALTER TABLE public.whatsapp_config ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE public.whatsapp_config ADD COLUMN IF NOT EXISTS last_check_error TEXT;  -- sanitized
ALTER TABLE public.whatsapp_config ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS has_access_token BOOLEAN
  GENERATED ALWAYS AS (access_token IS NOT NULL AND access_token <> '') STORED;
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS has_verify_token BOOLEAN
  GENERATED ALWAYS AS (verify_token IS NOT NULL AND verify_token <> '') STORED;
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS has_pin BOOLEAN
  GENERATED ALWAYS AS (pin IS NOT NULL AND pin <> '') STORED;

ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_business_id_numeric;
ALTER TABLE public.whatsapp_config ADD CONSTRAINT whatsapp_config_business_id_numeric
  CHECK (business_id IS NULL OR business_id ~ '^[0-9]{5,25}$');

ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;
ALTER TABLE public.whatsapp_config ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('connected', 'pending', 'error', 'disconnected'));

COMMENT ON COLUMN public.whatsapp_config.business_id IS 'Fork (905): Meta Business (portfolio) ID that owns the WABA.';
COMMENT ON COLUMN public.whatsapp_config.pin IS 'Fork (905): two-step verification PIN, encrypted like access_token. Server-only.';
COMMENT ON COLUMN public.whatsapp_config.last_check_error IS 'Fork (905): last connection-test error, secrets redacted.';

-- ------------------------------------------------------------
-- 2. One WABA → one tenant
-- ------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT waba_id FROM public.whatsapp_config
    WHERE waba_id IS NOT NULL GROUP BY waba_id HAVING count(*) > 1
  ) THEN
    RAISE WARNING '905: some waba_id is shared by several accounts; unique index NOT created. Resolve with: SELECT waba_id, array_agg(account_id) FROM whatsapp_config GROUP BY 1 HAVING count(*) > 1';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_waba_id_unique
      ON public.whatsapp_config (waba_id) WHERE waba_id IS NOT NULL;
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 3. Secrets are server-only (column privileges)
-- ------------------------------------------------------------
-- Table-level privileges are replaced by column lists for the client
-- roles. RLS still applies on top (members read, admins write — 017).

REVOKE SELECT, INSERT, UPDATE, REFERENCES, TRIGGER, TRUNCATE ON public.whatsapp_config FROM anon, authenticated;
REVOKE ALL ON public.whatsapp_config FROM anon;

GRANT SELECT (
  id, user_id, account_id, phone_number_id, waba_id, business_id, status,
  connected_at, created_at, updated_at, registered_at, subscribed_apps_at,
  last_registration_error, mirror_inbound_media, last_checked_at,
  last_check_error, last_webhook_at, has_access_token, has_verify_token, has_pin
) ON public.whatsapp_config TO authenticated;

-- Only harmless preferences are writable from the browser; credentials
-- go through POST /api/whatsapp/config (validated with Meta).
GRANT UPDATE (mirror_inbound_media, updated_at) ON public.whatsapp_config TO authenticated;

-- DELETE (disconnect) stays as upstream: admins, through RLS.

-- ------------------------------------------------------------
-- 4. Connection log (no secrets)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.whatsapp_connection_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event            TEXT NOT NULL,
  status           TEXT,
  phone_number_id  TEXT,
  waba_id          TEXT,
  meta_error_code  INTEGER,
  message          TEXT,
  actor_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_connection_events DROP CONSTRAINT IF EXISTS whatsapp_connection_events_event;
ALTER TABLE public.whatsapp_connection_events ADD CONSTRAINT whatsapp_connection_events_event
  CHECK (event IN ('saved', 'save_failed', 'tested', 'registered', 'registration_failed',
                   'disconnected', 'webhook_received', 'webhook_rejected'));
ALTER TABLE public.whatsapp_connection_events DROP CONSTRAINT IF EXISTS whatsapp_connection_events_status;
ALTER TABLE public.whatsapp_connection_events ADD CONSTRAINT whatsapp_connection_events_status
  CHECK (status IS NULL OR status IN ('connected', 'pending', 'error', 'disconnected'));
ALTER TABLE public.whatsapp_connection_events DROP CONSTRAINT IF EXISTS whatsapp_connection_events_message_len;
ALTER TABLE public.whatsapp_connection_events ADD CONSTRAINT whatsapp_connection_events_message_len
  CHECK (message IS NULL OR length(message) <= 500);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connection_events_account
  ON public.whatsapp_connection_events (account_id, created_at DESC);

COMMENT ON TABLE public.whatsapp_connection_events IS
  'Fork (905): WhatsApp connection history per tenant. Never holds tokens, verify tokens or PINs (redacted server-side).';

ALTER TABLE public.whatsapp_connection_events ENABLE ROW LEVEL SECURITY;

-- Members read their own history; only the server (service role) writes.
DROP POLICY IF EXISTS whatsapp_connection_events_select ON public.whatsapp_connection_events;
CREATE POLICY whatsapp_connection_events_select ON public.whatsapp_connection_events
  FOR SELECT USING (public.is_account_member(account_id));

REVOKE ALL ON public.whatsapp_connection_events FROM anon, authenticated;
GRANT SELECT ON public.whatsapp_connection_events TO authenticated;

DROP TRIGGER IF EXISTS tenant_enforce_refs ON public.whatsapp_connection_events;
CREATE TRIGGER tenant_enforce_refs
  BEFORE INSERT OR UPDATE ON public.whatsapp_connection_events
  FOR EACH ROW EXECUTE FUNCTION public.tenant_enforce_refs('account_id', 'actor_user_id=user?');
