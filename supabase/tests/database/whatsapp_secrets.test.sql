-- WhatsApp credentials per tenant (fork, docs/WHATSAPP_SAAS.md) — pgTAP.
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

CREATE FUNCTION pg_temp.affected(sql TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE n BIGINT; BEGIN EXECUTE sql; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-1111-4000-8000-000000000001', 'authenticated', 'authenticated', 'wa-a@iso.test', '', now(), '{"full_name":"WA A"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-1111-4000-8000-000000000002', 'authenticated', 'authenticated', 'wa-a-viewer@iso.test', '', now(), '{"full_name":"WA A viewer"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-1111-4000-8000-000000000001', 'authenticated', 'authenticated', 'wa-b@iso.test', '', now(), '{"full_name":"WA B"}', now(), now());

CREATE TEMP TABLE ids AS SELECT
  (SELECT account_id FROM profiles WHERE user_id = 'aaaaaaaa-1111-4000-8000-000000000001') AS acc_a,
  (SELECT account_id FROM profiles WHERE user_id = 'bbbbbbbb-1111-4000-8000-000000000001') AS acc_b,
  'aaaaaaaa-1111-4000-8000-000000000001'::UUID AS a_admin,
  'aaaaaaaa-1111-4000-8000-000000000002'::UUID AS a_viewer,
  'bbbbbbbb-1111-4000-8000-000000000001'::UUID AS b_admin;
GRANT SELECT ON ids TO PUBLIC;
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'viewer' WHERE user_id = (SELECT a_viewer FROM ids);

-- Seeded by the server (service role / postgres), as the app does.
INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, waba_id, business_id, access_token, verify_token, pin, status)
SELECT a_admin, acc_a, '1110001110001', '2220002220002', '3330003330003', 'cipher-token-A', 'cipher-verify-A', 'cipher-pin-A', 'connected' FROM ids;
INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, waba_id, access_token, status)
SELECT b_admin, acc_b, '1110001110009', '2220002220009', 'cipher-token-B', 'pending' FROM ids;
INSERT INTO whatsapp_connection_events (account_id, event, status, message)
SELECT acc_a, 'tested', 'connected', 'OK' FROM ids UNION ALL SELECT acc_b, 'saved', 'pending', 'B saved' FROM ids;

-- ------------------------------------------------------------------
-- Secrets never reach the browser roles
-- ------------------------------------------------------------------

SELECT is(
  ARRAY(SELECT column_name::TEXT FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
          AND grantee IN ('anon', 'authenticated') AND column_name IN ('access_token', 'verify_token', 'pin')
        ORDER BY 1),
  '{}'::TEXT[], 'no client role holds any privilege on access_token, verify_token or pin');

SELECT pg_temp.login(a_admin) FROM ids;
SELECT throws_ok('SELECT access_token FROM whatsapp_config', '42501', NULL, 'admin cannot read the access token ciphertext');
SELECT throws_ok('SELECT verify_token FROM whatsapp_config', '42501', NULL, 'admin cannot read the verify token ciphertext');
SELECT throws_ok('SELECT pin FROM whatsapp_config', '42501', NULL, 'admin cannot read the PIN ciphertext');
SELECT throws_ok('SELECT * FROM whatsapp_config', '42501', NULL, 'select * is refused (it would include secrets)');
SELECT results_eq(
  'SELECT phone_number_id, waba_id, business_id, status, has_access_token, has_verify_token, has_pin FROM whatsapp_config',
  $$VALUES ('1110001110001'::TEXT, '2220002220002'::TEXT, '3330003330003'::TEXT, 'connected'::TEXT, true, true, true)$$,
  'admin reads only its own non-secret columns and the has_* flags');
SELECT throws_ok(format('UPDATE whatsapp_config SET access_token = %L', 'x'), '42501', NULL, 'admin cannot overwrite the token directly');
SELECT throws_ok(format('UPDATE whatsapp_config SET phone_number_id = %L', '999'), '42501', NULL,
  'admin cannot repoint the number directly (only through the validated API)');
SELECT throws_ok(format('INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, access_token) VALUES (%L, %L, %L, %L)',
  a_admin, acc_a, '555', 'x'), '42501', NULL, 'admin cannot insert a config directly') FROM ids;
SELECT is(pg_temp.affected('UPDATE whatsapp_config SET mirror_inbound_media = false'), 1::BIGINT,
  'admin can still flip the media-mirror preference');
SELECT is((SELECT count(*) FROM whatsapp_config WHERE account_id = (SELECT acc_b FROM ids)), 0::BIGINT,
  'admin of A does not see the WhatsApp config of B');
SELECT is((SELECT count(*) FROM whatsapp_connection_events), 1::BIGINT, 'A sees only its own connection log');
SELECT throws_ok(format('INSERT INTO whatsapp_connection_events (account_id, event) VALUES (%L, %L)', acc_a, 'saved'),
  '42501', NULL, 'clients cannot forge connection log entries') FROM ids;
SELECT throws_ok('DELETE FROM whatsapp_connection_events', '42501', NULL, 'clients cannot erase the connection log');
RESET ROLE;

SELECT pg_temp.login(a_viewer) FROM ids;
SELECT is((SELECT status FROM whatsapp_config), 'connected', 'a viewer sees the connection status');
SELECT is(pg_temp.affected('UPDATE whatsapp_config SET mirror_inbound_media = true'), 0::BIGINT,
  'a viewer cannot change the connection');
SELECT is(pg_temp.affected('DELETE FROM whatsapp_config'), 0::BIGINT, 'a viewer cannot disconnect');
RESET ROLE;

SELECT set_config('role', 'service_role', true);
SELECT is((SELECT access_token FROM whatsapp_config WHERE account_id = (SELECT acc_a FROM ids)), 'cipher-token-A',
  'the server (service role) reads the encrypted token');
RESET ROLE;

-- ------------------------------------------------------------------
-- Each number and each WABA belongs to exactly one tenant
-- ------------------------------------------------------------------

SELECT throws_ok(
  format('INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, access_token) VALUES (%L, gen_random_uuid(), %L, %L)', a_admin, '1110001110001', 'x'),
  NULL, NULL, 'a phone_number_id cannot be saved by a second tenant') FROM ids;
SELECT throws_ok(
  format('UPDATE whatsapp_config SET waba_id = %L WHERE account_id = %L', '2220002220002', acc_b),
  '23505', NULL, 'a WABA cannot be attached to a second tenant') FROM ids;
SELECT throws_ok(
  format('UPDATE whatsapp_config SET business_id = %L WHERE account_id = %L', 'not-a-number', acc_a),
  '23514', NULL, 'Business ID must be numeric') FROM ids;
SELECT lives_ok(format('UPDATE whatsapp_config SET status = %L WHERE account_id = %L', 'error', acc_a),
  'status accepts error') FROM ids;
SELECT throws_ok(format('UPDATE whatsapp_config SET status = %L WHERE account_id = %L', 'broken', acc_a),
  '23514', NULL, 'status only accepts connected | pending | error | disconnected') FROM ids;
SELECT is((SELECT has_pin FROM whatsapp_config WHERE account_id = (SELECT acc_b FROM ids)), false,
  'has_pin follows the column (generated)');

SELECT * FROM finish();
ROLLBACK;
