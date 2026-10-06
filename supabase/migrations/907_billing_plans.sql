-- 907_billing_plans (fork, docs/PLANS.md)
--
-- SaaS plans as data, not code:
--
--   billing_features       catalog of feature keys (max_users, ai_enabled…),
--                          kind (limit | flag) and the default value used when
--                          a plan does not set it / the account has no plan.
--   billing_plans          plans (start, pro, business…). One may be the
--                          default for new organizations.
--   billing_plan_features  value of each feature per plan (JSONB):
--                            limit → integer >= 0, or null = unlimited
--                            flag  → true | false
--   billing_subscriptions  which plan each organization is on (replaces
--                          billing_account_plans from 906). Lifecycle status
--                          stays in accounts.status (902).
--
-- Central rule (used by triggers, the server and the platform panel):
--   billing_feature_value(account, key)  plan value ?? catalog default
--   billing_usage(account, key)          current count for limit keys
--   billing_check_limit(account, key, n) {allowed, limit, used}
--
-- Enforcement in the database (backstop for every path):
--   profiles (joining an organization), account_invitations   max_users
--   whatsapp_config                                            max_whatsapp_accounts
--   automations                                                max_automations
--   api_keys                                                   api_enabled
--   contacts — only for browser (authenticated) inserts. Inbound WhatsApp
--   creates contacts with the service role and is never refused (a lost
--   customer message is worse than an overage); the public API checks in
--   the server (lib/api/v1/contacts.ts).
-- Refusals raise SQLSTATE 53400 (configuration_limit_exceeded),
-- MESSAGE 'plan_limit_exceeded', DETAIL = feature key.
--
-- Existing organizations without a subscription keep working unlimited
-- (catalog defaults are permissive) until a plan is assigned. New
-- organizations get the default plan.
--
-- Idempotent. Seeds never overwrite values edited later.

-- ------------------------------------------------------------------
-- Catalog
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.billing_features (
  key           TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  kind          TEXT NOT NULL CHECK (kind IN ('limit', 'flag')),
  default_value JSONB NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  description   TEXT CHECK (char_length(description) <= 300)
);

CREATE TABLE IF NOT EXISTS public.billing_plans (
  code        TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_-]{0,39}$'),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description TEXT CHECK (char_length(description) <= 300),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_plans_one_default ON public.billing_plans (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS public.billing_plan_features (
  plan_code   TEXT NOT NULL REFERENCES public.billing_plans(code) ON DELETE CASCADE ON UPDATE CASCADE,
  feature_key TEXT NOT NULL REFERENCES public.billing_features(key) ON DELETE CASCADE,
  value       JSONB NOT NULL,
  PRIMARY KEY (plan_code, feature_key)
);

