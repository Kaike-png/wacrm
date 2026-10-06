-- SaaS plans and limits (fork, docs/PLANS.md) — pgTAP.
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

-- ------------------------------------------------------------------
-- Catalog as specified (seeded by 907)
-- ------------------------------------------------------------------

SELECT results_eq(
  $$SELECT p.code, f.key, pf.value FROM billing_plan_features pf
      JOIN billing_plans p ON p.code = pf.plan_code JOIN billing_features f ON f.key = pf.feature_key
     WHERE p.code IN ('start', 'pro', 'business') ORDER BY p.sort_order, f.sort_order$$,
  $$VALUES
    ('start', 'max_users', '2'::jsonb), ('start', 'max_whatsapp_accounts', '1'), ('start', 'max_contacts', '2000'),
    ('start', 'max_automations', '5'), ('start', 'ai_enabled', 'false'), ('start', 'api_enabled', 'false'),
    ('pro', 'max_users', '5'), ('pro', 'max_whatsapp_accounts', '1'), ('pro', 'max_contacts', '10000'),
    ('pro', 'max_automations', '30'), ('pro', 'ai_enabled', 'true'), ('pro', 'api_enabled', 'true'),
    ('business', 'max_users', '15'), ('business', 'max_whatsapp_accounts', '3'), ('business', 'max_contacts', '50000'),
    ('business', 'max_automations', 'null'), ('business', 'ai_enabled', 'true'), ('business', 'api_enabled', 'true')$$,
  'START / PRO / BUSINESS seeded with the specified limits (null = unlimited)');

SELECT throws_ok($$INSERT INTO billing_plan_features VALUES ('pro', 'ai_enabled', '1')$$, '23514', NULL,
  'a flag only accepts true/false') ;
SELECT throws_ok($$UPDATE billing_plan_features SET value = '-1' WHERE plan_code = 'pro' AND feature_key = 'max_users'$$,
  '23514', NULL, 'a limit cannot be negative');
SELECT throws_ok($$UPDATE billing_plan_features SET value = '2.5' WHERE plan_code = 'pro' AND feature_key = 'max_users'$$,
  '23514', NULL, 'a limit must be a whole number');
SELECT throws_ok($$UPDATE billing_plans SET is_default = true WHERE code = 'pro'$$, '23505', NULL,
  'only one default plan');

-- ------------------------------------------------------------------
-- Fixtures: two organizations created by signup
-- ------------------------------------------------------------------

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}', now(), now()
FROM (VALUES
  ('dddddddd-3333-4000-8000-000000000001'::UUID, 'start-owner@bp.test'),
  ('dddddddd-3333-4000-8000-000000000002'::UUID, 'start-member@bp.test'),
  ('dddddddd-3333-4000-8000-000000000003'::UUID, 'start-extra@bp.test'),
  ('dddddddd-3333-4000-8000-000000000004'::UUID, 'pro-owner@bp.test'),
  ('dddddddd-3333-4000-8000-000000000009'::UUID, 'staff@bp.test')
) AS u(id, email);

CREATE TEMP TABLE ids AS SELECT
  (SELECT account_id FROM profiles WHERE user_id = 'dddddddd-3333-4000-8000-000000000001') AS acc_s,
  (SELECT account_id FROM profiles WHERE user_id = 'dddddddd-3333-4000-8000-000000000004') AS acc_p,
  'dddddddd-3333-4000-8000-000000000001'::UUID AS s_owner,
  'dddddddd-3333-4000-8000-000000000002'::UUID AS s_member,
  'dddddddd-3333-4000-8000-000000000003'::UUID AS s_extra,
  'dddddddd-3333-4000-8000-000000000004'::UUID AS p_owner,
  'dddddddd-3333-4000-8000-000000000009'::UUID AS staff;
GRANT SELECT ON ids TO PUBLIC;

SELECT is((SELECT plan_code FROM billing_subscriptions WHERE account_id = (SELECT acc_s FROM ids)), 'start',
  'a new organization gets the default plan');
SELECT public.platform_grant_admin('staff@bp.test', 'pgtap');
SELECT set_config('role', 'service_role', true);
SELECT platform_set_plan(acc_p, 'pro', staff, 'test') FROM ids;
RESET ROLE;

SELECT is(billing_feature_value(acc_s, 'ai_enabled'), 'false'::jsonb, 'START: no AI') FROM ids;
SELECT is(billing_feature_value(acc_p, 'ai_enabled'), 'true'::jsonb, 'PRO: AI') FROM ids;
SELECT is(billing_check_limit(acc_s, 'max_users')->>'allowed', 'true', 'START: room for a second user') FROM ids;

-- ------------------------------------------------------------------
-- Users: members + pending invitations
-- ------------------------------------------------------------------

