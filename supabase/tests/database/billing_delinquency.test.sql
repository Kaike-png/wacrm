-- Delinquency policy (fork, 911, docs/DELINQUENCY.md) — pgTAP. Rolled back.

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
SELECT '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}', now(), now()
FROM (VALUES
  ('dddddddd-6666-4000-8000-000000000001'::UUID, 'owner@dlq.test'),
  ('dddddddd-6666-4000-8000-000000000009'::UUID, 'staff@dlq.test')
) AS u(id, email);
CREATE TEMP TABLE ids AS SELECT
  (SELECT account_id FROM profiles WHERE user_id = 'dddddddd-6666-4000-8000-000000000001') AS acc,
  'dddddddd-6666-4000-8000-000000000001'::UUID AS owner,
  'dddddddd-6666-4000-8000-000000000009'::UUID AS staff;
GRANT SELECT ON ids TO PUBLIC;
SELECT public.platform_grant_admin('staff@dlq.test', 'pgtap');
-- On a plan with API access, so only the delinquency policy can refuse.
SELECT platform_set_plan(acc, 'pro', staff, 'pgtap') FROM ids;

INSERT INTO contacts (user_id, account_id, phone, name) SELECT owner, acc, '+5511900000001', 'Cliente' FROM ids;
INSERT INTO automations (user_id, account_id, name, trigger_type, is_active)
SELECT owner, acc, 'Boas-vindas', 'new_contact_created', false FROM ids;

-- ---------------------------------------------------------------- matrix
SELECT is(account_status_blocks('past_due', 'messages.send'), false, 'past_due blocks nothing');
SELECT is(account_status_blocks('active', 'campaigns.send'), false, 'active blocks nothing');
SELECT ok(account_status_blocks('suspended', 'messages.send') AND account_status_blocks('suspended', 'campaigns.send')
          AND account_status_blocks('suspended', 'automations.run') AND account_status_blocks('suspended', 'integrations.create'),
          'suspended blocks sending, campaigns, automations, integrations');
SELECT is(account_status_blocks('suspended', 'data.export'), false, 'export is never blocked');

-- ---------------------------------------------------------------- past_due
UPDATE accounts SET status = 'past_due' WHERE id = (SELECT acc FROM ids);
SELECT ok((SELECT past_due_since IS NOT NULL FROM billing_delinquency WHERE account_id = (SELECT acc FROM ids)),
          'entering past_due starts the grace period');
SELECT pg_temp.login((SELECT owner FROM ids));
SELECT lives_ok($$INSERT INTO automations (user_id, account_id, name, trigger_type) SELECT owner, acc, 'Nova', 'new_contact_created' FROM ids$$,
                'past_due: automations can still be created');
RESET role;

-- grace not over → nothing happens
SELECT is(billing_enforce_delinquency(7), 0, 'within the grace period: not suspended');
UPDATE billing_delinquency SET past_due_since = now() - interval '8 days' WHERE account_id = (SELECT acc FROM ids);
SELECT is(billing_enforce_delinquency(7), 1, 'grace period over: suspended');
SELECT is((SELECT status FROM accounts WHERE id = (SELECT acc FROM ids)), 'suspended', 'status suspended');
SELECT is((SELECT suspended_by FROM billing_delinquency WHERE account_id = (SELECT acc FROM ids)), 'billing', 'suspended by billing');
SELECT is((SELECT actor_email || ' ' || action FROM platform_audit_log WHERE target_account_id = (SELECT acc FROM ids) ORDER BY id DESC LIMIT 1),
          'sistema organization.billing_suspended', 'automatic suspension is audited as the system');
SELECT is(billing_enforce_delinquency(7), 0, 'enforcement is idempotent');

-- ---------------------------------------------------------------- suspended: what stays
SELECT pg_temp.login((SELECT owner FROM ids));
SELECT is((SELECT count(*)::INT FROM contacts), 1, 'suspended: data is still readable');
SELECT lives_ok($$UPDATE contacts SET name = 'Cliente editado'$$, 'suspended: data is still editable');
SELECT is((SELECT count(*)::INT FROM automations), 2, 'suspended: automations still listed (nothing deleted)');
SELECT lives_ok($$SELECT * FROM billing_my_usage()$$, 'suspended: usage / billing still readable');
-- ---------------------------------------------------------------- suspended: what is blocked
SELECT throws_ok($$INSERT INTO automations (user_id, account_id, name, trigger_type) SELECT owner, acc, 'Bloq', 'new_contact_created' FROM ids$$,
                 'TR403', 'tenant_restricted', 'suspended: new automation refused');
