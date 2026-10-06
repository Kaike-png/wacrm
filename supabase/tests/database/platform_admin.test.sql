-- Platform admin panel + suspension (fork, docs/PLATFORM_ADMIN.md) — pgTAP.
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

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000', 'cccccccc-2222-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a@pa.test', '', now(), '{"full_name":"Owner A"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'cccccccc-2222-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner-b@pa.test', '', now(), '{"full_name":"Owner B"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'cccccccc-2222-4000-8000-000000000009', 'authenticated', 'authenticated', 'staff@pa.test', '', now(), '{"full_name":"Staff"}', now(), now());

CREATE TEMP TABLE ids AS SELECT
  (SELECT account_id FROM profiles WHERE user_id = 'cccccccc-2222-4000-8000-000000000001') AS acc_a,
  (SELECT account_id FROM profiles WHERE user_id = 'cccccccc-2222-4000-8000-000000000002') AS acc_b,
  'cccccccc-2222-4000-8000-000000000001'::UUID AS owner_a,
  'cccccccc-2222-4000-8000-000000000002'::UUID AS owner_b,
  'cccccccc-2222-4000-8000-000000000009'::UUID AS staff;
GRANT SELECT ON ids TO PUBLIC;

UPDATE accounts SET name = 'Padaria Isolada', status = 'trial' WHERE id = (SELECT acc_a FROM ids);
UPDATE accounts SET name = 'Oficina Vizinha', status = 'active' WHERE id = (SELECT acc_b FROM ids);
INSERT INTO br_account_profiles (account_id, person_type, tax_id, legal_name)
SELECT acc_a, 'PJ', '12ABC34501DE35', 'Padaria Isolada LTDA' FROM ids;
INSERT INTO contacts (user_id, account_id, phone, name) SELECT owner_a, acc_a, '+5521999990001', 'Cliente A' FROM ids;
INSERT INTO contacts (user_id, account_id, phone, name) SELECT owner_b, acc_b, '+5521999990002', 'Cliente B' FROM ids;
INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, waba_id, access_token, verify_token, pin, status, last_check_error)
SELECT owner_a, acc_a, '7770007770001', '8880008880001', 'cipher-token-SECRET', 'cipher-verify-SECRET', 'cipher-pin-SECRET', 'error', 'token expired' FROM ids;

SELECT is(public.platform_grant_admin('staff@pa.test', 'pgtap'), 'cccccccc-2222-4000-8000-000000000009'::UUID,
  'the operator grants platform admin by e-mail');
SELECT is((SELECT count(*) FROM platform_audit_log WHERE action = 'platform_admin.granted' AND details->>'email' = 'staff@pa.test'),
  1::BIGINT, 'granting is audited');

-- ------------------------------------------------------------------
-- Customers never reach the platform layer
-- ------------------------------------------------------------------

SELECT pg_temp.login(owner_a) FROM ids;
SELECT throws_ok('SELECT * FROM platform_admins', '42501', NULL, 'a tenant owner cannot read the platform admin list');
SELECT throws_ok('SELECT * FROM platform_audit_log', '42501', NULL, 'a tenant owner cannot read the platform audit log');
SELECT throws_ok(format('SELECT platform_set_account_status(%L, %L, %L, %L)', acc_b, 'suspend', owner_a, 'x'),
  '42501', NULL, 'a tenant owner cannot call the suspend function') FROM ids;
SELECT throws_ok('SELECT * FROM platform_list_organizations()', '42501', NULL,
  'a tenant owner cannot list organizations');
SELECT throws_ok(format('SELECT platform_get_organization(%L)', acc_b), '42501', NULL,
  'a tenant owner cannot read another organization through the panel function') FROM ids;
SELECT throws_ok(format('SELECT platform_grant_admin(%L, %L)', 'owner-a@pa.test', 'me'), '42501', NULL,
  'a tenant owner cannot make itself platform admin');
SELECT throws_ok(format('UPDATE accounts SET status = %L WHERE id = %L', 'active', acc_a), '42501', NULL,
  'a tenant owner cannot change its own status') FROM ids;
RESET ROLE;

SELECT set_config('role', 'service_role', true);
SELECT throws_ok(format('SELECT * FROM platform_set_account_status(%L, %L, %L, %L)', acc_b, 'suspend', owner_a, 'x'),
  '42501', NULL, 'the server refuses an actor that is not a platform admin') FROM ids;
SELECT throws_ok('INSERT INTO platform_admins (user_id) VALUES (''cccccccc-2222-4000-8000-000000000001'')', '42501', NULL,
  'not even the service role can create platform admins');
SELECT throws_ok($$INSERT INTO platform_audit_log (actor_email, action) VALUES ('forged', 'organization.viewed')$$,
  '42501', NULL, 'the service role cannot write audit entries directly');