SELECT lives_ok(format($$INSERT INTO account_invitations (account_id, token_hash, role, expires_at)
                         VALUES (%L, 'h1', 'agent', now() + interval '7 days')$$, acc_s),
  'START: first invitation fits (1 member + 1 pending = 2)') FROM ids;
SELECT throws_ok(format($$INSERT INTO account_invitations (account_id, token_hash, role, expires_at)
                          VALUES (%L, 'h2', 'agent', now() + interval '7 days')$$, acc_s),
  '53400', 'plan_limit_exceeded', 'START: a second pending invitation exceeds 2 users') FROM ids;
SELECT lives_ok(format('UPDATE profiles SET account_id = %L, account_role = %L WHERE user_id = %L', acc_s, 'agent', s_member),
  'the invited user joins (the pending invitation already held the seat)') FROM ids;
SELECT throws_ok(format('UPDATE profiles SET account_id = %L, account_role = %L WHERE user_id = %L', acc_s, 'agent', s_extra),
  '53400', 'plan_limit_exceeded', 'START: a third member is refused, whatever the path') FROM ids;

-- ------------------------------------------------------------------
-- Automations
-- ------------------------------------------------------------------

INSERT INTO automations (user_id, account_id, name, trigger_type)
SELECT s_owner, acc_s, 'A' || g, 'new_message' FROM ids, generate_series(1, 5) g;
SELECT throws_ok(format($$INSERT INTO automations (user_id, account_id, name, trigger_type) VALUES (%L, %L, 'A6', 'new_message')$$,
  s_owner, acc_s), '53400', 'plan_limit_exceeded', 'START: the 6th automation is refused') FROM ids;
SELECT is(billing_check_limit(acc_s, 'max_automations')->>'used', '5', 'usage is reported') FROM ids;

-- Business: unlimited
SELECT set_config('role', 'service_role', true);
SELECT platform_set_plan(acc_s, 'business', staff, 'upgrade') FROM ids;
RESET ROLE;
SELECT lives_ok(format($$INSERT INTO automations (user_id, account_id, name, trigger_type) VALUES (%L, %L, 'A6', 'new_message')$$,
  s_owner, acc_s), 'after upgrading to BUSINESS (unlimited) the same insert works') FROM ids;
SELECT is(billing_check_limit(acc_s, 'max_automations', 1000)->>'allowed', 'true', 'null limit = unlimited') FROM ids;
SELECT set_config('role', 'service_role', true);
SELECT platform_set_plan(acc_s, 'start', staff, 'downgrade') FROM ids;
RESET ROLE;
SELECT is(billing_check_limit(acc_s, 'max_automations')->>'allowed', 'false',
  'after a downgrade nothing is deleted, but nothing new fits') FROM ids;

-- ------------------------------------------------------------------
-- Contacts: browser inserts limited, inbound (service role) never
-- ------------------------------------------------------------------

UPDATE billing_plan_features SET value = '3' WHERE plan_code = 'start' AND feature_key = 'max_contacts';
SELECT pg_temp.login(s_owner) FROM ids;
SELECT lives_ok(format($$INSERT INTO contacts (user_id, account_id, phone, name)
  VALUES (%1$L, %2$L, '+5511900000001', 'c1'), (%1$L, %2$L, '+5511900000002', 'c2')$$, s_owner, acc_s),
  'two contacts fit in a limit of 3') FROM ids;
SELECT throws_ok(format($$INSERT INTO contacts (user_id, account_id, phone, name)
  VALUES (%1$L, %2$L, '+5511900000003', 'c3'), (%1$L, %2$L, '+5511900000004', 'c4')$$, s_owner, acc_s),
  '53400', 'plan_limit_exceeded', 'a batch that would cross the limit is refused as a whole') FROM ids;
SELECT lives_ok(format($$INSERT INTO contacts (user_id, account_id, phone, name) VALUES (%L, %L, '+5511900000003', 'c3')$$,
  s_owner, acc_s), 'one more fits exactly') FROM ids;
SELECT throws_ok(format($$INSERT INTO contacts (user_id, account_id, phone, name) VALUES (%L, %L, '+5511900000004', 'c4')$$,
  s_owner, acc_s), '53400', 'plan_limit_exceeded', 'the 4th contact typed in the app is refused') FROM ids;
RESET ROLE;
SELECT set_config('role', 'service_role', true);
SELECT lives_ok(format($$INSERT INTO contacts (user_id, account_id, phone, name) VALUES (%L, %L, '+5511900000005', 'inbound')$$,
  s_owner, acc_s), 'a contact created by an inbound WhatsApp message (service role) is never refused') FROM ids;
RESET ROLE;

-- ------------------------------------------------------------------
-- WhatsApp numbers, API
-- ------------------------------------------------------------------

