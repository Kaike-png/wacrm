-- 910_billing_asaas (fork, docs/BILLING.md, docs/ASAAS.md)
--
-- What the first real gateway needed from the gateway-neutral schema:
--   * boleto data on payments (linha digitável + PDF link);
--   * an atomic claim for webhook events, so the same gateway event is
--     never processed twice — not even when two deliveries arrive at the
--     same time (Asaas delivers "at least once").
-- Idempotent.

ALTER TABLE public.billing_payments
  ADD COLUMN IF NOT EXISTS boleto_digitable_line TEXT CHECK (char_length(boleto_digitable_line) <= 100),
  ADD COLUMN IF NOT EXISTS boleto_url            TEXT CHECK (char_length(boleto_url) <= 1000);

-- 'processing' = claimed by one request right now.
ALTER TABLE public.billing_webhook_events
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE public.billing_webhook_events DROP CONSTRAINT IF EXISTS billing_webhook_events_status_check;
ALTER TABLE public.billing_webhook_events
  ADD CONSTRAINT billing_webhook_events_status_check
  CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'failed'));

-- Claim an event for processing. One statement (INSERT … ON CONFLICT … WHERE),
-- so concurrent deliveries of the same (provider, event_id) serialize on the
-- unique index and exactly one of them gets 'claimed'.
--   claimed      → process it, then billing_finish_webhook_event
--   duplicate    → already processed / ignored: answer 200, do nothing
--   in_progress  → another request holds it (claim younger than 5 min)
-- A failed event, or a claim abandoned for 5+ minutes (process killed), can
-- be claimed again by the gateway's next retry.
CREATE OR REPLACE FUNCTION public.billing_claim_webhook_event(
  p_provider TEXT, p_event_id TEXT, p_type TEXT, p_account UUID, p_payment TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id BIGINT; v_status TEXT;
BEGIN
  INSERT INTO billing_webhook_events AS e
    (provider, event_id, type, account_id, payment_external_id, status, claimed_at)
  VALUES (p_provider, p_event_id, left(p_type, 60), p_account, p_payment, 'processing', now())
  ON CONFLICT (provider, event_id) DO UPDATE
    SET status = 'processing', claimed_at = now(), attempts = e.attempts + 1,
        account_id = COALESCE(EXCLUDED.account_id, e.account_id), error = NULL
    WHERE e.status IN ('received', 'failed')
       OR (e.status = 'processing' AND e.claimed_at < now() - interval '5 minutes')
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN 'claimed'; END IF;

  SELECT status INTO v_status FROM billing_webhook_events WHERE provider = p_provider AND event_id = p_event_id;
  UPDATE billing_webhook_events SET attempts = attempts + 1 WHERE provider = p_provider AND event_id = p_event_id;
  RETURN CASE WHEN v_status = 'processing' THEN 'in_progress' ELSE 'duplicate' END;
END $$;

CREATE OR REPLACE FUNCTION public.billing_finish_webhook_event(
  p_provider TEXT, p_event_id TEXT, p_status TEXT, p_error TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('processed', 'ignored', 'failed') THEN
    RAISE EXCEPTION 'invalid final status %', p_status;
  END IF;
  UPDATE billing_webhook_events
     SET status = p_status, error = left(p_error, 500),
         processed_at = CASE WHEN p_status = 'failed' THEN processed_at ELSE now() END
   WHERE provider = p_provider AND event_id = p_event_id AND status = 'processing';
END $$;

REVOKE EXECUTE ON FUNCTION public.billing_claim_webhook_event(TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.billing_finish_webhook_event(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_claim_webhook_event(TEXT, TEXT, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_finish_webhook_event(TEXT, TEXT, TEXT, TEXT) TO service_role;