RESET ROLE;

-- ------------------------------------------------------------------
-- Listing, search, detail — without secrets
-- ------------------------------------------------------------------

SELECT set_config('role', 'service_role', true);
SELECT is((SELECT count(*) FROM platform_list_organizations('Isolada', NULL, 25, 0)), 1::BIGINT, 'search by name');
SELECT is((SELECT count(*) FROM platform_list_organizations('12.abc.345/01de-35', NULL, 25, 0)), 1::BIGINT,
  'search by (alphanumeric) CNPJ with mask, any case');
SELECT is((SELECT count(*) FROM platform_list_organizations('owner-b@', NULL, 25, 0)), 1::BIGINT, 'search by owner e-mail');
SELECT is((SELECT count(*) FROM platform_list_organizations('8880008880001', NULL, 25, 0)), 1::BIGINT, 'search by WABA');
SELECT is((SELECT count(*) FROM platform_list_organizations('%', NULL, 25, 0) WHERE name IN ('Padaria Isolada', 'Oficina Vizinha')),
  0::BIGINT, 'LIKE wildcards in the search are literal');
SELECT results_eq(
  format($$SELECT users_count, contacts_count, integration_errors > 0, status, waba_id
           FROM platform_list_organizations('Isolada', NULL, 25, 0)$$),
  $$VALUES (1::BIGINT, 1::BIGINT, true, 'trial'::TEXT, '8880008880001'::TEXT)$$,
  'the list carries users, contacts, error flag, status and WABA');
SELECT ok(platform_get_organization(acc_a)::TEXT NOT LIKE '%SECRET%', 'organization detail never contains token, verify token or PIN')
  FROM ids;
SELECT is(platform_get_organization(acc_a)->'wabas'->0->>'has_access_token', 'true', 'only the has_* flags are exposed')
  FROM ids;
SELECT ok(
  (SELECT bool_and(t.proname NOT IN ('platform_list_organizations', 'platform_get_organization')
                   OR pg_get_functiondef(t.oid) !~ '\.(access_token|verify_token|pin)\M')
     FROM pg_proc t WHERE t.proname LIKE 'platform_%'),
  'no platform function body references a secret column');

-- ------------------------------------------------------------------
-- Suspend / reactivate (audited, atomic)
-- ------------------------------------------------------------------

SELECT throws_ok(format('SELECT * FROM platform_set_account_status(%L, %L, %L, %L)', acc_a, 'suspend', staff, '  '),
  '23502', NULL, 'suspending requires a reason') FROM ids;
SELECT results_eq(
  format('SELECT previous_status, new_status FROM platform_set_account_status(%L, %L, %L, %L, %L, %L)',
         acc_a, 'suspend', staff, 'Inadimplência', '203.0.113.7', 'pgtap'),
  $$VALUES ('trial'::TEXT, 'suspended'::TEXT)$$, 'a platform admin suspends the organization') FROM ids;
SELECT results_eq(
  $$SELECT actor_email, action, target_account_name, reason, details->>'from', details->>'to', ip
      FROM platform_audit_log WHERE action = 'organization.suspended'
       AND target_account_id = (SELECT acc_a FROM ids)$$,
  $$VALUES ('staff@pa.test'::TEXT, 'organization.suspended'::TEXT, 'Padaria Isolada'::TEXT, 'Inadimplência'::TEXT,
            'trial'::TEXT, 'suspended'::TEXT, '203.0.113.7'::TEXT)$$,
  'the suspension is audited: who, what, which organization, why, from where');
SELECT throws_ok(format('SELECT * FROM platform_set_account_status(%L, %L, %L, %L)', acc_a, 'suspend', staff, 'again'),
  '23514', NULL, 'cannot suspend twice') FROM ids;
SELECT is(account_is_operational(acc_a), false, 'the server sees the organization as not operational') FROM ids;
SELECT is(account_is_operational(acc_b), true, 'other organizations are untouched') FROM ids;
RESET ROLE;

SELECT pg_temp.login(owner_a) FROM ids;
-- 911 (docs/DELINQUENCY.md): suspension restricts actions, not data.
SELECT is((SELECT count(*) FROM contacts), 1::BIGINT, 'a member of a suspended organization still reads its contacts');
SELECT is((SELECT count(*) FROM accounts), 1::BIGINT, '… and its organization');
SELECT is((SELECT count(*) FROM whatsapp_config), 1::BIGINT, '… and its WhatsApp configuration (public columns)');
SELECT lives_ok(format('INSERT INTO contacts (user_id, account_id, phone, name) VALUES (%L, %L, %L, %L)',
  owner_a, acc_a, '+5521900000009', 'x'), '… and can still write data') FROM ids;