SELECT throws_ok($$UPDATE automations SET is_active = true WHERE name = 'Boas-vindas'$$,
                 'TR403', 'tenant_restricted', 'suspended: switching an automation on refused');
SELECT lives_ok($$UPDATE automations SET is_active = false$$, 'suspended: switching automations off is allowed');
SELECT throws_ok($$INSERT INTO broadcasts (user_id, account_id, name, template_name, status) SELECT owner, acc, 'Promo', 'hello', 'sending' FROM ids$$,
                 'TR403', 'tenant_restricted', 'suspended: starting a campaign refused');
SELECT lives_ok($$INSERT INTO broadcasts (user_id, account_id, name, template_name, status) SELECT owner, acc, 'Rascunho', 'hello', 'draft' FROM ids$$,
                'suspended: a draft campaign can still be prepared');
SELECT throws_ok($$UPDATE broadcasts SET status = 'scheduled' WHERE name = 'Rascunho'$$,
                 'TR403', 'tenant_restricted', 'suspended: scheduling a campaign refused');
RESET role;
SELECT throws_ok($$INSERT INTO api_keys (account_id, created_by, name, key_hash, key_prefix, scopes)
                   SELECT acc, owner, 'k', repeat('a', 64), 'wacrm_live_x', ARRAY['contacts:read'] FROM ids$$,
                 'TR403', 'tenant_restricted', 'suspended: new API key refused (also via service role)');
SELECT throws_ok($$SELECT tenant_assert_can((SELECT acc FROM ids), 'messages.send')$$, 'TR403', 'tenant_restricted',
                 'suspended: sending refused');
SELECT is(account_can((SELECT acc FROM ids), 'messages.send'), false, 'account_can reflects the policy');
SELECT is(account_is_operational((SELECT acc FROM ids)), false, '906 compatibility: not operational');

-- ---------------------------------------------------------------- payment lifts a billing suspension
UPDATE accounts SET status = 'active' WHERE id = (SELECT acc FROM ids);
SELECT is((SELECT count(*)::INT FROM billing_delinquency WHERE account_id = (SELECT acc FROM ids)), 0, 'reactivation clears the delinquency record');
SELECT is((SELECT action FROM platform_audit_log WHERE target_account_id = (SELECT acc FROM ids) ORDER BY id DESC LIMIT 1),
          'organization.billing_reactivated', 'reactivation after payment is audited');
SELECT lives_ok($$UPDATE automations SET is_active = true WHERE name = 'Boas-vindas'$$, 'active again: automations can be switched on');

-- ---------------------------------------------------------------- suspension by the team
UPDATE accounts SET status = 'suspended' WHERE id = (SELECT acc FROM ids);
SELECT is((SELECT suspended_by FROM billing_delinquency WHERE account_id = (SELECT acc FROM ids)), 'platform',
          'a suspension not made by billing is recorded as the team''s');
SELECT is((billing_access_state((SELECT acc FROM ids)))->>'suspended_by', 'platform', 'billing_access_state exposes who suspended');
-- team reactivates to past_due → a fresh grace period
UPDATE billing_delinquency SET past_due_since = now() - interval '30 days' WHERE account_id = (SELECT acc FROM ids);
UPDATE accounts SET status = 'past_due' WHERE id = (SELECT acc FROM ids);
SELECT ok((SELECT past_due_since > now() - interval '1 minute' FROM billing_delinquency WHERE account_id = (SELECT acc FROM ids)),
          'back from a suspension to past_due starts a new grace period');
SELECT is(billing_enforce_delinquency(7), 0, 'and is not re-suspended immediately');

-- ---------------------------------------------------------------- never deletes
SELECT is((SELECT count(*)::INT FROM contacts WHERE account_id = (SELECT acc FROM ids)), 1, 'nothing was deleted along the way');

-- ---------------------------------------------------------------- privileges
SELECT pg_temp.login((SELECT owner FROM ids));
SELECT throws_ok($$SELECT billing_enforce_delinquency(0)$$, '42501', NULL, 'clients cannot run the enforcement');
SELECT throws_ok($$SELECT * FROM billing_delinquency$$, '42501', NULL, 'delinquency bookkeeping is server-only');
SELECT throws_ok($$UPDATE accounts SET status = 'active' WHERE id = (SELECT acc FROM ids)$$, NULL, NULL,
                 'a member cannot lift the status by hand');
RESET role;

SELECT * FROM finish();
ROLLBACK;
