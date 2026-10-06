-- 908_usage_metering (fork, docs/USAGE.md)
--
-- Usage per organization, and friendlier plan-limit refusals:
--
--   billing_usage_report(account)  users (total / active 30d / invites),
--                                  contacts, WhatsApp accounts, automations
--                                  (stock) + messages sent / received,
--                                  campaigns and AI (current month in the
--                                  organization's time zone, and last 30 days)
--   billing_can_use(account, key, n)  check_limit + current plan + the
--                                  cheapest plan that would allow it
--   billing_upgrade_for(account, key) that plan (data-driven, by sort_order)
--
-- Refusals (SQLSTATE 53400) now carry a JSON HINT with plan and upgrade
-- names, so any client can say "Você atingiu o limite de 2.000 contatos do
-- plano Start. Faça upgrade para o Pro (10.000 contatos)." without another
-- query. Nothing is deleted when a limit is reached; only new rows are
-- refused (907).
--
-- Read-only aggregates over existing tables (indexes from 906/upstream);
-- no counters on the message write path. Idempotent.

-- ------------------------------------------------------------------
-- Upgrade suggestion
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.billing_upgrade_for(p_account UUID, p_key TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH cur AS (
    SELECT s.plan_code, p.sort_order, billing_feature_value(p_account, p_key) AS value,
           (SELECT kind FROM billing_features WHERE key = p_key) AS kind
      FROM (SELECT p_account AS account_id) a
      LEFT JOIN billing_subscriptions s ON s.account_id = a.account_id
      LEFT JOIN billing_plans p ON p.code = s.plan_code
  )
  SELECT jsonb_build_object('code', p.code, 'name', p.name, 'value', pf.value)
    FROM cur
    JOIN billing_plans p ON p.is_active AND p.code IS DISTINCT FROM cur.plan_code
                        AND (cur.sort_order IS NULL OR p.sort_order > cur.sort_order)
    JOIN billing_plan_features pf ON pf.plan_code = p.code AND pf.feature_key = p_key
   WHERE CASE cur.kind
           WHEN 'flag' THEN pf.value = 'true'::jsonb
           WHEN 'limit' THEN jsonb_typeof(cur.value) = 'number'
                         AND (jsonb_typeof(pf.value) = 'null'
                              OR (pf.value #>> '{}')::NUMERIC > (cur.value #>> '{}')::NUMERIC)
         END
   ORDER BY p.sort_order, p.code
   LIMIT 1;
$$;

-- Everything a message needs: limit, used, plan, upgrade.
CREATE OR REPLACE FUNCTION public.billing_limit_context(p_account UUID, p_key TEXT, p_used BIGINT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'feature', p_key,
    'limit', billing_feature_value(p_account, p_key),
    'used', p_used,
    'plan', (SELECT p.name FROM billing_subscriptions s JOIN billing_plans p ON p.code = s.plan_code
              WHERE s.account_id = p_account),
    'upgrade', billing_upgrade_for(p_account, p_key)->>'name',
    'upgrade_value', billing_upgrade_for(p_account, p_key)->'value');
$$;

CREATE OR REPLACE FUNCTION public._billing_raise(p_account UUID, p_key TEXT, p_used BIGINT)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'plan_limit_exceeded'
    USING ERRCODE = 'configuration_limit_exceeded',  -- 53400
          DETAIL = p_key,
          HINT = billing_limit_context(p_account, p_key, p_used)::TEXT;
END $$;

-- Same checks as 907, raising through _billing_raise.
CREATE OR REPLACE FUNCTION public.billing_assert(p_account UUID, p_key TEXT, p_increment INT DEFAULT 1)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v JSONB;
BEGIN
  IF p_account IS NULL THEN RETURN; END IF;
  v := billing_check_limit(p_account, p_key, p_increment);
  IF NOT (v->>'allowed')::BOOLEAN THEN
    PERFORM _billing_raise(p_account, p_key, (v->>'used')::BIGINT);
  END IF;
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
  IF current_setting('role', true) IS DISTINCT FROM 'authenticated' THEN
    RETURN NULL;
  END IF;
  FOR r IN SELECT account_id, count(*) AS n FROM new_contacts WHERE account_id IS NOT NULL GROUP BY 1 LOOP
    v_limit := billing_feature_value(r.account_id, 'max_contacts');
    IF jsonb_typeof(v_limit) = 'number' THEN
      v_used := billing_usage(r.account_id, 'max_contacts');  -- includes the new rows
      IF v_used > (v_limit #>> '{}')::BIGINT THEN
        PERFORM _billing_raise(r.account_id, 'max_contacts', v_used - r.n);
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- check_limit + plan + upgrade + remaining: the server's CanUseFeature.
CREATE OR REPLACE FUNCTION public.billing_can_use(p_account UUID, p_key TEXT, p_increment INT DEFAULT 1)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v JSONB; v_kind TEXT;
BEGIN
  v := billing_check_limit(p_account, p_key, p_increment);
  SELECT kind INTO v_kind FROM billing_features WHERE key = p_key;
  v := v || jsonb_build_object(
    'kind', v_kind,
    'plan', (SELECT jsonb_build_object('code', p.code, 'name', p.name)
               FROM billing_subscriptions s JOIN billing_plans p ON p.code = s.plan_code
              WHERE s.account_id = p_account),
    'upgrade', CASE WHEN (v->>'allowed')::BOOLEAN THEN NULL ELSE billing_upgrade_for(p_account, p_key) END);
  IF v_kind = 'limit' THEN
    v := v || jsonb_build_object('remaining',
      CASE WHEN jsonb_typeof(v->'limit') = 'number'
           THEN GREATEST((v->>'limit')::BIGINT - COALESCE((v->>'used')::BIGINT, 0), 0) END);
  ELSE
    v := v || jsonb_build_object('limit', billing_feature_value(p_account, p_key));
  END IF;
  RETURN v;
END $$;

-- ------------------------------------------------------------------
-- Usage report
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.billing_usage_report(p_account UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tz     TEXT;
  v_start  TIMESTAMPTZ;
  v_end    TIMESTAMPTZ;
  v_30d    TIMESTAMPTZ := now() - interval '30 days';
BEGIN
  SELECT COALESCE(NULLIF(timezone, ''), 'America/Sao_Paulo') INTO v_tz FROM accounts WHERE id = p_account;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_start := date_trunc('month', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
  EXCEPTION WHEN invalid_parameter_value THEN
    v_tz := 'UTC';
    v_start := date_trunc('month', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
  END;
  v_end := ((date_trunc('month', now() AT TIME ZONE v_tz) + interval '1 month') AT TIME ZONE v_tz);

  RETURN jsonb_build_object(
    'period', jsonb_build_object('start', v_start, 'end', v_end, 'time_zone', v_tz),
    'plan', (SELECT jsonb_build_object('code', p.code, 'name', p.name)
               FROM billing_subscriptions s JOIN billing_plans p ON p.code = s.plan_code
              WHERE s.account_id = p_account),
    'users', jsonb_build_object(
      'total', (SELECT count(*) FROM profiles WHERE account_id = p_account),
      -- Seen in the app (presence heartbeat) or signed in within 30 days.
      'active_30d', (SELECT count(*) FROM profiles pr
                       LEFT JOIN member_presence mp ON mp.user_id = pr.user_id AND mp.account_id = pr.account_id
                       LEFT JOIN auth.users u ON u.id = pr.user_id
                      WHERE pr.account_id = p_account
                        AND (mp.last_seen_at >= v_30d OR u.last_sign_in_at >= v_30d)),
      'pending_invitations', (SELECT count(*) FROM account_invitations
                               WHERE account_id = p_account AND accepted_at IS NULL AND expires_at > now()),
      'limit', billing_feature_value(p_account, 'max_users')),
    'contacts', jsonb_build_object(
      'total', (SELECT count(*) FROM contacts WHERE account_id = p_account),
      'created_period', (SELECT count(*) FROM contacts WHERE account_id = p_account AND created_at >= v_start),
      'limit', billing_feature_value(p_account, 'max_contacts')),
    'whatsapp_accounts', jsonb_build_object(
      'total', (SELECT count(*) FROM whatsapp_config WHERE account_id = p_account),
      'connected', (SELECT count(*) FROM whatsapp_config WHERE account_id = p_account AND status IN ('connected', 'pending')),
      'limit', billing_feature_value(p_account, 'max_whatsapp_accounts')),
    'automations', jsonb_build_object(
      'total', (SELECT count(*) FROM automations WHERE account_id = p_account),
      'active', (SELECT count(*) FROM automations WHERE account_id = p_account AND is_active),
      'limit', billing_feature_value(p_account, 'max_automations')),
    'messages', (
      SELECT jsonb_build_object(
        'sent_period', count(*) FILTER (WHERE m.sender_type <> 'customer' AND m.status <> 'failed' AND m.created_at >= v_start),
        'received_period', count(*) FILTER (WHERE m.sender_type = 'customer' AND m.created_at >= v_start),
        'failed_period', count(*) FILTER (WHERE m.sender_type <> 'customer' AND m.status = 'failed' AND m.created_at >= v_start),
        'sent_30d', count(*) FILTER (WHERE m.sender_type <> 'customer' AND m.status <> 'failed' AND m.created_at >= v_30d),
        'received_30d', count(*) FILTER (WHERE m.sender_type = 'customer' AND m.created_at >= v_30d))
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.account_id = p_account AND m.created_at >= LEAST(v_start, v_30d)),
    'campaigns', jsonb_build_object(
      'created_period', (SELECT count(*) FROM broadcasts WHERE account_id = p_account AND created_at >= v_start),
      'recipients_sent_period', (SELECT count(*) FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id
                                  WHERE b.account_id = p_account AND r.sent_at >= v_start),
      'total', (SELECT count(*) FROM broadcasts WHERE account_id = p_account)),
    'ai', (
      SELECT jsonb_build_object(
        'enabled', billing_feature_value(p_account, 'ai_enabled') = 'true'::jsonb,
        'requests_period', count(*) FILTER (WHERE created_at >= v_start),
        'tokens_period', COALESCE(sum(total_tokens) FILTER (WHERE created_at >= v_start), 0),
        'tokens_30d', COALESCE(sum(total_tokens) FILTER (WHERE created_at >= v_30d), 0),
        'auto_replies_period', (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                                 WHERE c.account_id = p_account AND m.ai_generated AND m.created_at >= v_start))
        FROM ai_usage_log
       WHERE account_id = p_account AND created_at >= LEAST(v_start, v_30d)),
    'api', jsonb_build_object(
      'enabled', billing_feature_value(p_account, 'api_enabled') = 'true'::jsonb,
      'active_keys', (SELECT count(*) FROM api_keys WHERE account_id = p_account AND revoked_at IS NULL
                                                    AND (expires_at IS NULL OR expires_at > now()))),
    'generated_at', now());
END $$;

-- Members read their own organization's report (settings page).
CREATE OR REPLACE FUNCTION public.billing_my_usage()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT billing_usage_report(p.account_id)
    FROM profiles p
   WHERE p.user_id = auth.uid() AND is_account_member(p.account_id);
$$;

REVOKE EXECUTE ON FUNCTION public.billing_upgrade_for(UUID, TEXT), public.billing_limit_context(UUID, TEXT, BIGINT),
  public._billing_raise(UUID, TEXT, BIGINT), public.billing_can_use(UUID, TEXT, INT),
  public.billing_usage_report(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_upgrade_for(UUID, TEXT), public.billing_can_use(UUID, TEXT, INT),
  public.billing_usage_report(UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_my_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_my_usage() TO authenticated, service_role;

-- Platform panel: the same report in the organization detail.
CREATE OR REPLACE FUNCTION public.platform_usage_report(p_account UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT billing_usage_report(p_account);
$$;
REVOKE EXECUTE ON FUNCTION public.platform_usage_report(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_usage_report(UUID) TO service_role;

-- Entitlements (907) now also say, per feature, which plan would raise it,
-- so banners can suggest an upgrade before the user hits a refusal.
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
               'used', CASE WHEN f.kind = 'limit' THEN billing_usage(p_account, f.key) END,
               'upgrade', billing_upgrade_for(p_account, f.key))
             ORDER BY f.sort_order, f.key)
        FROM billing_features f), '[]'::jsonb));
$$;