SELECT throws_ok(format('INSERT INTO automations (user_id, account_id, name, trigger_type) VALUES (%L, %L, %L, %L)',
  owner_a, acc_a, 'x', 'new_contact_created'), 'TR403', 'tenant_restricted', '… but automations are blocked') FROM ids;
RESET ROLE;
SELECT pg_temp.login(owner_b) FROM ids;
SELECT is((SELECT count(*) FROM contacts), 1::BIGINT, 'a member of an active organization keeps working');
RESET ROLE;

SELECT set_config('role', 'service_role', true);
SELECT results_eq(
  format('SELECT previous_status, new_status FROM platform_set_account_status(%L, %L, %L, %L)', acc_a, 'reactivate', staff, 'Pago'),
  $$VALUES ('suspended'::TEXT, 'trial'::TEXT)$$, 'reactivating restores the status before the suspension') FROM ids;
SELECT throws_ok(format('SELECT * FROM platform_set_account_status(%L, %L, %L, %L)', acc_b, 'reactivate', staff, NULL),
  '23514', NULL, 'an active organization cannot be reactivated') FROM ids;
UPDATE accounts SET status = 'cancelled' WHERE id = (SELECT acc_b FROM ids);
SELECT results_eq(
  format('SELECT new_status FROM platform_set_account_status(%L, %L, %L, %L)', acc_b, 'reactivate', staff, NULL),
  $$VALUES ('active'::TEXT)$$, 'a cancelled organization is reactivated as active') FROM ids;
RESET ROLE;

SELECT pg_temp.login(owner_a) FROM ids;
SELECT is((SELECT count(*) FROM contacts), 2::BIGINT, 'after reactivation everything is still there');
RESET ROLE;

-- ------------------------------------------------------------------
-- Plan
-- ------------------------------------------------------------------

SELECT set_config('role', 'service_role', true);
SELECT is(platform_set_plan(acc_a, 'pro', staff, 'Upgrade'), 'pro', 'a platform admin sets the plan') FROM ids;
SELECT is((SELECT details FROM platform_audit_log WHERE action = 'organization.plan_changed'
          AND target_account_id = (SELECT acc_a FROM ids)),
  '{"to": "pro", "from": "start"}'::jsonb, 'the plan change is audited with from/to');
SELECT throws_ok(format('SELECT platform_set_plan(%L, %L, %L, NULL)', acc_a, 'gold', staff), '22023', NULL,
  'only existing, active plans can be assigned') FROM ids;
RESET ROLE;
SELECT pg_temp.login(owner_a) FROM ids;
SELECT is((SELECT plan_code FROM billing_subscriptions), 'pro', 'members read their own plan');
SELECT throws_ok($$UPDATE billing_subscriptions SET plan_code = 'business'$$, '42501', NULL,
  'members cannot change their plan');
RESET ROLE;
SELECT pg_temp.login(owner_b) FROM ids;
SELECT is((SELECT count(*) FROM billing_subscriptions WHERE account_id = (SELECT acc_a FROM ids)), 0::BIGINT,
  'nobody reads another organization''s plan');
RESET ROLE;

-- ------------------------------------------------------------------
-- Audit log is append-only and views are deduplicated
-- ------------------------------------------------------------------

SELECT set_config('role', 'service_role', true);
SELECT lives_ok(format('SELECT platform_record_view(%L, %L, NULL, NULL)', staff, acc_a), 'viewing is recorded') FROM ids;
SELECT lives_ok(format('SELECT platform_record_view(%L, %L, NULL, NULL)', staff, acc_a), 'viewing again') FROM ids;
SELECT is((SELECT count(*) FROM platform_audit_log WHERE action = 'organization.viewed'
          AND target_account_id = (SELECT acc_a FROM ids)), 1::BIGINT,
  'repeated views within 10 minutes become one entry');
SELECT throws_ok('UPDATE platform_audit_log SET reason = ''edited''', '42501', NULL, 'the service role cannot edit the audit log');
SELECT throws_ok('DELETE FROM platform_audit_log', '42501', NULL, 'the service role cannot delete from the audit log');
RESET ROLE;
SELECT throws_ok('UPDATE platform_audit_log SET reason = ''edited''', '42501', NULL,
  'even the database owner cannot edit the audit log (trigger)');
SELECT throws_ok('DELETE FROM platform_audit_log', '42501', NULL, 'even the database owner cannot delete audit entries');

SELECT ok(public.platform_revoke_admin('staff@pa.test', 'pgtap'), 'the operator revokes platform admin');
SELECT set_config('role', 'service_role', true);
SELECT throws_ok(format('SELECT * FROM platform_set_account_status(%L, %L, %L, %L)', acc_a, 'suspend', staff, 'x'),
  '42501', NULL, 'a revoked admin can no longer act') FROM ids;
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