UPDATE billing_plan_features SET value = '0' WHERE plan_code = 'start' AND feature_key = 'max_whatsapp_accounts';
SELECT throws_ok(format($$INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, access_token)
  VALUES (%L, %L, '5550001112223', 'x')$$, s_owner, acc_s), '53400', 'plan_limit_exceeded',
  'connecting a number beyond max_whatsapp_accounts is refused') FROM ids;
SELECT throws_ok(format($$INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (%L, 'k', 'wacrm_live_x', 'h')$$,
  acc_s), '53400', 'plan_limit_exceeded', 'START: no API keys (api_enabled = false)') FROM ids;
SELECT lives_ok(format($$INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (%L, 'k', 'wacrm_live_y', 'h2')$$,
  acc_p), 'PRO: API keys allowed') FROM ids;

-- ------------------------------------------------------------------
-- No plan → catalog defaults (unlimited / enabled): legacy organizations
-- ------------------------------------------------------------------

DELETE FROM billing_subscriptions WHERE account_id = (SELECT acc_p FROM ids);
SELECT is(billing_feature_value(acc_p, 'max_contacts'), 'null'::jsonb, 'no plan: unlimited contacts') FROM ids;
SELECT is(billing_feature_value(acc_p, 'api_enabled'), 'true'::jsonb, 'no plan: API enabled') FROM ids;

-- ------------------------------------------------------------------
-- Who can read what
-- ------------------------------------------------------------------

SELECT pg_temp.login(s_owner) FROM ids;
SELECT is(billing_my_entitlements()->'plan'->>'code', 'start', 'members read their own entitlements');
SELECT is((SELECT count(*) FROM billing_plans), 3::BIGINT, 'the plan catalog is readable (comparison page)');
SELECT throws_ok(format('SELECT billing_entitlements(%L)', acc_p), '42501', NULL,
  'entitlements of another organization are not callable') FROM ids;
SELECT throws_ok(format('SELECT billing_check_limit(%L, %L)', acc_p, 'max_users'), '42501', NULL,
  'clients cannot probe usage of other organizations') FROM ids;
SELECT throws_ok($$UPDATE billing_plan_features SET value = '999' WHERE feature_key = 'max_users'$$, '42501', NULL,
  'clients cannot edit plans');
SELECT throws_ok($$UPDATE billing_subscriptions SET plan_code = 'business'$$, '42501', NULL,
  'clients cannot change their plan');
RESET ROLE;

-- ------------------------------------------------------------------
-- Plan editing in the platform panel
-- ------------------------------------------------------------------

SELECT set_config('role', 'service_role', true);
SELECT throws_ok(format($$SELECT platform_update_plan('pro', NULL, NULL, NULL, '{"max_users": 6}', %L, NULL)$$, s_owner),
  '42501', NULL, 'only platform admins edit plans') FROM ids;
SELECT throws_ok(format($$SELECT platform_update_plan('pro', NULL, NULL, NULL, '{"max_seats": 6}', %L, NULL)$$, staff),
  '22023', NULL, 'unknown feature keys are refused') FROM ids;
SELECT throws_ok(format($$SELECT platform_update_plan('pro', NULL, NULL, NULL, '{"ai_enabled": 3}', %L, NULL)$$, staff),
  '23514', NULL, 'values are validated by kind') FROM ids;
SELECT lives_ok(format($$SELECT platform_update_plan('pro', 'Pro+', true, true, '{"max_users": 6}', %L, 'reajuste')$$, staff),
  'a platform admin edits a plan') FROM ids;
SELECT results_eq($$SELECT name, is_default FROM billing_plans WHERE code IN ('start', 'pro') ORDER BY sort_order$$,
  $$VALUES ('Start'::TEXT, false), ('Pro+'::TEXT, true)$$, 'making a plan default unsets the previous default');
SELECT is((SELECT value FROM billing_plan_features WHERE plan_code = 'pro' AND feature_key = 'max_users'), '6'::jsonb,
  'the new value is stored');
SELECT is((SELECT (details->'from'->'features'->>'max_users') || '→' || (details->'to'->'features'->>'max_users')
             FROM platform_audit_log WHERE action = 'billing_plan.updated' AND details->>'plan' = 'pro'
             ORDER BY id DESC LIMIT 1), '5→6', 'the edit is audited with before/after');
SELECT throws_ok(format($$SELECT platform_update_plan('pro', NULL, false, true, '{}', %L, NULL)$$, staff),
  '23514', NULL, 'the default plan cannot be inactive') FROM ids;
SELECT throws_ok(format('SELECT platform_set_plan(%L, %L, %L, NULL)', acc_s, 'nope', staff), '22023', NULL,
  'assigning an unknown plan is refused') FROM ids;
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
