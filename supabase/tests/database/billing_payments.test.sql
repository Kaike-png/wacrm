-- Payments (fork, docs/BILLING.md) — pgTAP. Gateway-neutral storage:
-- who can read what, idempotency keys, end of canceled subscriptions,
-- audited price edits. Runs with `npm run test:db`. Rolled back.

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
  ('ffffffff-5555-4000-8000-000000000001'::UUID, 'owner@pay.test'),
  ('ffffffff-5555-4000-8000-000000000002'::UUID, 'agent@pay.test'),
  ('ffffffff-5555-4000-8000-000000000003'::UUID, 'other@pay.test'),
  ('ffffffff-5555-4000-8000-000000000009'::UUID, 'staff@pay.test')
) AS u(id, email);

CREATE TEMP TABLE ids AS SELECT
  (SELECT account_id FROM profiles WHERE user_id = 'ffffffff-5555-4000-8000-000000000001') AS acc,
  (SELECT account_id FROM profiles WHERE user_id = 'ffffffff-5555-4000-8000-000000000003') AS acc_other,
  'ffffffff-5555-4000-8000-000000000001'::UUID AS owner,
  'ffffffff-5555-4000-8000-000000000002'::UUID AS agent,
  'ffffffff-5555-4000-8000-000000000003'::UUID AS other,
  'ffffffff-5555-4000-8000-000000000009'::UUID AS staff;
GRANT SELECT ON ids TO PUBLIC;
UPDATE profiles SET account_id = (SELECT acc FROM ids), account_role = 'agent' WHERE user_id = (SELECT agent FROM ids);
SELECT public.platform_grant_admin('staff@pay.test', 'pgtap');

-- ---------------------------------------------------------------- schema
SELECT has_column('billing_plans', 'price_cents', 'plans have a price');
SELECT has_column('billing_subscriptions', 'pending_plan_code', 'subscriptions track a pending plan change');

-- ---------------------------------------------------------------- data
INSERT INTO billing_customers (account_id, provider, external_id) SELECT acc, 'mock', 'cus_1' FROM ids;
INSERT INTO billing_payments (account_id, provider, external_id, method, status, amount_cents, pix_copy_paste)
SELECT acc, 'mock', 'pay_1', 'pix', 'pending', 19990, '000201…' FROM ids;
INSERT INTO billing_payments (account_id, provider, external_id, method, status, amount_cents)
SELECT acc_other, 'mock', 'pay_2', 'pix', 'paid', 19990 FROM ids;
INSERT INTO billing_webhook_events (provider, event_id, type) VALUES ('mock', 'evt_1', 'payment.updated');

SELECT throws_ok($$INSERT INTO billing_payments (account_id, provider, external_id, method, status, amount_cents)
                   SELECT acc, 'mock', 'pay_1', 'pix', 'paid', 1 FROM ids$$,
                 '23505', NULL, 'a gateway payment id is stored once (upsert key)');
SELECT throws_ok($$INSERT INTO billing_webhook_events (provider, event_id, type) VALUES ('mock', 'evt_1', 'payment.updated')$$,
                 '23505', NULL, 'a gateway event is processed once (idempotency key)');
SELECT lives_ok($$INSERT INTO billing_webhook_events (provider, event_id, type) VALUES ('asaas', 'evt_1', 'payment.updated')$$,
                'the same event id from another gateway is a different event');
SELECT throws_ok($$INSERT INTO billing_payments (account_id, provider, external_id, method, status, amount_cents)
                   SELECT acc, 'mock', 'pay_x', 'pix', 'approved', 1 FROM ids$$,
                 '23514', NULL, 'only normalized statuses are stored (no gateway vocabulary)');
SELECT throws_ok($$INSERT INTO billing_payments (account_id, provider, external_id, method, status, amount_cents)
                   SELECT acc, 'mock', 'pay_y', 'pix', 'pending', -1 FROM ids$$,
                 '23514', NULL, 'amounts are non-negative cents');

