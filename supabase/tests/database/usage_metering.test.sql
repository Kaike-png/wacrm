-- Usage metering + limit messages (fork, docs/USAGE.md) — pgTAP.
-- Runs with `npm run test:db`. One transaction, rolled back.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

CREATE FUNCTION pg_temp.login(uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::TEXT, true);
  PERFORM set_config('request.jwt.claim.sub', uid::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at, last_sign_in_at)
SELECT '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}', now(), now(), u.signin
FROM (VALUES
  ('eeeeeeee-4444-4000-8000-000000000001'::UUID, 'owner@um.test', now()),
  ('eeeeeeee-4444-4000-8000-000000000002'::UUID, 'idle@um.test', now() - interval '90 days'),
  ('eeeeeeee-4444-4000-8000-000000000003'::UUID, 'other@um.test', now()),
  ('eeeeeeee-4444-4000-8000-000000000009'::UUID, 'staff@um.test', now())
) AS u(id, email, signin);

CREATE TEMP TABLE ids AS SELECT
  (SELECT account_id FROM profiles WHERE user_id = 'eeeeeeee-4444-4000-8000-000000000001') AS acc,
  (SELECT account_id FROM profiles WHERE user_id = 'eeeeeeee-4444-4000-8000-000000000003') AS acc_other,
  'eeeeeeee-4444-4000-8000-000000000001'::UUID AS owner,
  'eeeeeeee-4444-4000-8000-000000000002'::UUID AS idle,
  'eeeeeeee-4444-4000-8000-000000000003'::UUID AS other,
  'eeeeeeee-4444-4000-8000-000000000009'::UUID AS staff;
GRANT SELECT ON ids TO PUBLIC;

UPDATE accounts SET name = 'Medição', timezone = 'America/Sao_Paulo' WHERE id = (SELECT acc FROM ids);
-- idle member: signed in 90 days ago, never seen → not active
UPDATE profiles SET account_id = (SELECT acc FROM ids), account_role = 'agent' WHERE user_id = (SELECT idle FROM ids);
SELECT public.platform_grant_admin('staff@um.test', 'pgtap');

-- Activity: this month vs. 60 days ago (outside the month and the 30 days)
INSERT INTO contacts (user_id, account_id, phone, name)
SELECT owner, acc, '+55119000000' || g, 'C' || g FROM ids, generate_series(1, 3) g;
INSERT INTO conversations (user_id, contact_id, account_id)
SELECT owner, c.id, acc FROM ids, contacts c WHERE c.account_id = ids.acc;
CREATE TEMP TABLE conv AS SELECT id FROM conversations WHERE account_id = (SELECT acc FROM ids) LIMIT 1;

INSERT INTO messages (conversation_id, sender_type, content_text, status, created_at, ai_generated)
SELECT (SELECT id FROM conv), v.sender, 'x', v.status, v.at, v.ai
FROM (VALUES
  ('customer', 'delivered', now(), false), ('customer', 'delivered', now(), false), ('customer', 'read', now(), false),
  ('agent', 'sent', now(), false), ('bot', 'delivered', now(), true), ('agent', 'failed', now(), false),
  ('customer', 'read', now() - interval '60 days', false), ('agent', 'sent', now() - interval '60 days', false)
) AS v(sender, status, at, ai);

INSERT INTO broadcasts (user_id, name, template_name, account_id) SELECT owner, 'Promo', 'hello', acc FROM ids;
INSERT INTO broadcast_recipients (broadcast_id, status, sent_at)
SELECT b.id, 'sent', now() FROM broadcasts b, generate_series(1, 4) WHERE b.account_id = (SELECT acc FROM ids);
INSERT INTO ai_usage_log (account_id, mode, provider, model, total_tokens, created_at)
SELECT acc, 'auto_reply', 'openai', 'gpt', v.tokens, v.at FROM ids,
  (VALUES (100, now()), (250, now()), (999, now() - interval '60 days')) AS v(tokens, at);

-- Noise in another organization must not leak into the report.
INSERT INTO contacts (user_id, account_id, phone, name) SELECT other, acc_other, '+5511988887777', 'Z' FROM ids;

