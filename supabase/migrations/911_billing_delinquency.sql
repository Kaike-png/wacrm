-- 911_billing_delinquency (fork, docs/DELINQUENCY.md)
--
-- Delinquency policy. ONE matrix decides what each organization status
-- blocks; the database enforces it on every write path (browser, service
-- role, public API, crons) and the app mirrors it in
-- src/billing/access-policy.ts (policy-sync.test.ts keeps both equal).
--
--   status      blocks                                         data
--   trial       —                                              read/write
--   active      —                                              read/write
--   past_due    — (warning + payment)                          read/write
--   suspended   messages.send, campaigns.send,                 read/write,
--               automations.run, integrations.create           export, billing
--   cancelled   same as suspended                              same
--
-- Nothing is ever deleted. Changes 906: is_account_member no longer looks
-- at the status — suspended members keep login, data, export and billing;
-- what they lose is enforced by the guards below, not by hiding data.
--
-- past_due → suspended happens after a grace period
-- (billing_enforce_delinquency, from GET /api/billing/cron). Paying lifts a
-- billing suspension; a suspension by the platform team is only lifted by
-- the team. Idempotent.

-- ------------------------------------------------------------------
-- The matrix
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.account_status_blocks(p_status TEXT, p_action TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_action = ANY (CASE p_status
    WHEN 'suspended' THEN ARRAY['messages.send', 'campaigns.send', 'automations.run', 'integrations.create']
    WHEN 'cancelled' THEN ARRAY['messages.send', 'campaigns.send', 'automations.run', 'integrations.create']
    ELSE ARRAY[]::TEXT[]
  END);
$$;

CREATE OR REPLACE FUNCTION public.account_can(p_account UUID, p_action TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT COALESCE((SELECT account_status_blocks(a.status, p_action) FROM accounts a WHERE a.id = p_account), false);
$$;
REVOKE EXECUTE ON FUNCTION public.account_can(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.account_can(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.account_can(UUID, TEXT) TO service_role;

-- Raise the standard refusal: SQLSTATE TR403, MESSAGE tenant_restricted,
-- DETAIL = action, HINT = {"action","status"} (parsed by
-- src/billing/enforcement.ts → friendly 403).
CREATE OR REPLACE FUNCTION public.tenant_assert_can(p_account UUID, p_action TEXT)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM accounts WHERE id = p_account;
  IF v_status IS NOT NULL AND account_status_blocks(v_status, p_action) THEN
    RAISE EXCEPTION 'tenant_restricted' USING ERRCODE = 'TR403', DETAIL = p_action,
      HINT = jsonb_build_object('action', p_action, 'status', v_status)::TEXT;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.tenant_assert_can(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_assert_can(UUID, TEXT) TO service_role;

-- Generic guard: TG_ARGV[0] = action; TG_ARGV[1] = 'first_only' → only the
-- first row of the organization counts as a creation (upserts of an
-- existing integration, e.g. editing the WhatsApp or AI settings, pass).
CREATE OR REPLACE FUNCTION public.tenant_guard_action()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_exists BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' AND TG_NARGS > 1 AND TG_ARGV[1] = 'first_only' THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE account_id = $1)', TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO v_exists USING NEW.account_id;
    IF v_exists THEN RETURN NEW; END IF;
  END IF;
  PERFORM tenant_assert_can(NEW.account_id, TG_ARGV[0]);
  RETURN NEW;
END $$;

-- Campaigns: starting or scheduling a send.
DROP TRIGGER IF EXISTS tenant_guard_broadcast_insert ON public.broadcasts;
CREATE TRIGGER tenant_guard_broadcast_insert BEFORE INSERT ON public.broadcasts
  FOR EACH ROW WHEN (NEW.status IN ('scheduled', 'sending'))
  EXECUTE FUNCTION tenant_guard_action('campaigns.send');
DROP TRIGGER IF EXISTS tenant_guard_broadcast_start ON public.broadcasts;
CREATE TRIGGER tenant_guard_broadcast_start BEFORE UPDATE OF status ON public.broadcasts
  FOR EACH ROW WHEN (NEW.status IN ('scheduled', 'sending') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION tenant_guard_action('campaigns.send');

-- Automations and flows: creating or switching on.
DROP TRIGGER IF EXISTS tenant_guard_automation_insert ON public.automations;
CREATE TRIGGER tenant_guard_automation_insert BEFORE INSERT ON public.automations
  FOR EACH ROW EXECUTE FUNCTION tenant_guard_action('automations.run');
DROP TRIGGER IF EXISTS tenant_guard_automation_activate ON public.automations;
CREATE TRIGGER tenant_guard_automation_activate BEFORE UPDATE OF is_active ON public.automations
  FOR EACH ROW WHEN (NEW.is_active AND NOT COALESCE(OLD.is_active, false))
  EXECUTE FUNCTION tenant_guard_action('automations.run');
DROP TRIGGER IF EXISTS tenant_guard_flow_insert ON public.flows;
CREATE TRIGGER tenant_guard_flow_insert BEFORE INSERT ON public.flows
  FOR EACH ROW EXECUTE FUNCTION tenant_guard_action('automations.run');
DROP TRIGGER IF EXISTS tenant_guard_flow_activate ON public.flows;
CREATE TRIGGER tenant_guard_flow_activate BEFORE UPDATE OF status ON public.flows
  FOR EACH ROW WHEN (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION tenant_guard_action('automations.run');

-- Integrations: new WhatsApp number, webhook, API key, AI provider.
DROP TRIGGER IF EXISTS tenant_guard_whatsapp_insert ON public.whatsapp_config;
CREATE TRIGGER tenant_guard_whatsapp_insert BEFORE INSERT ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION tenant_guard_action('integrations.create', 'first_only');
DROP TRIGGER IF EXISTS tenant_guard_webhook_insert ON public.webhook_endpoints;
CREATE TRIGGER tenant_guard_webhook_insert BEFORE INSERT ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION tenant_guard_action('integrations.create');
DROP TRIGGER IF EXISTS tenant_guard_webhook_activate ON public.webhook_endpoints;
CREATE TRIGGER tenant_guard_webhook_activate BEFORE UPDATE OF is_active ON public.webhook_endpoints
  FOR EACH ROW WHEN (NEW.is_active AND NOT COALESCE(OLD.is_active, false))
  EXECUTE FUNCTION tenant_guard_action('integrations.create');
DROP TRIGGER IF EXISTS tenant_guard_api_key_insert ON public.api_keys;
CREATE TRIGGER tenant_guard_api_key_insert BEFORE INSERT ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION tenant_guard_action('integrations.create');
DROP TRIGGER IF EXISTS tenant_guard_ai_config_insert ON public.ai_configs;
CREATE TRIGGER tenant_guard_ai_config_insert BEFORE INSERT ON public.ai_configs
  FOR EACH ROW EXECUTE FUNCTION tenant_guard_action('integrations.create', 'first_only');

-- ------------------------------------------------------------------
-- Membership no longer depends on the status (replaces 906's version)
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      -- FORK(911): no status check — suspended / cancelled organizations
      -- keep their data; account_status_blocks() decides what they lose.
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

-- 906's "operational" now means "can send" (kept for compatibility).
CREATE OR REPLACE FUNCTION public.account_is_operational(p_account UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT account_can(p_account, 'messages.send');
$$;

-- ------------------------------------------------------------------
-- Delinquency bookkeeping (server-only)
-- ------------------------------------------------------------------

-- Automatic actions are audited as the system (actor_user_id NULL).
ALTER TABLE public.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_action_check;
ALTER TABLE public.platform_audit_log ADD CONSTRAINT platform_audit_log_action_check CHECK (action IN (
  'organization.viewed', 'organization.suspended', 'organization.reactivated', 'organization.plan_changed',
  'platform_admin.granted', 'platform_admin.revoked', 'billing_plan.updated',
  'organization.billing_suspended', 'organization.billing_reactivated'));

CREATE TABLE IF NOT EXISTS public.billing_delinquency (
  account_id     UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  past_due_since TIMESTAMPTZ,
  -- who suspended: 'billing' (lifted by payment) or 'platform' (team only)
  suspended_by   TEXT CHECK (suspended_by IN ('billing', 'platform')),
  suspended_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_delinquency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_delinquency FROM PUBLIC, anon, authenticated;

-- Set by billing_enforce_delinquency for its own UPDATE (transaction-local).
CREATE OR REPLACE FUNCTION public.billing_track_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_source TEXT := NULLIF(current_setting('billing.suspension_source', true), '');
  v_prev   billing_delinquency%ROWTYPE;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT * INTO v_prev FROM billing_delinquency WHERE account_id = NEW.id;

  IF NEW.status = 'past_due' THEN
    INSERT INTO billing_delinquency (account_id, past_due_since)
    VALUES (NEW.id, now())
    ON CONFLICT (account_id) DO UPDATE
      -- back from a suspension (team reactivated to past_due): a new grace
      -- period starts, otherwise the next cron would suspend it again.
      SET past_due_since = CASE WHEN OLD.status = 'suspended' THEN now()
                                ELSE COALESCE(billing_delinquency.past_due_since, now()) END,
          suspended_by = NULL, suspended_at = NULL, updated_at = now();
  ELSIF NEW.status = 'suspended' THEN
    INSERT INTO billing_delinquency (account_id, suspended_by, suspended_at)
    VALUES (NEW.id, COALESCE(v_source, 'platform'), now())
    ON CONFLICT (account_id) DO UPDATE
      SET suspended_by = COALESCE(v_source, 'platform'), suspended_at = now(), updated_at = now();
  ELSIF NEW.status IN ('active', 'trial') THEN
    IF OLD.status = 'suspended' AND v_prev.suspended_by = 'billing' THEN
      INSERT INTO platform_audit_log (actor_user_id, actor_email, action, target_account_id, target_account_name, reason, details)
      VALUES (NULL, 'sistema', 'organization.billing_reactivated', NEW.id, left(NEW.name, 200),
              'Pagamento confirmado', jsonb_build_object('from', OLD.status, 'to', NEW.status));
    END IF;
    DELETE FROM billing_delinquency WHERE account_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS billing_track_status ON public.accounts;
CREATE TRIGGER billing_track_status AFTER UPDATE OF status ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION billing_track_status();

-- Organizations already past_due when this migration runs start their
-- grace period now (never suspended retroactively).
INSERT INTO billing_delinquency (account_id, past_due_since)
SELECT id, now() FROM accounts WHERE status = 'past_due'
ON CONFLICT (account_id) DO NOTHING;
INSERT INTO billing_delinquency (account_id, suspended_by, suspended_at)
SELECT id, 'platform', COALESCE(status_changed_at, now()) FROM accounts WHERE status = 'suspended'
ON CONFLICT (account_id) DO NOTHING;

-- past_due for longer than the grace period → suspended (by billing).
-- Audited as the system. Returns how many organizations were suspended.
CREATE OR REPLACE FUNCTION public.billing_enforce_delinquency(p_grace_days INT DEFAULT 7)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; n INT := 0;
BEGIN
  IF p_grace_days IS NULL OR p_grace_days < 0 THEN
    RAISE EXCEPTION 'grace days must be >= 0';
  END IF;
  PERFORM set_config('billing.suspension_source', 'billing', true);
  FOR r IN
    SELECT a.id, a.name, d.past_due_since
      FROM accounts a JOIN billing_delinquency d ON d.account_id = a.id
     WHERE a.status = 'past_due'
       AND d.past_due_since <= now() - make_interval(days => p_grace_days)
     FOR UPDATE OF a
  LOOP
    UPDATE accounts SET status = 'suspended' WHERE id = r.id AND status = 'past_due';
    INSERT INTO platform_audit_log (actor_user_id, actor_email, action, target_account_id, target_account_name, reason, details)
    VALUES (NULL, 'sistema', 'organization.billing_suspended', r.id, left(r.name, 200),
            format('Pagamento pendente desde %s (carência de %s dias)', to_char(r.past_due_since, 'DD/MM/YYYY'), p_grace_days),
            jsonb_build_object('from', 'past_due', 'to', 'suspended', 'grace_days', p_grace_days));
    n := n + 1;
  END LOOP;
  PERFORM set_config('billing.suspension_source', '', true);
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION public.billing_enforce_delinquency(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_enforce_delinquency(INT) TO service_role;

-- What the app shows: status + who suspended + since when (service role).
CREATE OR REPLACE FUNCTION public.billing_access_state(p_account UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'status', a.status,
    'past_due_since', d.past_due_since,
    'suspended_by', d.suspended_by,
    'suspended_at', d.suspended_at)
  FROM accounts a LEFT JOIN billing_delinquency d ON d.account_id = a.id
  WHERE a.id = p_account;
$$;
REVOKE EXECUTE ON FUNCTION public.billing_access_state(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_access_state(UUID) TO service_role;
