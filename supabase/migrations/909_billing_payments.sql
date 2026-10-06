-- 909_billing_payments (fork, docs/BILLING.md)
--
-- Payments without tying the product to a gateway. The database stores
-- only gateway-neutral facts; which gateway produced them is a column.
--
--   billing_plans          + price_cents / currency / billing_interval
--   billing_subscriptions  + provider, status (manual | pending | active |
--                            past_due | canceled), pending_plan_code /
--                            pending_external_id (a plan change waiting for
--                            its first payment), cancel_at_period_end,
--                            canceled_at
--   billing_customers      organization ↔ customer id in each gateway
--   billing_payments       charges (Pix / boleto / card), normalized status,
--                          Pix "copia e cola" — readable by org admins
--   billing_webhook_events idempotency + trail of gateway notifications
--                          (normalized summary only, never the raw payload)
--
-- Rules (src/billing/payments/rules.ts) are gateway-agnostic; adapters
-- only translate (src/billing/providers/*, src/integrations/payments/*).
-- Idempotent.

-- ------------------------------------------------------------------
-- Prices
-- ------------------------------------------------------------------

ALTER TABLE public.billing_plans
  ADD COLUMN IF NOT EXISTS price_cents      BIGINT CHECK (price_cents >= 0),
  ADD COLUMN IF NOT EXISTS currency         TEXT NOT NULL DEFAULT 'BRL' CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN IF NOT EXISTS billing_interval TEXT NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year'));
-- No price = cannot be bought online (assigned by hand in the panel only).

-- ------------------------------------------------------------------
-- Subscription state
-- ------------------------------------------------------------------

ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS provider             TEXT CHECK (provider ~ '^[a-z][a-z0-9_-]{0,30}$'),
  ADD COLUMN IF NOT EXISTS status               TEXT NOT NULL DEFAULT 'manual'
                                                  CHECK (status IN ('manual', 'pending', 'active', 'past_due', 'canceled')),
  ADD COLUMN IF NOT EXISTS pending_plan_code    TEXT REFERENCES public.billing_plans(code) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS pending_external_id  TEXT CHECK (char_length(pending_external_id) <= 200),
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS canceled_at          TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_provider_external
  ON public.billing_subscriptions (provider, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_provider_pending
  ON public.billing_subscriptions (provider, pending_external_id) WHERE pending_external_id IS NOT NULL;
GRANT SELECT (status, pending_plan_code, cancel_at_period_end, canceled_at, provider)
  ON public.billing_subscriptions TO authenticated;

-- ------------------------------------------------------------------
-- Customers, payments, webhook events
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.billing_customers (
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,30}$'),
  external_id TEXT NOT NULL CHECK (char_length(external_id) <= 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider),
  UNIQUE (provider, external_id)
);

CREATE TABLE IF NOT EXISTS public.billing_payments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider                 TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,30}$'),
  external_id              TEXT NOT NULL CHECK (char_length(external_id) <= 200),
  subscription_external_id TEXT CHECK (char_length(subscription_external_id) <= 200),
  plan_code                TEXT,
  method                   TEXT NOT NULL CHECK (method IN ('pix', 'boleto', 'card', 'other')),
  status                   TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'overdue', 'refunded', 'canceled', 'failed')),
  amount_cents             BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency                 TEXT NOT NULL DEFAULT 'BRL' CHECK (currency ~ '^[A-Z]{3}$'),
  description              TEXT CHECK (char_length(description) <= 300),
  due_date                 DATE,
  paid_at                  TIMESTAMPTZ,
  period_start             TIMESTAMPTZ,
  period_end               TIMESTAMPTZ,
  pix_copy_paste           TEXT CHECK (char_length(pix_copy_paste) <= 1000),
  -- data: URL (base64 PNG) or https URL from the gateway.
  pix_qr_image             TEXT CHECK (char_length(pix_qr_image) <= 200000),
  pix_expires_at           TIMESTAMPTZ,
  invoice_url              TEXT CHECK (char_length(invoice_url) <= 1000),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_payments_account ON public.billing_payments (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider            TEXT NOT NULL,
  event_id            TEXT NOT NULL CHECK (char_length(event_id) <= 200),
  type                TEXT NOT NULL CHECK (char_length(type) <= 60),
  account_id          UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  payment_external_id TEXT,
  status              TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error               TEXT CHECK (char_length(error) <= 500),
  attempts            INT NOT NULL DEFAULT 1,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ,
  UNIQUE (provider, event_id)
);

ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_customers, public.billing_payments, public.billing_webhook_events
  FROM PUBLIC, anon, authenticated;

-- Payments: the organization's admins see their charges (and the Pix code
-- to pay them). Customers and webhook events: server only.
GRANT SELECT ON public.billing_payments TO authenticated;
DROP POLICY IF EXISTS billing_payments_admin_read ON public.billing_payments;
CREATE POLICY billing_payments_admin_read ON public.billing_payments
  FOR SELECT TO authenticated USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------------
-- End of a canceled subscription → back to the default plan
-- (scheduled: GET /api/billing/cron)
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.billing_expire_subscriptions()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_default TEXT; n INT;
BEGIN
  SELECT code INTO v_default FROM billing_plans WHERE is_default AND is_active;
  UPDATE billing_subscriptions s
     SET plan_code = COALESCE(v_default, s.plan_code),
         status = 'manual', provider = NULL, external_id = NULL,
         cancel_at_period_end = false, current_period_end = NULL, updated_at = now()
   WHERE s.status = 'canceled'
     AND (s.current_period_end IS NULL OR s.current_period_end <= now());
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION public.billing_expire_subscriptions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_expire_subscriptions() TO service_role;

-- Price edit from the platform panel (audited like the rest of the plan).
CREATE OR REPLACE FUNCTION public.platform_update_plan_price(
  p_plan TEXT, p_price_cents BIGINT, p_actor UUID, p_reason TEXT,
  p_ip TEXT DEFAULT NULL, p_user_agent TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_from BIGINT;
BEGIN
  IF NOT platform_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not a platform admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT price_cents INTO v_from FROM billing_plans WHERE code = p_plan FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_from IS NOT DISTINCT FROM p_price_cents THEN RETURN; END IF;
  UPDATE billing_plans SET price_cents = p_price_cents, updated_at = now() WHERE code = p_plan;
  PERFORM _platform_audit(p_actor, 'billing_plan.updated', NULL, p_reason,
    jsonb_build_object('plan', p_plan, 'from', jsonb_build_object('price_cents', v_from),
                       'to', jsonb_build_object('price_cents', p_price_cents)), p_ip, p_user_agent);
END $$;
REVOKE EXECUTE ON FUNCTION public.platform_update_plan_price(TEXT, BIGINT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_update_plan_price(TEXT, BIGINT, UUID, TEXT, TEXT, TEXT) TO service_role;

-- Plans list for the panel, now with prices.
CREATE OR REPLACE FUNCTION public.platform_list_plans()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'features', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', key, 'kind', kind,
                            'default_value', default_value, 'description', description)
                          ORDER BY sort_order, key) FROM billing_features), '[]'),
    'plans', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'code', p.code, 'name', p.name, 'is_active', p.is_active, 'is_default', p.is_default,
               'price_cents', p.price_cents, 'currency', p.currency, 'billing_interval', p.billing_interval,
               'organizations', (SELECT count(*) FROM billing_subscriptions s WHERE s.plan_code = p.code),
               'features', COALESCE((SELECT jsonb_object_agg(feature_key, value) FROM billing_plan_features
                                      WHERE plan_code = p.code), '{}'))
             ORDER BY p.sort_order, p.code) FROM billing_plans p), '[]'));
$$;