-- ------------------------------------------------------------------
-- GetUsage
-- ------------------------------------------------------------------

SELECT set_config('role', 'service_role', true);
CREATE TEMP TABLE rep AS SELECT billing_usage_report(acc) AS r FROM ids;
GRANT SELECT ON rep TO PUBLIC;

SELECT is((SELECT r->'plan'->>'name' FROM rep), 'Start', 'report names the plan');
SELECT results_eq(
  $$SELECT (r->'users'->>'total')::INT, (r->'users'->>'active_30d')::INT, (r->'users'->>'limit')::INT FROM rep$$,
  $$VALUES (2, 1, 2)$$, 'users: total, active in 30 days (idle member excluded), limit');
SELECT results_eq(
  $$SELECT (r->'contacts'->>'total')::INT, (r->'contacts'->>'limit')::INT FROM rep$$,
  $$VALUES (3, 2000)$$, 'contacts: only this organization, with the limit');
SELECT results_eq(
  $$SELECT (r->'messages'->>'sent_period')::INT, (r->'messages'->>'received_period')::INT,
           (r->'messages'->>'failed_period')::INT FROM rep$$,
  $$VALUES (2, 3, 1)$$, 'messages this month: sent (agent+bot, not failed), received, failed');
SELECT results_eq(
  $$SELECT (r->'campaigns'->>'created_period')::INT, (r->'campaigns'->>'recipients_sent_period')::INT FROM rep$$,
  $$VALUES (1, 4)$$, 'campaigns this month and campaign sends');
SELECT results_eq(
  $$SELECT (r->'ai'->>'enabled')::BOOLEAN, (r->'ai'->>'requests_period')::INT, (r->'ai'->>'tokens_period')::INT,
           (r->'ai'->>'auto_replies_period')::INT FROM rep$$,
  $$VALUES (false, 2, 350, 1)$$, 'AI: flag, calls, tokens and auto-replies this month (old usage excluded)');
SELECT results_eq(
  $$SELECT (r->'whatsapp_accounts'->>'total')::INT, (r->'automations'->>'total')::INT FROM rep$$,
  $$VALUES (0, 0)$$, 'WhatsApp accounts and automations');
SELECT is((SELECT r->'period'->>'time_zone' FROM rep), 'America/Sao_Paulo', 'the month follows the organization time zone');
SELECT ok((SELECT (r->'period'->>'start')::TIMESTAMPTZ <= now() AND (r->'period'->>'end')::TIMESTAMPTZ > now() FROM rep),
  'the period contains now');
RESET ROLE;

-- ------------------------------------------------------------------
-- CanUseFeature + upgrade suggestion (data-driven)
-- ------------------------------------------------------------------

SELECT set_config('role', 'service_role', true);
SELECT results_eq(
  format($$SELECT (v->>'allowed')::BOOLEAN, (v->>'remaining')::INT, v->'upgrade' FROM billing_can_use(%L, 'max_contacts', 1) v$$,
         (SELECT acc FROM ids)),
  $$VALUES (true, 1997, 'null'::JSONB)$$, 'allowed: remaining reported, no upgrade needed');
SELECT results_eq(
  format($$SELECT (v->>'allowed')::BOOLEAN, v->'upgrade'->>'name', (v->'upgrade'->>'value')::INT
             FROM billing_can_use(%L, 'max_contacts', 5000) v$$, (SELECT acc FROM ids)),
  $$VALUES (false, 'Pro', 10000)$$, 'refused: suggests the cheapest plan that fits (Pro, 10.000)');
SELECT is(billing_upgrade_for(acc, 'max_whatsapp_accounts')->>'name', 'Business',
  'WhatsApp numbers: Pro has the same 1, so the suggestion skips to Business') FROM ids;