-- ---------------------------------------------------------------- access
SELECT pg_temp.login((SELECT owner FROM ids));
SELECT is((SELECT count(*)::INT FROM billing_payments), 1, 'owner sees only their organization''s payments');
SELECT is((SELECT pix_copy_paste FROM billing_payments), '000201…', 'owner reads the Pix code to pay');
SELECT throws_ok($$SELECT * FROM billing_customers$$, '42501', NULL, 'gateway customer ids are server-only');
SELECT throws_ok($$SELECT * FROM billing_webhook_events$$, '42501', NULL, 'webhook trail is server-only');
SELECT throws_ok($$UPDATE billing_payments SET status = 'paid'$$, '42501', NULL, 'a client cannot mark a payment as paid');
SELECT throws_ok($$INSERT INTO billing_payments (account_id, provider, external_id, method, status, amount_cents)
                   SELECT acc, 'mock', 'forged', 'pix', 'paid', 0 FROM ids$$, '42501', NULL, 'a client cannot forge a payment');
SELECT throws_ok($$UPDATE billing_subscriptions SET status = 'active'$$, '42501', NULL,
                 'a client cannot activate its own subscription');
SELECT throws_ok($$SELECT billing_expire_subscriptions()$$, '42501', NULL, 'expiry runs only from the server');
RESET role;

SELECT pg_temp.login((SELECT agent FROM ids));
SELECT is((SELECT count(*)::INT FROM billing_payments), 0, 'agents do not see billing');
RESET role;

-- ---------------------------------------------------------------- expiry
UPDATE billing_plans SET is_default = (code = 'start') WHERE code IN ('start', 'pro', 'business');
INSERT INTO billing_subscriptions (account_id, plan_code, status, provider, external_id, current_period_end, cancel_at_period_end)
SELECT acc, 'pro', 'canceled', 'mock', 'sub_1', now() - interval '1 minute', true FROM ids
ON CONFLICT (account_id) DO UPDATE SET plan_code = EXCLUDED.plan_code, status = EXCLUDED.status, provider = EXCLUDED.provider,
  external_id = EXCLUDED.external_id, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = true;
INSERT INTO billing_subscriptions (account_id, plan_code, status, provider, external_id, current_period_end, cancel_at_period_end)
SELECT acc_other, 'pro', 'canceled', 'mock', 'sub_2', now() + interval '10 days', true FROM ids
ON CONFLICT (account_id) DO UPDATE SET plan_code = EXCLUDED.plan_code, status = EXCLUDED.status, provider = EXCLUDED.provider,
  external_id = EXCLUDED.external_id, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = true;

SELECT ok(billing_expire_subscriptions() >= 1, 'expiry runs');
SELECT results_eq($$SELECT plan_code, status, external_id FROM billing_subscriptions WHERE account_id = (SELECT acc FROM ids)$$,
                  $$VALUES ('start'::TEXT, 'manual'::TEXT, NULL::TEXT)$$,
                  'canceled and period over → default plan, no gateway subscription');
SELECT results_eq($$SELECT plan_code, status FROM billing_subscriptions WHERE account_id = (SELECT acc_other FROM ids)$$,
                  $$VALUES ('pro'::TEXT, 'canceled'::TEXT)$$,
                  'canceled but still within the paid period → keeps the plan');
SELECT is((SELECT count(*)::INT FROM contacts WHERE account_id = (SELECT acc FROM ids)), 0, '(sanity) expiry deletes nothing');

-- ---------------------------------------------------------------- price edit
SELECT throws_ok($$SELECT platform_update_plan_price('pro', 100, (SELECT owner FROM ids), 'x')$$,
                 '42501', NULL, 'only platform admins change prices');
SELECT lives_ok($$SELECT platform_update_plan_price('pro', 12345, (SELECT staff FROM ids), 'lançamento')$$, 'admin sets a price');
SELECT is((SELECT price_cents FROM billing_plans WHERE code = 'pro'), 12345::BIGINT, 'price stored in cents');
SELECT is((SELECT details->'to'->>'price_cents' FROM platform_audit_log
           WHERE action = 'billing_plan.updated' AND actor_user_id = (SELECT staff FROM ids) ORDER BY id DESC LIMIT 1),
          '12345', 'price change is audited');
SELECT is((SELECT (p->>'price_cents')::BIGINT FROM jsonb_array_elements(platform_list_plans()->'plans') p WHERE p->>'code' = 'pro'),
          12345::BIGINT, 'panel catalog exposes the price');

SELECT * FROM finish();
ROLLBACK;
