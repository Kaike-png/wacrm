-- Foundation hardening (fork, 912, docs/MVP_FOUNDATION_AUDIT.md) — pgTAP. Rolled back.
--
--   * organization state machine (no absurd transitions, for any writer);
--   * payment confirmation is atomic and idempotent (1×, 2×, 10×);
--   * stale / out-of-order effects never regress state;
--   * team reactivation after a billing suspension restores past_due;
--   * new functions are server-only.
-- Concurrency of plan limits is covered by scripts/fork/test-db-race.sh
-- (needs several sessions; pgTAP runs in one).

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}', now(), now()
FROM (VALUES
  ('dddddddd-9120-4000-8000-000000000001'::UUID, 'owner-a@fh.test'),
  ('dddddddd-9120-4000-8000-000000000002'::UUID, 'owner-b@fh.test'),
  ('dddddddd-9120-4000-8000-000000000009'::UUID, 'staff@fh.test')
) AS u(id, email);
CREATE TEMP TABLE ids AS SELECT
  (SELECT account_id FROM profiles WHERE user_id = 'dddddddd-9120-4000-8000-000000000001') AS acc,
  (SELECT account_id FROM profiles WHERE user_id = 'dddddddd-9120-4000-8000-000000000002') AS acc_b,
  'dddddddd-9120-4000-8000-000000000001'::UUID AS owner,
  'dddddddd-9120-4000-8000-000000000009'::UUID AS staff;
GRANT SELECT ON ids TO PUBLIC;
SELECT public.platform_grant_admin('staff@fh.test', 'pgtap');
-- WhatsApp connected while the organization is in good standing
INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, access_token)
SELECT owner, acc, 'fh-phone-1', 'x' FROM ids;

-- ------------------------------------------------------------------ state machine
SELECT is((SELECT status FROM accounts WHERE id = (SELECT acc FROM ids)), 'trial', 'new organization starts in trial');
UPDATE accounts SET status = 'active' WHERE id = (SELECT acc FROM ids);
SELECT throws_ok($$UPDATE accounts SET status = 'trial' WHERE id = (SELECT acc FROM ids)$$, '23514', NULL,
                 'active → trial is refused (even for the service role / owner)');
UPDATE accounts SET status = 'cancelled' WHERE id = (SELECT acc_b FROM ids);
SELECT throws_ok($$UPDATE accounts SET status = 'past_due' WHERE id = (SELECT acc_b FROM ids)$$, '23514', NULL,
                 'cancelled → past_due is refused');
SELECT throws_ok($$UPDATE accounts SET status = 'trial' WHERE id = (SELECT acc_b FROM ids)$$, '23514', NULL,
                 'cancelled → trial is refused');
SELECT lives_ok($$UPDATE accounts SET status = 'active' WHERE id = (SELECT acc_b FROM ids)$$, 'cancelled → active (team) is allowed');
SELECT lives_ok($$UPDATE accounts SET name = name WHERE id = (SELECT acc FROM ids)$$, 'updates without a status change are untouched');
SELECT ok(account_status_transition_allowed('past_due', 'past_due'), 'same status is not a transition');

-- ------------------------------------------------------------------ fixtures for billing
-- Organization A: active on START, paying a plan change to PRO (pending sub_new)
UPDATE billing_subscriptions SET plan_code = 'start', status = 'manual', provider = 'mock',
       external_id = NULL, pending_external_id = 'sub_fh_new', pending_plan_code = 'pro',
       current_period_end = NULL, updated_at = '2026-01-01T00:00:00Z'
 WHERE account_id = (SELECT acc FROM ids);
UPDATE accounts SET status = 'past_due' WHERE id = (SELECT acc FROM ids);

CREATE TEMP TABLE pay AS SELECT jsonb_build_object(
  'account_id', (SELECT acc FROM ids), 'provider', 'mock', 'external_id', 'pay_fh_1',
  'subscription_external_id', 'sub_fh_new', 'plan_code', 'pro', 'method', 'pix', 'status', 'paid',
  'amount_cents', 19990, 'currency', 'BRL', 'paid_at', '2026-10-06T12:00:00Z') AS paid;
CREATE TEMP TABLE activation AS SELECT jsonb_build_object(
  'plan_code', 'pro', 'status', 'active', 'external_id', 'sub_fh_new', 'provider', 'mock',
  'pending_external_id', NULL, 'pending_plan_code', NULL,
  'current_period_end', '2026-11-06T12:00:00Z', 'cancel_at_period_end', false, 'canceled_at', NULL) AS changes;

