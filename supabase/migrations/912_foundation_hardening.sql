-- 912_foundation_hardening (fork, docs/MVP_FOUNDATION_AUDIT.md)
--
-- Fixes from the foundation audit. No new product features:
--
--   1. Plan limits under concurrency: two requests creating the last
--      allowed item at the same time both passed the count (READ COMMITTED
--      does not see the other's uncommitted row). The limit triggers now
--      take a per-organization, per-feature transaction lock before
--      counting, so concurrent creations serialize.
--   2. Organization status state machine: the database accepted any jump
--      between the five statuses (e.g. active → trial). One matrix,
--      account_status_transition_allowed(), mirrored by
--      src/billing/account-status.ts (TRANSITIONS; a vitest keeps both
--      equal), enforced by a trigger for every writer.
--   3. A payment already paid never goes back to pending/overdue, even
--      through an upsert (backstop for the rule in rules.ts).
--   4. Applying a gateway event is atomic: payment + subscription +
--      organization status in ONE transaction (billing_apply_effects), with
--      optimistic checks so two different events for the same payment
--      cannot both grant a period. Before, a failure between the steps left
--      the payment recorded as paid but the plan not switched, and the
--      gateway's retry was treated as a re-delivery (nothing applied).
--   5. Team reactivation restores the status from before the LAST
--      suspension, including suspensions made by billing.
--   6. Trial ends: trial_ends_at is stamped at signup (default plan's
--      trial_days) and the daily cron moves expired trials to past_due.
--   7. Suspension bypasses closed (911 only guarded INSERTs): un-revoking
--      an API key, swapping the WhatsApp number and switching the AI
--      auto-reply on are refused for suspended/cancelled organizations.
--
-- Idempotent.

-- ------------------------------------------------------------------
-- 1. Plan limits: serialize concurrent creations per organization+feature
-- ------------------------------------------------------------------

-- Transaction-scoped: released at COMMIT/ROLLBACK. Only taken when the
-- feature is actually limited (unlimited plans never wait).
CREATE OR REPLACE FUNCTION public._billing_limit_lock(p_account UUID, p_key TEXT)
RETURNS VOID LANGUAGE sql VOLATILE SET search_path = public AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('billing_limit:' || p_key || ':' || p_account::text, 0));
$$;
REVOKE EXECUTE ON FUNCTION public._billing_limit_lock(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_limit_lock(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_enforce_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_limit JSONB;
BEGIN
  -- TG_ARGV[0] = feature key
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;
  v_limit := billing_feature_value(NEW.account_id, TG_ARGV[0]);
  IF jsonb_typeof(v_limit) = 'number' THEN
    -- Separate statement: the count below takes a fresh snapshot AFTER the
    -- lock, so it sees the row a concurrent transaction just committed.
    PERFORM _billing_limit_lock(NEW.account_id, TG_ARGV[0]);
  END IF;
  PERFORM billing_assert(NEW.account_id, TG_ARGV[0], 1);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.billing_enforce_members()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_limit JSONB; v_members BIGINT;
BEGIN
  IF NEW.account_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id) THEN
    RETURN NEW;
  END IF;
  v_limit := billing_feature_value(NEW.account_id, 'max_users');
  IF jsonb_typeof(v_limit) = 'number' THEN
    PERFORM _billing_limit_lock(NEW.account_id, 'max_users');
    -- Members only: the invitation being redeemed already holds a seat.
    SELECT count(*) INTO v_members FROM profiles WHERE account_id = NEW.account_id AND id <> NEW.id;
    IF v_members + 1 > (v_limit #>> '{}')::BIGINT THEN
      PERFORM _billing_raise(NEW.account_id, 'max_users', v_members);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.billing_enforce_contacts()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_limit JSONB; v_used BIGINT;
BEGIN
  -- Browser inserts only (inbound webhook contacts are never refused).
  IF current_setting('role', true) IS DISTINCT FROM 'authenticated' THEN
    RETURN NULL;
  END IF;
  FOR r IN SELECT account_id, count(*) AS n FROM new_contacts WHERE account_id IS NOT NULL GROUP BY 1 ORDER BY 1 LOOP
    v_limit := billing_feature_value(r.account_id, 'max_contacts');
    IF jsonb_typeof(v_limit) = 'number' THEN
      PERFORM _billing_limit_lock(r.account_id, 'max_contacts');
      v_used := billing_usage(r.account_id, 'max_contacts');  -- includes the new rows
      IF v_used > (v_limit #>> '{}')::BIGINT THEN
        PERFORM _billing_raise(r.account_id, 'max_contacts', v_used - r.n);
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- ------------------------------------------------------------------
-- 2. Organization status: allowed transitions (one matrix)
-- ------------------------------------------------------------------
--
--   trial     → active | past_due | suspended | cancelled
--   active    → past_due | suspended | cancelled
--   past_due  → active | suspended | cancelled
--   suspended → active | trial | past_due | cancelled   (team reactivation
--                                                          restores the
--                                                          previous status)
--   cancelled → active                                   (team only)
--
-- Never: back to trial from active/past_due, or out of cancelled into
-- anything but active.
CREATE OR REPLACE FUNCTION public.account_status_transition_allowed(p_from TEXT, p_to TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_from IS NOT DISTINCT FROM p_to OR p_to = ANY (CASE p_from
    WHEN 'trial'     THEN ARRAY['active', 'past_due', 'suspended', 'cancelled']
    WHEN 'active'    THEN ARRAY['past_due', 'suspended', 'cancelled']
    WHEN 'past_due'  THEN ARRAY['active', 'suspended', 'cancelled']
    WHEN 'suspended' THEN ARRAY['active', 'trial', 'past_due', 'cancelled']
    WHEN 'cancelled' THEN ARRAY['active']
    ELSE ARRAY[]::TEXT[]
  END);
$$;

CREATE OR REPLACE FUNCTION public.accounts_guard_status_transition()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT account_status_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'invalid organization status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', DETAIL = 'invalid_status_transition',
            HINT = jsonb_build_object('from', OLD.status, 'to', NEW.status)::TEXT;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS accounts_guard_status_transition ON public.accounts;
CREATE TRIGGER accounts_guard_status_transition
  BEFORE UPDATE OF status ON public.accounts
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.accounts_guard_status_transition();

-- ------------------------------------------------------------------
-- 3. Payments: paid never regresses to pending/overdue
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.billing_payments_keep_paid()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'paid' AND NEW.status IN ('pending', 'overdue') THEN
    NEW.status  := OLD.status;
    NEW.paid_at := OLD.paid_at;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS billing_payments_keep_paid ON public.billing_payments;
CREATE TRIGGER billing_payments_keep_paid
  BEFORE UPDATE OF status ON public.billing_payments
  FOR EACH ROW EXECUTE FUNCTION public.billing_payments_keep_paid();

-- ------------------------------------------------------------------
-- 4. Apply the effects of one gateway event atomically
-- ------------------------------------------------------------------
--
-- Called by BillingService (src/billing/payments/service.ts) with the
-- effects decided by the pure rules (rules.ts) and the state they were
-- decided FROM. If that state changed in the meantime (another event for
-- the same payment/subscription committed first), nothing is written and
-- SQLSTATE 40001 is raised: the webhook answers 500, the event stays
-- claimable, and the gateway's retry decides again from the new state.
--
--   p_payment                   billing_payments row (jsonb) or NULL
--   p_expected_payment_status   status read before deciding (NULL = no row)
--   p_subscription              column → value changes or NULL
--   p_expected_subscription_at  billing_subscriptions.updated_at read before
--                               deciding (NULL = no row / not checked)
--   p_account_from/p_account_to conditional organization status change
CREATE OR REPLACE FUNCTION public.billing_apply_effects(
  p_account UUID,
  p_provider TEXT,
  p_payment JSONB,
  p_expected_payment_status TEXT,
  p_subscription JSONB,
  p_expected_subscription_at TIMESTAMPTZ,
  p_account_from TEXT,
  p_account_to TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status TEXT;
  v_sub_at TIMESTAMPTZ;
  v_found  BOOLEAN;
  s        JSONB := COALESCE(p_subscription, '{}'::jsonb);
BEGIN
  IF p_account IS NULL THEN
    RAISE EXCEPTION 'account required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Subscription row first (same lock order for every caller).
  IF p_subscription IS NOT NULL OR p_expected_subscription_at IS NOT NULL THEN
    SELECT updated_at INTO v_sub_at FROM billing_subscriptions WHERE account_id = p_account FOR UPDATE;
    v_found := FOUND;
    IF p_expected_subscription_at IS NOT NULL AND (NOT v_found OR v_sub_at IS DISTINCT FROM p_expected_subscription_at) THEN
      RAISE EXCEPTION 'billing subscription changed concurrently' USING ERRCODE = 'serialization_failure';
    END IF;
  END IF;

  IF p_payment IS NOT NULL THEN
    IF p_payment->>'account_id' IS DISTINCT FROM p_account::text OR p_payment->>'provider' IS DISTINCT FROM p_provider THEN
      RAISE EXCEPTION 'payment does not belong to this organization/provider' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT status INTO v_status FROM billing_payments
     WHERE provider = p_provider AND external_id = p_payment->>'external_id' FOR UPDATE;
    IF v_status IS DISTINCT FROM p_expected_payment_status THEN
      RAISE EXCEPTION 'billing payment changed concurrently' USING ERRCODE = 'serialization_failure';
    END IF;
    INSERT INTO billing_payments AS bp (
      account_id, provider, external_id, subscription_external_id, plan_code, method, status,
      amount_cents, currency, description, due_date, paid_at, period_start, period_end,
      pix_copy_paste, pix_qr_image, pix_expires_at, boleto_digitable_line, boleto_url, invoice_url, updated_at)
    SELECT r.account_id, r.provider, r.external_id, r.subscription_external_id, r.plan_code, r.method, r.status,
           r.amount_cents, COALESCE(r.currency, 'BRL'), r.description, r.due_date, r.paid_at, r.period_start, r.period_end,
           r.pix_copy_paste, r.pix_qr_image, r.pix_expires_at, r.boleto_digitable_line, r.boleto_url, r.invoice_url, now()
      FROM jsonb_populate_record(NULL::billing_payments, p_payment) r
    ON CONFLICT (provider, external_id) DO UPDATE SET
      subscription_external_id = EXCLUDED.subscription_external_id,
      plan_code = EXCLUDED.plan_code, method = EXCLUDED.method, status = EXCLUDED.status,
      amount_cents = EXCLUDED.amount_cents, currency = EXCLUDED.currency, description = EXCLUDED.description,
      due_date = EXCLUDED.due_date, paid_at = EXCLUDED.paid_at, period_start = EXCLUDED.period_start,
      period_end = EXCLUDED.period_end, pix_copy_paste = EXCLUDED.pix_copy_paste,
      pix_qr_image = EXCLUDED.pix_qr_image, pix_expires_at = EXCLUDED.pix_expires_at,
      boleto_digitable_line = EXCLUDED.boleto_digitable_line, boleto_url = EXCLUDED.boleto_url,
      invoice_url = EXCLUDED.invoice_url, updated_at = now()
    -- never move a payment between organizations
    WHERE bp.account_id = EXCLUDED.account_id;
  END IF;

  IF p_subscription IS NOT NULL AND s <> '{}'::jsonb THEN
    UPDATE billing_subscriptions SET
      plan_code            = CASE WHEN s ? 'plan_code' THEN s->>'plan_code' ELSE plan_code END,
      status               = CASE WHEN s ? 'status' THEN s->>'status' ELSE status END,
      provider             = CASE WHEN s ? 'provider' THEN s->>'provider' ELSE provider END,
      external_id          = CASE WHEN s ? 'external_id' THEN s->>'external_id' ELSE external_id END,
      pending_external_id  = CASE WHEN s ? 'pending_external_id' THEN s->>'pending_external_id' ELSE pending_external_id END,
      pending_plan_code    = CASE WHEN s ? 'pending_plan_code' THEN s->>'pending_plan_code' ELSE pending_plan_code END,
      current_period_end   = CASE WHEN s ? 'current_period_end' THEN (s->>'current_period_end')::timestamptz ELSE current_period_end END,
      cancel_at_period_end = CASE WHEN s ? 'cancel_at_period_end' THEN (s->>'cancel_at_period_end')::boolean ELSE cancel_at_period_end END,
      canceled_at          = CASE WHEN s ? 'canceled_at' THEN (s->>'canceled_at')::timestamptz ELSE canceled_at END,
      updated_at           = clock_timestamp()
     WHERE account_id = p_account;
  END IF;

  -- Conditional: never overwrite a suspension applied in the meantime.
  IF p_account_to IS NOT NULL AND p_account_from IS NOT NULL AND p_account_to <> p_account_from THEN
    UPDATE accounts SET status = p_account_to WHERE id = p_account AND status = p_account_from;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.billing_apply_effects(UUID, TEXT, JSONB, TEXT, JSONB, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_apply_effects(UUID, TEXT, JSONB, TEXT, JSONB, TIMESTAMPTZ, TEXT, TEXT)
  TO service_role;

-- ------------------------------------------------------------------
-- 5. Team reactivation: previous status of the LAST suspension
-- ------------------------------------------------------------------
-- (906 only looked at team suspensions, so reactivating a billing
-- suspension restored the status of an older, unrelated team suspension.)
CREATE OR REPLACE FUNCTION public.platform_set_account_status(
  p_account UUID, p_action TEXT, p_actor UUID, p_reason TEXT,
  p_ip TEXT DEFAULT NULL, p_user_agent TEXT DEFAULT NULL
) RETURNS TABLE (previous_status TEXT, new_status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from TEXT;
  v_to   TEXT;
BEGIN
  IF NOT platform_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not a platform admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO v_from FROM accounts WHERE id = p_account FOR UPDATE;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_action = 'suspend' THEN
    IF v_from NOT IN ('trial', 'active', 'past_due') THEN
      RAISE EXCEPTION 'cannot suspend an organization that is %', v_from USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(btrim(p_reason), '') = '' THEN
      RAISE EXCEPTION 'a reason is required to suspend' USING ERRCODE = 'not_null_violation';
    END IF;
    v_to := 'suspended';
  ELSIF p_action = 'reactivate' THEN
    IF v_from = 'suspended' THEN
      SELECT l.details->>'from' INTO v_to
        FROM platform_audit_log l
       WHERE l.target_account_id = p_account
         AND l.action IN ('organization.suspended', 'organization.billing_suspended')
       ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
      IF v_to IS NULL OR v_to NOT IN ('trial', 'active', 'past_due') THEN
        v_to := 'active';
      END IF;
    ELSIF v_from = 'cancelled' THEN
      v_to := 'active';
    ELSE
      RAISE EXCEPTION 'cannot reactivate an organization that is %', v_from USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown action %', p_action USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE accounts SET status = v_to WHERE id = p_account;
  PERFORM _platform_audit(
    p_actor,
    CASE p_action WHEN 'suspend' THEN 'organization.suspended' ELSE 'organization.reactivated' END,
    p_account, p_reason, jsonb_build_object('from', v_from, 'to', v_to), p_ip, p_user_agent);

  RETURN QUERY SELECT v_from, v_to;
END $$;
REVOKE EXECUTE ON FUNCTION public.platform_set_account_status(UUID, TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_account_status(UUID, TEXT, UUID, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------------
-- 6. Trial: a real end date, enforced by the backend
-- ------------------------------------------------------------------
-- Before: new organizations started in 'trial' with trial_ends_at NULL and
-- nothing ever ended it (a free START plan forever). Now:
--   * the trial length is data on the plan new organizations get
--     (billing_plans.trial_days of the default plan, 14 by default; 0 =
--     no trial end is stamped);
--   * a new organization gets trial_ends_at = now() + trial_days;
--   * the daily billing cron (billing_expire_trials) moves expired trials
--     to past_due — the delinquency policy then applies as for an unpaid
--     invoice: warning + payment, suspension after BILLING_GRACE_DAYS.
--     Nothing is deleted. Paying any plan reopens the organization.
--   * organizations already in trial get a FULL trial from today (never
--     expired retroactively).
ALTER TABLE public.billing_plans
  ADD COLUMN IF NOT EXISTS trial_days INT NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 365);

CREATE OR REPLACE FUNCTION public.billing_default_trial_days()
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT trial_days FROM billing_plans WHERE is_default AND is_active LIMIT 1), 0);
$$;
REVOKE EXECUTE ON FUNCTION public.billing_default_trial_days() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_default_trial_days() TO service_role;

CREATE OR REPLACE FUNCTION public.accounts_set_trial_end()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_days INT;
BEGIN
  IF NEW.status = 'trial' AND NEW.trial_ends_at IS NULL THEN
    v_days := billing_default_trial_days();
    IF v_days > 0 THEN
      NEW.trial_ends_at := now() + make_interval(days => v_days);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS accounts_set_trial_end ON public.accounts;
CREATE TRIGGER accounts_set_trial_end
  BEFORE INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_set_trial_end();

UPDATE public.accounts
   SET trial_ends_at = now() + make_interval(days => public.billing_default_trial_days())
 WHERE status = 'trial' AND trial_ends_at IS NULL AND public.billing_default_trial_days() > 0;

-- Daily (GET /api/billing/cron). Idempotent; returns how many expired.
CREATE OR REPLACE FUNCTION public.billing_expire_trials()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  UPDATE accounts SET status = 'past_due'
   WHERE status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION public.billing_expire_trials() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_expire_trials() TO service_role;

-- ------------------------------------------------------------------
-- 7. Suspension: UPDATE paths that re-create an integration / automation
-- ------------------------------------------------------------------
DROP TRIGGER IF EXISTS tenant_guard_api_key_unrevoke ON public.api_keys;
CREATE TRIGGER tenant_guard_api_key_unrevoke BEFORE UPDATE OF revoked_at ON public.api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL)
  EXECUTE FUNCTION tenant_guard_action('integrations.create');
DROP TRIGGER IF EXISTS tenant_guard_whatsapp_number_change ON public.whatsapp_config;
CREATE TRIGGER tenant_guard_whatsapp_number_change BEFORE UPDATE OF phone_number_id ON public.whatsapp_config
  FOR EACH ROW WHEN (OLD.phone_number_id IS DISTINCT FROM NEW.phone_number_id)
  EXECUTE FUNCTION tenant_guard_action('integrations.create');
DROP TRIGGER IF EXISTS tenant_guard_ai_autoreply_on ON public.ai_configs;
CREATE TRIGGER tenant_guard_ai_autoreply_on BEFORE UPDATE OF auto_reply_enabled ON public.ai_configs
  FOR EACH ROW WHEN (NEW.auto_reply_enabled AND NOT COALESCE(OLD.auto_reply_enabled, false))
  EXECUTE FUNCTION tenant_guard_action('automations.run');