CREATE OR REPLACE FUNCTION public.billing_valid_feature_value(p_kind TEXT, p_value JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'flag'  THEN jsonb_typeof(p_value) = 'boolean'
    WHEN 'limit' THEN jsonb_typeof(p_value) = 'null'
                   OR (jsonb_typeof(p_value) = 'number'
                       AND (p_value #>> '{}')::NUMERIC >= 0
                       AND (p_value #>> '{}')::NUMERIC = trunc((p_value #>> '{}')::NUMERIC))
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.billing_plan_features_validate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_kind TEXT;
BEGIN
  SELECT kind INTO v_kind FROM billing_features WHERE key = NEW.feature_key;
  IF NOT billing_valid_feature_value(v_kind, NEW.value) THEN
    RAISE EXCEPTION 'invalid value % for % feature %', NEW.value, v_kind, NEW.feature_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS billing_plan_features_validate ON public.billing_plan_features;
CREATE TRIGGER billing_plan_features_validate
  BEFORE INSERT OR UPDATE ON public.billing_plan_features
  FOR EACH ROW EXECUTE FUNCTION public.billing_plan_features_validate();

DO $$ BEGIN
  ALTER TABLE public.billing_features
    ADD CONSTRAINT billing_features_default_valid CHECK (billing_valid_feature_value(kind, default_value));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.billing_subscriptions (
  account_id         UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  plan_code          TEXT NOT NULL REFERENCES public.billing_plans(code) ON UPDATE CASCADE,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ,
  -- Reference in the payment gateway, when billing exists.
  external_id        TEXT CHECK (char_length(external_id) <= 200),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Platform admin or NULL (system: default plan, billing webhook).
  updated_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_plan ON public.billing_subscriptions (plan_code);

-- Access: the catalog is public to signed-in users (plan comparison,
-- no secrets); a subscription only to members of its organization.
-- Writes: service role / platform functions only.
ALTER TABLE public.billing_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_plan_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_features, public.billing_plans, public.billing_plan_features,
              public.billing_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing_features, public.billing_plans, public.billing_plan_features TO authenticated;
GRANT SELECT (account_id, plan_code, started_at, current_period_end) ON public.billing_subscriptions TO authenticated;

DROP POLICY IF EXISTS billing_features_read ON public.billing_features;
CREATE POLICY billing_features_read ON public.billing_features FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS billing_plans_read ON public.billing_plans;
CREATE POLICY billing_plans_read ON public.billing_plans FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS billing_plan_features_read ON public.billing_plan_features;
CREATE POLICY billing_plan_features_read ON public.billing_plan_features FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS billing_subscriptions_read ON public.billing_subscriptions;
CREATE POLICY billing_subscriptions_read ON public.billing_subscriptions
  FOR SELECT TO authenticated USING (is_account_member(account_id));

-- ------------------------------------------------------------------
-- Seeds (ON CONFLICT DO NOTHING: edits made later are kept)
-- ------------------------------------------------------------------

INSERT INTO public.billing_features (key, kind, default_value, sort_order, description) VALUES
  ('max_users',             'limit', 'null', 10, 'Members plus pending invitations'),
  ('max_whatsapp_accounts', 'limit', 'null', 20, 'Connected WhatsApp numbers'),
  ('max_contacts',          'limit', 'null', 30, 'Contacts'),
  ('max_automations',       'limit', 'null', 40, 'Automations (active or not)'),
  ('ai_enabled',            'flag',  'true', 50, 'AI assistant: replies, drafts, knowledge base'),
  ('api_enabled',           'flag',  'true', 60, 'Public REST API (/api/v1) and API keys')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.billing_plans (code, name, sort_order, is_default) VALUES
  ('start', 'Start', 10, true),
  ('pro', 'Pro', 20, false),
  ('business', 'Business', 30, false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.billing_plan_features (plan_code, feature_key, value) VALUES
  ('start', 'max_users', '2'), ('start', 'max_whatsapp_accounts', '1'), ('start', 'max_contacts', '2000'),
  ('start', 'max_automations', '5'), ('start', 'ai_enabled', 'false'), ('start', 'api_enabled', 'false'),
  ('pro', 'max_users', '5'), ('pro', 'max_whatsapp_accounts', '1'), ('pro', 'max_contacts', '10000'),
  ('pro', 'max_automations', '30'), ('pro', 'ai_enabled', 'true'), ('pro', 'api_enabled', 'true'),
  ('business', 'max_users', '15'), ('business', 'max_whatsapp_accounts', '3'), ('business', 'max_contacts', '50000'),
  ('business', 'max_automations', 'null'), ('business', 'ai_enabled', 'true'), ('business', 'api_enabled', 'true')
ON CONFLICT (plan_code, feature_key) DO NOTHING;

-- Plans assigned in the panel before this migration (906).
DO $$
BEGIN
  IF to_regclass('public.billing_account_plans') IS NOT NULL THEN
    INSERT INTO public.billing_subscriptions (account_id, plan_code, started_at, updated_by)
    SELECT p.account_id,
           CASE p.plan_code WHEN 'starter' THEN 'start' WHEN 'enterprise' THEN 'business' ELSE p.plan_code END,
           p.assigned_at, p.assigned_by
      FROM public.billing_account_plans p
     WHERE EXISTS (SELECT 1 FROM public.billing_plans bp
                    WHERE bp.code = CASE p.plan_code WHEN 'starter' THEN 'start'
                                                     WHEN 'enterprise' THEN 'business' ELSE p.plan_code END)
    ON CONFLICT (account_id) DO NOTHING;
    DROP TABLE public.billing_account_plans;
  END IF;
END $$;

-- ------------------------------------------------------------------
-- Central rule
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.billing_feature_value(p_account UUID, p_key TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT pf.value FROM billing_subscriptions s
       JOIN billing_plan_features pf ON pf.plan_code = s.plan_code AND pf.feature_key = p_key
      WHERE s.account_id = p_account),
    (SELECT f.default_value FROM billing_features f WHERE f.key = p_key)
  );
$$;

-- Current count behind a limit key. NULL for keys without a counter.
CREATE OR REPLACE FUNCTION public.billing_usage(p_account UUID, p_key TEXT)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE p_key
    WHEN 'max_users' THEN
      (SELECT count(*) FROM profiles WHERE account_id = p_account)
      + (SELECT count(*) FROM account_invitations
          WHERE account_id = p_account AND accepted_at IS NULL AND expires_at > now())
    WHEN 'max_contacts' THEN (SELECT count(*) FROM contacts WHERE account_id = p_account)
    WHEN 'max_whatsapp_accounts' THEN (SELECT count(*) FROM whatsapp_config WHERE account_id = p_account)
    WHEN 'max_automations' THEN (SELECT count(*) FROM automations WHERE account_id = p_account)
  END;
$$;

-- Can `p_increment` more be added? Flags: allowed = the flag.
CREATE OR REPLACE FUNCTION public.billing_check_limit(p_account UUID, p_key TEXT, p_increment INT DEFAULT 1)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_kind  TEXT;
  v_value JSONB;
  v_used  BIGINT;
BEGIN
  SELECT kind INTO v_kind FROM billing_features WHERE key = p_key;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'unknown feature %', p_key USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_value := billing_feature_value(p_account, p_key);
  IF v_kind = 'flag' THEN
    RETURN jsonb_build_object('feature', p_key, 'allowed', v_value = 'true'::jsonb);
  END IF;
  v_used := billing_usage(p_account, p_key);
  RETURN jsonb_build_object(
    'feature', p_key,
    'limit', v_value,
    'used', v_used,
    'allowed', jsonb_typeof(v_value) = 'null'
               OR COALESCE(v_used, 0) + GREATEST(p_increment, 0) <= (v_value #>> '{}')::BIGINT);
END $$;

CREATE OR REPLACE FUNCTION public.billing_assert(p_account UUID, p_key TEXT, p_increment INT DEFAULT 1)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v JSONB;
BEGIN
  IF p_account IS NULL THEN RETURN; END IF;
  v := billing_check_limit(p_account, p_key, p_increment);
  IF NOT (v->>'allowed')::BOOLEAN THEN
    RAISE EXCEPTION 'plan_limit_exceeded'
      USING ERRCODE = 'configuration_limit_exceeded',  -- 53400
            DETAIL = p_key,
            HINT = format('limit=%s used=%s', COALESCE(v->>'limit', 'n/a'), COALESCE(v->>'used', 'n/a'));
  END IF;
END $$;

-- Plan, every feature value and usage, in one call (settings, panel, API).
CREATE OR REPLACE FUNCTION public.billing_entitlements(p_account UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'plan', (SELECT jsonb_build_object('code', p.code, 'name', p.name, 'started_at', s.started_at,
                                       'current_period_end', s.current_period_end)
               FROM billing_subscriptions s JOIN billing_plans p ON p.code = s.plan_code
              WHERE s.account_id = p_account),
    'features', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key', f.key, 'kind', f.kind,
               'value', billing_feature_value(p_account, f.key),
               'used', CASE WHEN f.kind = 'limit' THEN billing_usage(p_account, f.key) END)
             ORDER BY f.sort_order, f.key)
        FROM billing_features f), '[]'::jsonb));
$$;

REVOKE EXECUTE ON FUNCTION public.billing_feature_value(UUID, TEXT), public.billing_usage(UUID, TEXT),
  public.billing_check_limit(UUID, TEXT, INT), public.billing_assert(UUID, TEXT, INT),
  public.billing_entitlements(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_feature_value(UUID, TEXT), public.billing_usage(UUID, TEXT),
  public.billing_check_limit(UUID, TEXT, INT), public.billing_assert(UUID, TEXT, INT),
  public.billing_entitlements(UUID)
  TO service_role;

-- Members may read their own organization's entitlements (settings page).
CREATE OR REPLACE FUNCTION public.billing_my_entitlements()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT billing_entitlements(p.account_id)
    FROM profiles p
   WHERE p.user_id = auth.uid() AND is_account_member(p.account_id);
$$;
REVOKE EXECUTE ON FUNCTION public.billing_my_entitlements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_my_entitlements() TO authenticated, service_role;

-- ------------------------------------------------------------------
-- Default plan for new organizations
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.billing_assign_default_plan()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO billing_subscriptions (account_id, plan_code)
  SELECT NEW.id, code FROM billing_plans WHERE is_default AND is_active
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS billing_assign_default_plan ON public.accounts;
CREATE TRIGGER billing_assign_default_plan
  AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.billing_assign_default_plan();

-- ------------------------------------------------------------------
-- Enforcement triggers
-- ------------------------------------------------------------------

-- Joining an organization (invitation redeemed, manual move).
CREATE OR REPLACE FUNCTION public.billing_enforce_members()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_limit JSONB; v_members BIGINT;
BEGIN
  IF NEW.account_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id) THEN
    RETURN NEW;
  END IF;
  v_limit := billing_feature_value(NEW.account_id, 'max_users');
  IF jsonb_typeof(v_limit) = 'number' THEN
    -- Members only: the invitation being redeemed already holds a seat.
    SELECT count(*) INTO v_members FROM profiles WHERE account_id = NEW.account_id AND id <> NEW.id;
    IF v_members + 1 > (v_limit #>> '{}')::BIGINT THEN
      RAISE EXCEPTION 'plan_limit_exceeded'
        USING ERRCODE = 'configuration_limit_exceeded', DETAIL = 'max_users',
              HINT = format('limit=%s used=%s', v_limit #>> '{}', v_members);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS billing_enforce_members ON public.profiles;
CREATE TRIGGER billing_enforce_members
  BEFORE INSERT OR UPDATE OF account_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.billing_enforce_members();

CREATE OR REPLACE FUNCTION public.billing_enforce_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- TG_ARGV[0] = feature key
  PERFORM billing_assert(NEW.account_id, TG_ARGV[0], 1);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS billing_enforce_invitations ON public.account_invitations;
CREATE TRIGGER billing_enforce_invitations
  BEFORE INSERT ON public.account_invitations
  FOR EACH ROW EXECUTE FUNCTION public.billing_enforce_row('max_users');

DROP TRIGGER IF EXISTS billing_enforce_whatsapp ON public.whatsapp_config;
CREATE TRIGGER billing_enforce_whatsapp
  BEFORE INSERT ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.billing_enforce_row('max_whatsapp_accounts');

DROP TRIGGER IF EXISTS billing_enforce_automations ON public.automations;
CREATE TRIGGER billing_enforce_automations
  BEFORE INSERT ON public.automations
  FOR EACH ROW EXECUTE FUNCTION public.billing_enforce_row('max_automations');

DROP TRIGGER IF EXISTS billing_enforce_api_keys ON public.api_keys;
CREATE TRIGGER billing_enforce_api_keys
  BEFORE INSERT ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.billing_enforce_row('api_enabled');

-- Contacts: browser inserts only (see header). Statement level, so a CSV
-- import chunk costs one count, and the whole chunk is refused when it
-- would cross the limit.
CREATE OR REPLACE FUNCTION public.billing_enforce_contacts()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_limit JSONB; v_used BIGINT;
BEGIN
  -- The role the request runs as (PostgREST: SET ROLE). DEFINER does not
  -- change this setting, only current_user.
  IF current_setting('role', true) IS DISTINCT FROM 'authenticated' THEN
    RETURN NULL;
  END IF;
  FOR r IN SELECT DISTINCT account_id FROM new_contacts WHERE account_id IS NOT NULL LOOP
    v_limit := billing_feature_value(r.account_id, 'max_contacts');
    IF jsonb_typeof(v_limit) = 'number' THEN
      v_used := billing_usage(r.account_id, 'max_contacts');  -- includes the new rows
      IF v_used > (v_limit #>> '{}')::BIGINT THEN
        RAISE EXCEPTION 'plan_limit_exceeded'
          USING ERRCODE = 'configuration_limit_exceeded', DETAIL = 'max_contacts',
                HINT = format('limit=%s used=%s', v_limit #>> '{}',
                              v_used - (SELECT count(*) FROM new_contacts WHERE account_id = r.account_id));
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS billing_enforce_contacts ON public.contacts;
CREATE TRIGGER billing_enforce_contacts
  AFTER INSERT ON public.contacts
  REFERENCING NEW TABLE AS new_contacts
  FOR EACH STATEMENT EXECUTE FUNCTION public.billing_enforce_contacts();

-- ------------------------------------------------------------------
-- Platform panel (906) now reads/writes subscriptions
-- ------------------------------------------------------------------

ALTER TABLE public.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_action_check;
ALTER TABLE public.platform_audit_log ADD CONSTRAINT platform_audit_log_action_check CHECK (action IN (
  'organization.viewed', 'organization.suspended', 'organization.reactivated',
  'organization.plan_changed', 'platform_admin.granted', 'platform_admin.revoked',
  'billing_plan.updated'
));

CREATE OR REPLACE FUNCTION public.platform_set_plan(
  p_account UUID, p_plan TEXT, p_actor UUID, p_reason TEXT,
  p_ip TEXT DEFAULT NULL, p_user_agent TEXT DEFAULT NULL
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_from TEXT;
BEGIN
  IF NOT platform_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not a platform admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_plan IS NOT NULL AND NOT EXISTS (SELECT 1 FROM billing_plans WHERE code = p_plan AND is_active) THEN
    RAISE EXCEPTION 'unknown or inactive plan %', p_plan USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT plan_code INTO v_from FROM billing_subscriptions WHERE account_id = p_account;
  IF v_from IS NOT DISTINCT FROM p_plan THEN
    RETURN p_plan;
  END IF;
  IF p_plan IS NULL THEN
    DELETE FROM billing_subscriptions WHERE account_id = p_account;
  ELSE
    INSERT INTO billing_subscriptions (account_id, plan_code, updated_by)
    VALUES (p_account, p_plan, p_actor)
    ON CONFLICT (account_id) DO UPDATE
      SET plan_code = EXCLUDED.plan_code, started_at = now(), updated_at = now(), updated_by = EXCLUDED.updated_by;
  END IF;
  PERFORM _platform_audit(p_actor, 'organization.plan_changed', p_account, p_reason,
    jsonb_build_object('from', v_from, 'to', p_plan), p_ip, p_user_agent);
  RETURN p_plan;
END $$;

-- Edit a plan (name, active, default, feature values). Audited.
CREATE OR REPLACE FUNCTION public.platform_update_plan(
  p_plan TEXT, p_name TEXT, p_is_active BOOLEAN, p_is_default BOOLEAN, p_features JSONB,
  p_actor UUID, p_reason TEXT, p_ip TEXT DEFAULT NULL, p_user_agent TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before JSONB;
  v_after  JSONB;
  k TEXT; v JSONB;
BEGIN
  IF NOT platform_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not a platform admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT jsonb_build_object('name', p.name, 'is_active', p.is_active, 'is_default', p.is_default,
           'features', COALESCE((SELECT jsonb_object_agg(feature_key, value) FROM billing_plan_features
                                  WHERE plan_code = p.code), '{}'))
    INTO v_before FROM billing_plans p WHERE p.code = p_plan FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'plan not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF COALESCE(p_is_default, false) AND NOT COALESCE(p_is_active, true) THEN
    RAISE EXCEPTION 'the default plan must be active' USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(p_is_default, false) THEN
    UPDATE billing_plans SET is_default = false, updated_at = now() WHERE is_default AND code <> p_plan;
  END IF;
  UPDATE billing_plans
     SET name = COALESCE(NULLIF(btrim(p_name), ''), name),
         is_active = COALESCE(p_is_active, is_active),
         is_default = COALESCE(p_is_default, is_default),
         updated_at = now()
   WHERE code = p_plan;

  FOR k, v IN SELECT * FROM jsonb_each(COALESCE(p_features, '{}'::jsonb)) LOOP
    IF NOT EXISTS (SELECT 1 FROM billing_features WHERE key = k) THEN
      RAISE EXCEPTION 'unknown feature %', k USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO billing_plan_features (plan_code, feature_key, value) VALUES (p_plan, k, v)
    ON CONFLICT (plan_code, feature_key) DO UPDATE SET value = EXCLUDED.value;
  END LOOP;

  SELECT jsonb_build_object('name', p.name, 'is_active', p.is_active, 'is_default', p.is_default,
           'features', COALESCE((SELECT jsonb_object_agg(feature_key, value) FROM billing_plan_features
                                  WHERE plan_code = p.code), '{}'))
    INTO v_after FROM billing_plans p WHERE p.code = p_plan;
  IF v_after IS DISTINCT FROM v_before THEN
    PERFORM _platform_audit(p_actor, 'billing_plan.updated', NULL, p_reason,
      jsonb_build_object('plan', p_plan, 'from', v_before, 'to', v_after), p_ip, p_user_agent);
  END IF;
END $$;

-- Plans with features and how many organizations use each (panel).
CREATE OR REPLACE FUNCTION public.platform_list_plans()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'features', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'kind', kind,
                            'default_value', default_value, 'description', description)
                          ORDER BY sort_order, key) FROM billing_features), '[]'),
    'plans', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'code', p.code, 'name', p.name, 'is_active', p.is_active, 'is_default', p.is_default,
               'organizations', (SELECT count(*) FROM billing_subscriptions s WHERE s.plan_code = p.code),
               'features', COALESCE((SELECT jsonb_object_agg(feature_key, value) FROM billing_plan_features
                                      WHERE plan_code = p.code), '{}'))
             ORDER BY p.sort_order, p.code) FROM billing_plans p), '[]'));
