-- 906_platform_admin (fork, docs/PLATFORM_ADMIN.md)
--
-- Painel administrativo da plataforma (equipe do SaaS, não clientes):
--
--   platform_admins        quem é admin da plataforma. Sem acesso algum
--                          para anon/authenticated: só o servidor lê.
--   platform_audit_log     auditoria append-only das ações administrativas
--                          (nem a service role altera ou apaga).
--   billing_account_plans  plano de cada organização (manual até o billing).
--   platform_*()           funções SECURITY DEFINER executáveis só pela
--                          service role. Ações (suspender, reativar, plano)
--                          gravam a mudança e a auditoria na mesma transação
--                          e conferem que o ator é platform admin.
--
-- Suspensão de verdade: is_account_member() (017, base de ~110 políticas
-- RLS) passa a negar acesso a membros de organizações suspended/cancelled.
-- O servidor bloqueia o resto (API v1, envios, webhook) via
-- account_is_operational().
--
-- Nenhuma função aqui lê access_token / verify_token / pin.
--
-- Idempotente.

-- ------------------------------------------------------------------
-- Status: uma única definição de "operacional" para RLS e servidor
-- (espelha isAccountOperational em src/billing/account-status.ts)
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.account_is_operational(p_account UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT a.status NOT IN ('suspended', 'cancelled') FROM accounts a WHERE a.id = p_account),
    true
  );
$$;
REVOKE EXECUTE ON FUNCTION public.account_is_operational(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_is_operational(UUID) TO service_role;

-- Mesma assinatura e semântica de 017, mais: a organização precisa estar
-- operacional. Se o upstream redefinir esta função, o teste
-- src/custom/platform... (architecture) e o pgTAP platform_admin acusam.
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
    JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      -- FORK(906): suspended / cancelled organizations lose all access.
      AND a.status NOT IN ('suspended', 'cancelled')
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

-- ------------------------------------------------------------------
-- Admins da plataforma
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by TEXT CHECK (char_length(granted_by) <= 200),
  note       TEXT CHECK (char_length(note) <= 200)
);
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_admins FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.platform_admins TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.platform_admins FROM service_role;