SELECT is(billing_upgrade_for(acc, 'ai_enabled')->>'name', 'Pro', 'AI: first plan that enables it') FROM ids;
SELECT platform_set_plan(acc, 'business', staff, 'top') FROM ids;
SELECT is(billing_upgrade_for(acc, 'max_contacts'), NULL, 'top plan: no upgrade to suggest') FROM ids;
SELECT is(billing_upgrade_for(acc, 'max_automations'), NULL, 'already unlimited: no upgrade') FROM ids;
SELECT platform_set_plan(acc, 'start', staff, 'back') FROM ids;
RESET ROLE;

-- ------------------------------------------------------------------
-- Refusals carry the context for the friendly message
-- ------------------------------------------------------------------

CREATE FUNCTION pg_temp.refusal(sql TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE h TEXT; d TEXT; c TEXT;
BEGIN
  EXECUTE sql;
  RETURN NULL;
EXCEPTION WHEN configuration_limit_exceeded THEN
  GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, d = PG_EXCEPTION_DETAIL, c = RETURNED_SQLSTATE;
  RETURN h::JSONB || jsonb_build_object('detail', d, 'sqlstate', c);
END $$;

SELECT is(
  pg_temp.refusal(format($$INSERT INTO account_invitations (account_id, token_hash, role, expires_at)
                          VALUES (%L, 'hx', 'agent', now() + interval '1 day')$$, acc)),
  '{"feature": "max_users", "limit": 2, "used": 2, "plan": "Start", "upgrade": "Pro", "upgrade_value": 5,
    "detail": "max_users", "sqlstate": "53400"}'::jsonb,
  'database refusal: 53400 + JSON hint with limit, used, plan and upgrade') FROM ids;

UPDATE billing_plan_features SET value = '3' WHERE plan_code = 'start' AND feature_key = 'max_contacts';
SELECT pg_temp.login(owner) FROM ids;
SELECT is(
  pg_temp.refusal(format($$INSERT INTO contacts (user_id, account_id, phone, name) VALUES (%L, %L, '+5511900000099', 'x')$$,
                         owner, acc)) - 'sqlstate' - 'detail',
  '{"feature": "max_contacts", "limit": 3, "used": 3, "plan": "Start", "upgrade": "Pro", "upgrade_value": 10000}'::jsonb,
  'contacts typed in the app: refusal reports the count before the insert') FROM ids;
RESET ROLE;

-- ------------------------------------------------------------------
-- Reaching a limit never deletes data
-- ------------------------------------------------------------------

SELECT is((SELECT count(*) FROM contacts WHERE account_id = (SELECT acc FROM ids)), 3::BIGINT,
  'nothing was removed when the limit was reached');
UPDATE billing_plan_features SET value = '1' WHERE plan_code = 'start' AND feature_key = 'max_contacts';
SELECT is((SELECT count(*) FROM contacts WHERE account_id = (SELECT acc FROM ids)), 3::BIGINT,
  'lowering the limit below the current count keeps every contact');
SELECT pg_temp.login(owner) FROM ids;
SELECT is((SELECT count(*) FROM contacts), 3::BIGINT, 'members still see and use them');
SELECT lives_ok(format($$UPDATE contacts SET name = 'editado' WHERE account_id = %L$$, acc),
  'editing existing records keeps working over the limit') FROM ids;
SELECT throws_ok(format($$INSERT INTO contacts (user_id, account_id, phone, name) VALUES (%L, %L, '+5511900000098', 'y')$$,
  owner, acc), '53400', 'plan_limit_exceeded', 'only new records are refused') FROM ids;

-- ------------------------------------------------------------------
-- Who reads usage
-- ------------------------------------------------------------------

SELECT is((billing_my_usage()->'contacts'->>'total')::INT, 3, 'a member reads the usage of their own organization');
SELECT throws_ok(format('SELECT billing_usage_report(%L)', acc_other), '42501', NULL,
  'a member cannot read another organization''s usage') FROM ids;
SELECT throws_ok(format('SELECT billing_can_use(%L, %L)', acc_other, 'max_users'), '42501', NULL,
  'nor probe its limits') FROM ids;
RESET ROLE;
SELECT pg_temp.login(other) FROM ids;
SELECT is((billing_my_usage()->'contacts'->>'total')::INT, 1, 'each organization sees only its own numbers');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