$$;

-- List / detail: same as 906, reading the plan from billing_subscriptions.
CREATE OR REPLACE FUNCTION public.platform_list_organizations(
  p_search TEXT DEFAULT NULL, p_status TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25, p_offset INT DEFAULT 0
) RETURNS TABLE (
  id UUID, name TEXT, status TEXT, status_changed_at TIMESTAMPTZ, trial_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ, legal_name TEXT, trade_name TEXT, tax_id TEXT, owner_email TEXT,
  plan_code TEXT, phone_number_id TEXT, waba_id TEXT, whatsapp_status TEXT,
  users_count BIGINT, contacts_count BIGINT, messages_30d BIGINT,
  integration_errors BIGINT, total_count BIGINT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH q AS (
    SELECT NULLIF(btrim(p_search), '') AS raw,
           replace(replace(replace(NULLIF(btrim(p_search), ''), '\', '\\'), '%', '\%'), '_', '\_') AS esc,
           NULLIF(regexp_replace(COALESCE(p_search, ''), '[^0-9A-Za-z]', '', 'g'), '') AS compact
  ),
  base AS (
    SELECT a.id, a.name, a.status, a.status_changed_at, a.trial_ends_at, a.created_at,
           bp.legal_name, bp.trade_name, bp.tax_id, u.email::TEXT AS owner_email,
           s.plan_code, w.phone_number_id, w.waba_id, w.status AS whatsapp_status
      FROM accounts a
      CROSS JOIN q
      LEFT JOIN br_account_profiles bp ON bp.account_id = a.id
      LEFT JOIN auth.users u ON u.id = a.owner_user_id
      LEFT JOIN billing_subscriptions s ON s.account_id = a.id
      LEFT JOIN whatsapp_config w ON w.account_id = a.id
     WHERE (p_status IS NULL OR a.status = p_status)
       AND (q.raw IS NULL
            OR a.name ILIKE '%' || q.esc || '%'
            OR bp.legal_name ILIKE '%' || q.esc || '%'
            OR bp.trade_name ILIKE '%' || q.esc || '%'
            OR u.email ILIKE '%' || q.esc || '%'
            OR a.id::TEXT = lower(q.raw)
            OR (length(q.compact) >= 4 AND upper(bp.tax_id) LIKE upper(q.compact) || '%')
            OR w.phone_number_id = q.raw OR w.waba_id = q.raw OR w.business_id = q.raw)
  ),
  page AS (
    SELECT b.*, count(*) OVER () AS total_count
      FROM base b
     ORDER BY b.created_at DESC, b.id
     LIMIT LEAST(GREATEST(p_limit, 1), 100) OFFSET GREATEST(p_offset, 0)
  )
  SELECT p.id, p.name, p.status, p.status_changed_at, p.trial_ends_at, p.created_at,
         p.legal_name, p.trade_name, p.tax_id, p.owner_email, p.plan_code,
         p.phone_number_id, p.waba_id, p.whatsapp_status,
         (SELECT count(*) FROM profiles pr WHERE pr.account_id = p.id),
         (SELECT count(*) FROM contacts c WHERE c.account_id = p.id),
         (SELECT count(*) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
           WHERE cv.account_id = p.id AND m.created_at > now() - interval '30 days'),
         (SELECT count(*) FROM whatsapp_connection_events e
           WHERE e.account_id = p.id AND e.status = 'error' AND e.created_at > now() - interval '7 days')
         + (SELECT count(*) FROM whatsapp_config w2
             WHERE w2.account_id = p.id
               AND (w2.status = 'error' OR w2.last_check_error IS NOT NULL OR w2.last_registration_error IS NOT NULL)),
         p.total_count
    FROM page p
   ORDER BY p.created_at DESC, p.id;
$$;

-- Detail: 906's document, with `plan` from subscriptions and the
-- organization's entitlements (limits + usage).
CREATE OR REPLACE FUNCTION public.platform_get_organization(p_account UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'account', (
      SELECT jsonb_build_object(
        'id', a.id, 'name', a.name, 'status', a.status, 'status_changed_at', a.status_changed_at,
        'trial_ends_at', a.trial_ends_at, 'created_at', a.created_at, 'locale', a.locale,
        'timezone', a.timezone, 'default_currency', a.default_currency,
        'owner_email', (SELECT u.email FROM auth.users u WHERE u.id = a.owner_user_id))
      FROM accounts a WHERE a.id = p_account),
    'profile', (
      SELECT jsonb_build_object(
        'person_type', bp.person_type, 'tax_id', bp.tax_id, 'legal_name', bp.legal_name,
        'trade_name', bp.trade_name, 'email', bp.email, 'phone', bp.phone,
        'city', bp.city, 'state', bp.state)
      FROM br_account_profiles bp WHERE bp.account_id = p_account),
    'plan', (
      SELECT jsonb_build_object('plan_code', s.plan_code, 'assigned_at', s.started_at)
      FROM billing_subscriptions s WHERE s.account_id = p_account),
    'entitlements', billing_entitlements(p_account),
    'members', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'email', pr.email, 'full_name', pr.full_name, 'role', pr.account_role,
               'created_at', pr.created_at) ORDER BY pr.created_at)
      FROM profiles pr WHERE pr.account_id = p_account), '[]'::jsonb),
    'wabas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'phone_number_id', w.phone_number_id, 'waba_id', w.waba_id,
               'business_id', w.business_id, 'status', w.status,
               'connected_at', w.connected_at, 'registered_at', w.registered_at,
               'subscribed_apps_at', w.subscribed_apps_at,
               'last_checked_at', w.last_checked_at, 'last_webhook_at', w.last_webhook_at,
               'has_access_token', w.has_access_token, 'has_verify_token', w.has_verify_token,
               'has_pin', w.has_pin))
      FROM whatsapp_config w WHERE w.account_id = p_account), '[]'::jsonb),
    'usage', jsonb_build_object(
      'users', (SELECT count(*) FROM profiles WHERE account_id = p_account),
      'contacts', (SELECT count(*) FROM contacts WHERE account_id = p_account),
      'conversations', (SELECT count(*) FROM conversations WHERE account_id = p_account),
      'messages_in_30d', (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                           WHERE c.account_id = p_account AND m.sender_type = 'customer'
                             AND m.created_at > now() - interval '30 days'),
      'messages_out_30d', (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                            WHERE c.account_id = p_account AND m.sender_type <> 'customer'
                              AND m.created_at > now() - interval '30 days'),
      'messages_failed_30d', (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                               WHERE c.account_id = p_account AND m.status = 'failed'
                                 AND m.created_at > now() - interval '30 days'),
      'last_message_at', (SELECT max(c.last_message_at) FROM conversations c WHERE c.account_id = p_account),
      'broadcasts_30d', (SELECT count(*) FROM broadcasts WHERE account_id = p_account
                          AND created_at > now() - interval '30 days'),
      'ai_tokens_30d', (SELECT COALESCE(sum(total_tokens), 0) FROM ai_usage_log
                         WHERE account_id = p_account AND created_at > now() - interval '30 days'),
      'automations_active', (SELECT count(*) FROM automations WHERE account_id = p_account AND is_active),
      'api_keys_active', (SELECT count(*) FROM api_keys WHERE account_id = p_account
                           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))),
    'errors', jsonb_build_object(
      'whatsapp', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object('source', 'check', 'message', w.last_check_error, 'at', w.last_checked_at) AS x
            FROM whatsapp_config w WHERE w.account_id = p_account AND w.last_check_error IS NOT NULL
          UNION ALL
          SELECT jsonb_build_object('source', 'registration', 'message', w.last_registration_error, 'at', w.updated_at)
            FROM whatsapp_config w WHERE w.account_id = p_account AND w.last_registration_error IS NOT NULL
        ) s), '[]'::jsonb),
      'events', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'event', e.event, 'status', e.status, 'message', e.message,
                 'meta_error_code', e.meta_error_code, 'at', e.created_at) ORDER BY e.created_at DESC)
          FROM (SELECT * FROM whatsapp_connection_events
                 WHERE account_id = p_account
                   AND (status = 'error' OR event IN ('webhook_rejected', 'registration_failed', 'save_failed'))
                 ORDER BY created_at DESC LIMIT 20) e), '[]'::jsonb),
      'failed_messages', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('code', f.error_code, 'title', f.error_title,
                                            'count', f.n, 'last_at', f.last_at) ORDER BY f.n DESC)
          FROM (SELECT m.error_code, m.error_title, count(*) AS n, max(m.created_at) AS last_at
                  FROM messages m JOIN conversations c ON c.id = m.conversation_id
                 WHERE c.account_id = p_account AND m.status = 'failed'
                   AND m.created_at > now() - interval '30 days'
                 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10) f), '[]'::jsonb),
      -- Só o host: a URL pode carregar token em query string.
      'webhooks', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'host', substring(we.url FROM '^[a-z]+://([^/?#:@]+)'),
                 'failure_count', we.failure_count, 'is_active', we.is_active,
                 'last_delivery_at', we.last_delivery_at))
          FROM webhook_endpoints we WHERE we.account_id = p_account AND we.failure_count > 0), '[]'::jsonb),
      'automations', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('status', al.status, 'message', left(al.error_message, 300),
                                            'at', al.created_at) ORDER BY al.created_at DESC)
          FROM (SELECT * FROM automation_logs WHERE account_id = p_account AND status = 'failed'
                 ORDER BY created_at DESC LIMIT 10) al), '[]'::jsonb)
    )
  )
  WHERE EXISTS (SELECT 1 FROM accounts WHERE id = p_account);
$$;

REVOKE EXECUTE ON FUNCTION public.platform_update_plan(TEXT, TEXT, BOOLEAN, BOOLEAN, JSONB, UUID, TEXT, TEXT, TEXT),
  public.platform_list_plans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_update_plan(TEXT, TEXT, BOOLEAN, BOOLEAN, JSONB, UUID, TEXT, TEXT, TEXT),
  public.platform_list_plans() TO service_role;