-- ------------------------------------------------------------------
-- Auditoria (append-only)
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.platform_audit_log (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Sem FK de propósito: o registro sobrevive à exclusão do usuário/conta.
  actor_user_id       UUID,
  actor_email         TEXT NOT NULL CHECK (char_length(actor_email) <= 320),
  action              TEXT NOT NULL CHECK (action IN (
                        'organization.viewed',
                        'organization.suspended',
                        'organization.reactivated',
                        'organization.plan_changed',
                        'platform_admin.granted',
                        'platform_admin.revoked'
                      )),
  target_account_id   UUID,
  target_account_name TEXT CHECK (char_length(target_account_name) <= 200),
  reason              TEXT CHECK (char_length(reason) <= 500),
  details             JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip                  TEXT CHECK (char_length(ip) <= 64),
  user_agent          TEXT CHECK (char_length(user_agent) <= 300)
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON public.platform_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_target ON public.platform_audit_log (target_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_actor ON public.platform_audit_log (actor_user_id, created_at DESC);

ALTER TABLE public.platform_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.platform_audit_log TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.platform_audit_log FROM service_role;

CREATE OR REPLACE FUNCTION public.platform_audit_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only'
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS platform_audit_no_update ON public.platform_audit_log;
CREATE TRIGGER platform_audit_no_update
  BEFORE UPDATE OR DELETE ON public.platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.platform_audit_immutable();
DROP TRIGGER IF EXISTS platform_audit_no_truncate ON public.platform_audit_log;
CREATE TRIGGER platform_audit_no_truncate
  BEFORE TRUNCATE ON public.platform_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.platform_audit_immutable();

-- ------------------------------------------------------------------
-- Plano (manual até existir billing)
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.billing_account_plans (
  account_id  UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  plan_code   TEXT NOT NULL CHECK (plan_code ~ '^[a-z][a-z0-9_-]{0,39}$'),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Admin da plataforma (não é membro do tenant): sem tenant_enforce_refs.
  assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.billing_account_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_account_plans FROM PUBLIC, anon, authenticated;
GRANT SELECT (account_id, plan_code, assigned_at) ON public.billing_account_plans TO authenticated;
DROP POLICY IF EXISTS billing_account_plans_select ON public.billing_account_plans;
CREATE POLICY billing_account_plans_select ON public.billing_account_plans
  FOR SELECT TO authenticated USING (is_account_member(account_id));

-- Contagem de mensagens por período (painel): sem isto, varre a conversa toda.
CREATE INDEX IF NOT EXISTS idx_fork_messages_conversation_created
  ON public.messages (conversation_id, created_at);

-- ------------------------------------------------------------------
-- Funções do painel (service role apenas)
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.platform_is_admin(p_user UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = p_user);
$$;

-- Registro de auditoria interno: confere o ator e grava o e-mail atual dele.
CREATE OR REPLACE FUNCTION public._platform_audit(
  p_actor UUID, p_action TEXT, p_account UUID, p_reason TEXT,
  p_details JSONB, p_ip TEXT, p_user_agent TEXT
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email TEXT;
  v_name  TEXT;
  v_id    BIGINT;
BEGIN
  SELECT u.email INTO v_email
    FROM auth.users u JOIN platform_admins pa ON pa.user_id = u.id
   WHERE u.id = p_actor;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'not a platform admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT name INTO v_name FROM accounts WHERE id = p_account;
  INSERT INTO platform_audit_log
    (actor_user_id, actor_email, action, target_account_id, target_account_name,
     reason, details, ip, user_agent)
  VALUES
    (p_actor, v_email, p_action, p_account, left(v_name, 200),
     NULLIF(left(btrim(p_reason), 500), ''), COALESCE(p_details, '{}'::jsonb),
     left(p_ip, 64), left(p_user_agent, 300))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.platform_record_view(
  p_actor UUID, p_account UUID, p_ip TEXT, p_user_agent TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Uma entrada por admin/organização a cada 10 min (recarregar não polui).
  IF NOT EXISTS (
    SELECT 1 FROM platform_audit_log
     WHERE actor_user_id = p_actor AND target_account_id = p_account
       AND action = 'organization.viewed' AND created_at > now() - interval '10 minutes'
  ) THEN
    PERFORM _platform_audit(p_actor, 'organization.viewed', p_account, NULL, '{}', p_ip, p_user_agent);
  END IF;
END $$;

-- suspend: trial|active|past_due → suspended (motivo obrigatório)
-- reactivate: suspended → status anterior à suspensão (padrão active);
--             cancelled → active
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
       WHERE l.target_account_id = p_account AND l.action = 'organization.suspended'
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

CREATE OR REPLACE FUNCTION public.platform_set_plan(
  p_account UUID, p_plan TEXT, p_actor UUID, p_reason TEXT,
  p_ip TEXT DEFAULT NULL, p_user_agent TEXT DEFAULT NULL
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from TEXT;
BEGIN
  IF NOT platform_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not a platform admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT plan_code INTO v_from FROM billing_account_plans WHERE account_id = p_account;
  IF v_from IS NOT DISTINCT FROM p_plan THEN
    RETURN p_plan;
  END IF;
  IF p_plan IS NULL THEN
    DELETE FROM billing_account_plans WHERE account_id = p_account;
  ELSE
    INSERT INTO billing_account_plans (account_id, plan_code, assigned_by)
    VALUES (p_account, p_plan, p_actor)
    ON CONFLICT (account_id) DO UPDATE
      SET plan_code = EXCLUDED.plan_code, assigned_at = now(), assigned_by = EXCLUDED.assigned_by;
  END IF;
  PERFORM _platform_audit(p_actor, 'organization.plan_changed', p_account, p_reason,
    jsonb_build_object('from', v_from, 'to', p_plan), p_ip, p_user_agent);
  RETURN p_plan;
END $$;

-- Lista paginada com busca. Contagens só para a página pedida.
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
           pl.plan_code, w.phone_number_id, w.waba_id, w.status AS whatsapp_status
      FROM accounts a
      CROSS JOIN q
      LEFT JOIN br_account_profiles bp ON bp.account_id = a.id
      LEFT JOIN auth.users u ON u.id = a.owner_user_id
      LEFT JOIN billing_account_plans pl ON pl.account_id = a.id
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

-- Detalhe de uma organização. Sem segredos: só flags has_*.
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
      SELECT jsonb_build_object('plan_code', pl.plan_code, 'assigned_at', pl.assigned_at)
      FROM billing_account_plans pl WHERE pl.account_id = p_account),
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

CREATE OR REPLACE FUNCTION public.platform_list_audit(
  p_account UUID DEFAULT NULL, p_limit INT DEFAULT 50, p_offset INT DEFAULT 0
) RETURNS SETOF public.platform_audit_log
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM platform_audit_log
   WHERE p_account IS NULL OR target_account_id = p_account
   ORDER BY created_at DESC, id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0);
$$;

-- Conceder / revogar (operador, via psql — scripts/fork/platform-admin.sh).
-- Ficam registrados na auditoria com o operador como ator textual.
CREATE OR REPLACE FUNCTION public.platform_grant_admin(p_email TEXT, p_granted_by TEXT, p_note TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user UUID;
BEGIN
  SELECT id INTO v_user FROM auth.users WHERE lower(email) = lower(btrim(p_email));
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no user with e-mail %', p_email USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO platform_admins (user_id, granted_by, note) VALUES (v_user, p_granted_by, p_note)
  ON CONFLICT (user_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO platform_audit_log (actor_user_id, actor_email, action, details)
    VALUES (NULL, left(COALESCE(p_granted_by, current_user), 320), 'platform_admin.granted',
            jsonb_build_object('user_id', v_user, 'email', lower(btrim(p_email))));
  END IF;
  RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION public.platform_revoke_admin(p_email TEXT, p_revoked_by TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user UUID;
BEGIN
  DELETE FROM platform_admins pa USING auth.users u
   WHERE pa.user_id = u.id AND lower(u.email) = lower(btrim(p_email))
  RETURNING pa.user_id INTO v_user;
  IF v_user IS NOT NULL THEN
    INSERT INTO platform_audit_log (actor_user_id, actor_email, action, details)
    VALUES (NULL, left(COALESCE(p_revoked_by, current_user), 320), 'platform_admin.revoked',
            jsonb_build_object('user_id', v_user, 'email', lower(btrim(p_email))));
  END IF;
  RETURN v_user IS NOT NULL;
END $$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.platform_is_admin(uuid)',
    'public._platform_audit(uuid,text,uuid,text,jsonb,text,text)',
    'public.platform_record_view(uuid,uuid,text,text)',
    'public.platform_set_account_status(uuid,text,uuid,text,text,text)',
    'public.platform_set_plan(uuid,text,uuid,text,text,text)',
    'public.platform_list_organizations(text,text,integer,integer)',
    'public.platform_get_organization(uuid)',
    'public.platform_list_audit(uuid,integer,integer)',
    'public.platform_grant_admin(text,text,text)',
    'public.platform_revoke_admin(text,text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  public.platform_is_admin(UUID),
  public.platform_record_view(UUID, UUID, TEXT, TEXT),
  public.platform_set_account_status(UUID, TEXT, UUID, TEXT, TEXT, TEXT),
  public.platform_set_plan(UUID, TEXT, UUID, TEXT, TEXT, TEXT),
  public.platform_list_organizations(TEXT, TEXT, INT, INT),
  public.platform_get_organization(UUID),
  public.platform_list_audit(UUID, INT, INT)
TO service_role;
-- grant/revoke admin: só o operador do banco (postgres), nunca a aplicação.