-- 1st delivery: decided from (payment absent, subscription @ 2026-01-01, org past_due)
SELECT lives_ok($$SELECT billing_apply_effects((SELECT acc FROM ids), 'mock', (SELECT paid FROM pay), NULL,
                 (SELECT changes FROM activation), '2026-01-01T00:00:00Z', 'past_due', 'active')$$,
                'payment confirmation applies');
SELECT results_eq(
  $$SELECT s.plan_code, s.status, s.external_id, s.pending_external_id, a.status
      FROM billing_subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.account_id = (SELECT acc FROM ids)$$,
  $$VALUES ('pro'::TEXT, 'active'::TEXT, 'sub_fh_new'::TEXT, NULL::TEXT, 'active'::TEXT)$$,
  'plan switched, subscription active, organization reopened — in one transaction');

-- 2nd…10th delivery of the SAME decision (stale state): refused as a conflict, nothing changes
CREATE TEMP TABLE snap AS SELECT s.*, a.status AS org FROM billing_subscriptions s JOIN accounts a ON a.id = s.account_id
 WHERE s.account_id = (SELECT acc FROM ids);
CREATE FUNCTION pg_temp.replay(n INT) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE i INT; conflicts INT := 0;
BEGIN
  FOR i IN 1..n LOOP
    BEGIN
      PERFORM billing_apply_effects((SELECT acc FROM ids), 'mock', (SELECT paid FROM pay), NULL,
        (SELECT changes FROM activation), '2026-01-01T00:00:00Z', 'past_due', 'active');
    EXCEPTION WHEN serialization_failure THEN conflicts := conflicts + 1;
    END;
  END LOOP;
  RETURN conflicts;
END $$;
SELECT is(pg_temp.replay(9), 9, 'the same decision replayed 9 more times (10 total) is refused every time');
SELECT is((SELECT count(*)::INT FROM billing_payments WHERE provider = 'mock' AND external_id = 'pay_fh_1'), 1,
          'one payment row');
SELECT ok((SELECT s.updated_at = snap.updated_at AND s.current_period_end = snap.current_period_end
             FROM billing_subscriptions s, snap WHERE s.account_id = snap.account_id),
          'subscription untouched by the replays (period not extended twice)');

-- A different event for the same payment decided from the OLD payment state (CONFIRMED vs RECEIVED race)
SELECT throws_ok($$SELECT billing_apply_effects((SELECT acc FROM ids), 'mock', (SELECT paid FROM pay), 'pending',
                   jsonb_build_object('current_period_end', '2026-12-06T12:00:00Z'),
                   (SELECT updated_at FROM snap), NULL, NULL)$$,
                 '40001', NULL, 'second event for a payment already paid cannot grant another period');
SELECT is((SELECT current_period_end FROM billing_subscriptions WHERE account_id = (SELECT acc FROM ids)),
          '2026-11-06T12:00:00Z'::TIMESTAMPTZ, 'period unchanged');

-- Re-delivery decided from the CURRENT state records the payment only (rules: prev = status)
SELECT lives_ok($$SELECT billing_apply_effects((SELECT acc FROM ids), 'mock', (SELECT paid FROM pay), 'paid',
                  NULL, NULL, NULL, NULL)$$, 'idempotent re-delivery (record only)');

-- Out of order: a late "pending/overdue" never regresses a paid payment (also via plain upsert)
SELECT lives_ok($$SELECT billing_apply_effects((SELECT acc FROM ids), 'mock',
                  (SELECT paid || '{"status":"overdue","paid_at":null}'::jsonb FROM pay), 'paid', NULL, NULL, NULL, NULL)$$,
                'late overdue event is accepted…');
SELECT is((SELECT status || ':' || (paid_at IS NOT NULL) FROM billing_payments WHERE external_id = 'pay_fh_1'),
          'paid:true', '…but the payment stays paid');
UPDATE billing_payments SET status = 'pending', paid_at = NULL WHERE external_id = 'pay_fh_1';
SELECT is((SELECT status FROM billing_payments WHERE external_id = 'pay_fh_1'), 'paid', 'direct writes cannot regress it either');
SELECT lives_ok($$UPDATE billing_payments SET status = 'refunded' WHERE external_id = 'pay_fh_1'$$, 'paid → refunded still possible');

-- A suspension made meanwhile is never overwritten by a payment decision
SELECT * FROM platform_set_account_status((SELECT acc FROM ids), 'suspend', (SELECT staff FROM ids), 'fraude');
SELECT lives_ok($$SELECT billing_apply_effects((SELECT acc FROM ids), 'mock', NULL, NULL, NULL, NULL, 'active', 'past_due')$$,
                'status change decided from a stale status…');
