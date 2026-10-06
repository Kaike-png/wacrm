-- Webhook idempotency (fork, 910, docs/ASAAS.md) — pgTAP. Rolled back.
-- The same gateway event is processed once, also under concurrent delivery.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

DELETE FROM billing_webhook_events WHERE provider = 'asaas' AND event_id LIKE 'evt_pgtap%';

SELECT is(billing_claim_webhook_event('asaas', 'evt_pgtap_1&1', 'payment.updated', NULL, 'pay_1'), 'claimed',
          'first delivery claims the event');
SELECT is(billing_claim_webhook_event('asaas', 'evt_pgtap_1&1', 'payment.updated', NULL, 'pay_1'), 'in_progress',
          'a concurrent delivery while it is being processed does not process it');
SELECT lives_ok($$SELECT billing_finish_webhook_event('asaas', 'evt_pgtap_1&1', 'processed')$$, 'finish');
SELECT is(billing_claim_webhook_event('asaas', 'evt_pgtap_1&1', 'payment.updated', NULL, 'pay_1'), 'duplicate',
          're-delivery after processing is a duplicate');
SELECT is((SELECT attempts FROM billing_webhook_events WHERE event_id = 'evt_pgtap_1&1'), 3, 'every delivery is counted');
SELECT is((SELECT count(*)::INT FROM billing_webhook_events WHERE event_id = 'evt_pgtap_1&1'), 1, 'one row per event');

SELECT is(billing_claim_webhook_event('mock', 'evt_pgtap_1&1', 'payment.updated', NULL, NULL), 'claimed',
          'same id from another gateway is another event');

-- Failure → the gateway's retry may claim it again
SELECT billing_claim_webhook_event('asaas', 'evt_pgtap_2', 'payment.updated', NULL, NULL);
SELECT billing_finish_webhook_event('asaas', 'evt_pgtap_2', 'failed', 'boom');
SELECT is((SELECT status || ':' || error FROM billing_webhook_events WHERE event_id = 'evt_pgtap_2'), 'failed:boom', 'failure recorded');
SELECT is(billing_claim_webhook_event('asaas', 'evt_pgtap_2', 'payment.updated', NULL, NULL), 'claimed', 'failed event is retried');
SELECT billing_finish_webhook_event('asaas', 'evt_pgtap_2', 'processed');
SELECT is(billing_claim_webhook_event('asaas', 'evt_pgtap_2', 'payment.updated', NULL, NULL), 'duplicate', 'then never again');

-- Ignored (no organization) is final too
SELECT billing_claim_webhook_event('asaas', 'evt_pgtap_3', 'payment.updated', NULL, NULL);
SELECT billing_finish_webhook_event('asaas', 'evt_pgtap_3', 'ignored', 'no organization');
SELECT is(billing_claim_webhook_event('asaas', 'evt_pgtap_3', 'payment.updated', NULL, NULL), 'duplicate', 'ignored is final');

-- A claim abandoned by a crashed process expires after 5 minutes
SELECT billing_claim_webhook_event('asaas', 'evt_pgtap_4', 'payment.updated', NULL, NULL);
UPDATE billing_webhook_events SET claimed_at = now() - interval '6 minutes' WHERE event_id = 'evt_pgtap_4';
SELECT is(billing_claim_webhook_event('asaas', 'evt_pgtap_4', 'payment.updated', NULL, NULL), 'claimed', 'stale claim can be taken over');

-- finish only acts on a claimed row
SELECT billing_finish_webhook_event('asaas', 'evt_pgtap_1&1', 'failed', 'late');
SELECT is((SELECT status FROM billing_webhook_events WHERE provider = 'asaas' AND event_id = 'evt_pgtap_1&1'), 'processed',
          'a late finish cannot reopen a processed event');
SELECT throws_ok($$SELECT billing_finish_webhook_event('asaas', 'evt_pgtap_4', 'processing')$$, 'P0001', NULL, 'only final statuses');

-- Clients cannot touch the claim
SET LOCAL role authenticated;
SELECT throws_ok($$SELECT billing_claim_webhook_event('asaas', 'x', 'payment.updated', NULL, NULL)$$, '42501', NULL,
                 'claim is server-only');
RESET role;

SELECT has_column('billing_payments', 'boleto_digitable_line', 'payments store the linha digitável');

SELECT * FROM finish();
ROLLBACK;