SELECT is((SELECT status FROM accounts WHERE id = (SELECT acc FROM ids)), 'suspended', '…does not touch the suspension');

-- Payment for another organization cannot be written through this organization
SELECT throws_ok($$SELECT billing_apply_effects((SELECT acc_b FROM ids), 'mock', (SELECT paid FROM pay), 'refunded', NULL, NULL, NULL, NULL)$$,
                 '22023', NULL, 'payment row must belong to the organization');

-- ------------------------------------------------------------------ reactivation after billing suspension
SELECT * FROM platform_set_account_status((SELECT acc FROM ids), 'reactivate', (SELECT staff FROM ids), 'ok');
SELECT is((SELECT status FROM accounts WHERE id = (SELECT acc FROM ids)), 'active', 'team reactivation restores active');
UPDATE accounts SET status = 'past_due' WHERE id = (SELECT acc FROM ids);
UPDATE billing_delinquency SET past_due_since = now() - interval '30 days' WHERE account_id = (SELECT acc FROM ids);
SELECT ok(billing_enforce_delinquency(7) >= 1, 'billing suspends after the grace period');
SELECT is((SELECT new_status FROM platform_set_account_status((SELECT acc FROM ids), 'reactivate', (SELECT staff FROM ids), 'acordo')),
          'past_due', 'team reactivation of a BILLING suspension restores past_due (not an older team suspension''s status)');


-- ------------------------------------------------------------------ suspension: update paths
-- acc is past_due at this point (team reactivation above); suspend it again
SELECT * FROM platform_set_account_status((SELECT acc FROM ids), 'suspend', (SELECT staff FROM ids), 'teste');
SELECT throws_ok($$UPDATE whatsapp_config SET phone_number_id = 'fh-phone-2' WHERE account_id = (SELECT acc FROM ids)$$,
                 'TR403', NULL, 'suspended: swapping the WhatsApp number is refused');
SELECT lives_ok($$UPDATE whatsapp_config SET updated_at = now() WHERE account_id = (SELECT acc FROM ids)$$,
                'suspended: editing other settings still works');

-- ------------------------------------------------------------------ trial end
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000', 'dddddddd-9120-4000-8000-000000000003', 'authenticated', 'authenticated',
        'trial@fh.test', '', now(), '{}', now(), now());
CREATE TEMP TABLE t AS SELECT account_id AS acc FROM profiles WHERE user_id = 'dddddddd-9120-4000-8000-000000000003';
SELECT is((SELECT date_trunc('minute', trial_ends_at) FROM accounts WHERE id = (SELECT acc FROM t)),
          date_trunc('minute', now() + make_interval(days => billing_default_trial_days())),
          'a new organization gets trial_ends_at = now + trial_days of the default plan');
SELECT is(billing_expire_trials() >= 0, true, 'nothing to expire yet is fine');
SELECT is((SELECT status FROM accounts WHERE id = (SELECT acc FROM t)), 'trial', 'trial running: untouched');
UPDATE accounts SET trial_ends_at = now() - interval '1 minute' WHERE id = (SELECT acc FROM t);
SELECT ok(billing_expire_trials() >= 1, 'expired trial is processed');
SELECT is((SELECT status FROM accounts WHERE id = (SELECT acc FROM t)), 'past_due', 'expired trial → past_due (grace + payment)');
SELECT ok((SELECT past_due_since IS NOT NULL FROM billing_delinquency WHERE account_id = (SELECT acc FROM t)),
          'grace period starts at the trial end');
SELECT is(billing_expire_trials(), 0, 'idempotent');
SELECT ok((SELECT count(*) FROM contacts WHERE account_id = (SELECT acc FROM t)) = 0
          AND EXISTS (SELECT 1 FROM accounts WHERE id = (SELECT acc FROM t)), 'nothing deleted');

-- ------------------------------------------------------------------ server-only
SET LOCAL role authenticated;
SELECT throws_ok($$SELECT billing_apply_effects(NULL, 'mock', NULL, NULL, NULL, NULL, NULL, NULL)$$, '42501', NULL,
                 'clients cannot apply billing effects');
SELECT throws_ok($$SELECT _billing_limit_lock(NULL, 'max_users')$$, '42501', NULL, 'clients cannot take limit locks');
SELECT throws_ok($$SELECT billing_expire_trials()$$, '42501', NULL, 'clients cannot expire trials');
RESET role;

SELECT * FROM finish();
ROLLBACK;
