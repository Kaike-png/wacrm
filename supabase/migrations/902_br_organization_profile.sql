-- 902_br_organization_profile (fork, docs/TENANCY.md)
--
-- The SaaS "organization" IS the upstream `accounts` row (the tenant:
-- every tenant-owned row carries account_id, RLS is is_account_member()).
-- No new organization entity is created. This migration only completes it:
--
--   accounts (reused)          nome → name, moeda → default_currency (021),
--                              idioma → locale, timezone → timezone (900)
--   accounts.status (new)      trial | active | past_due | suspended | cancelled
--                              + status_changed_at, trial_ends_at
--   br_account_profiles (new,  razão social, nome fantasia, CPF/CNPJ,
--   1:1 extension, PK =        telefone, e-mail, CEP, endereço, cidade, UF
--   account_id)
--
-- Why status is a column of `accounts`: it is the tenant's own lifecycle
-- and will be read on every request (middleware, billing). Why the
-- registration data is a 1:1 table: same reason as br_contact_profiles
-- (901): fixed, validated shape without piling columns onto an upstream
-- table; it reuses the validators of 901.
--
-- SECURITY: tenant admins can UPDATE `accounts` (policy accounts_update,
-- 017) — that is how the name is renamed. Without a guard an admin could
-- set their own status to 'active' or hand the account to another user.
-- `accounts_guard_privileged_columns` rejects changes to status,
-- status_changed_at, trial_ends_at, owner_user_id and id from the
-- `authenticated`/`anon` roles. Billing (service_role) and the
-- SECURITY DEFINER member RPCs (owned by postgres) are unaffected.
--
-- Idempotent.

-- ------------------------------------------------------------
-- accounts.status
-- ------------------------------------------------------------

-- Existing accounts are already in use → backfill 'active'; then new
-- accounts start in 'trial'.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.accounts
  ALTER COLUMN status SET DEFAULT 'trial';

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_status_valid;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_status_valid
  CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_accounts_status ON public.accounts (status);

COMMENT ON COLUMN public.accounts.status IS
  'Fork (902): SaaS lifecycle — trial | active | past_due | suspended | cancelled. Written by billing/operators only (service_role).';
COMMENT ON COLUMN public.accounts.trial_ends_at IS
  'Fork (902): end of the trial period (set by billing; NULL = not defined).';

CREATE OR REPLACE FUNCTION public.accounts_guard_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Inside SECURITY DEFINER RPCs current_user is the function owner, so
  -- transfer_account_ownership() keeps working; only direct client
  -- writes through PostgREST run as authenticated/anon.
  IF current_user IN ('authenticated', 'anon') THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at
       OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
    THEN
      RAISE EXCEPTION
        'status, trial, owner and id of an account cannot be changed by the client'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_guard_privileged_columns ON public.accounts;
CREATE TRIGGER accounts_guard_privileged_columns
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_guard_privileged_columns();

-- ------------------------------------------------------------
-- br_account_profiles (1:1 with accounts)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.br_account_profiles (
  account_id    UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  person_type   TEXT,
  tax_id        TEXT,
  legal_name    TEXT,
  trade_name    TEXT,
  phone         TEXT,
  email         TEXT,
  postal_code   TEXT,
  street        TEXT,
  street_number TEXT,
  complement    TEXT,
  district      TEXT,
  city          TEXT,
  state         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.br_account_profiles DROP CONSTRAINT IF EXISTS br_account_profiles_person_type;
ALTER TABLE public.br_account_profiles ADD CONSTRAINT br_account_profiles_person_type
  CHECK (person_type IS NULL OR person_type IN ('PF', 'PJ'));

ALTER TABLE public.br_account_profiles DROP CONSTRAINT IF EXISTS br_account_profiles_tax_id_valid;
ALTER TABLE public.br_account_profiles ADD CONSTRAINT br_account_profiles_tax_id_valid
  CHECK (
    tax_id IS NULL
    OR (person_type = 'PF' AND public.br_is_valid_cpf(tax_id))
    OR (person_type = 'PJ' AND public.br_is_valid_cnpj(tax_id))
  );

ALTER TABLE public.br_account_profiles DROP CONSTRAINT IF EXISTS br_account_profiles_phone;
ALTER TABLE public.br_account_profiles ADD CONSTRAINT br_account_profiles_phone
  CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE public.br_account_profiles DROP CONSTRAINT IF EXISTS br_account_profiles_email;
ALTER TABLE public.br_account_profiles ADD CONSTRAINT br_account_profiles_email
  CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'));

ALTER TABLE public.br_account_profiles DROP CONSTRAINT IF EXISTS br_account_profiles_postal_code;
ALTER TABLE public.br_account_profiles ADD CONSTRAINT br_account_profiles_postal_code
  CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{8}$');

ALTER TABLE public.br_account_profiles DROP CONSTRAINT IF EXISTS br_account_profiles_state;
ALTER TABLE public.br_account_profiles ADD CONSTRAINT br_account_profiles_state
  CHECK (state IS NULL OR state IN (
    'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA',
    'PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
  ));

ALTER TABLE public.br_account_profiles DROP CONSTRAINT IF EXISTS br_account_profiles_lengths;
ALTER TABLE public.br_account_profiles ADD CONSTRAINT br_account_profiles_lengths
  CHECK (
    coalesce(length(legal_name), 0)    <= 200
    AND coalesce(length(trade_name), 0)    <= 200
    AND coalesce(length(street), 0)        <= 200
    AND coalesce(length(street_number), 0) <= 20
    AND coalesce(length(complement), 0)    <= 100
    AND coalesce(length(district), 0)      <= 100
    AND coalesce(length(city), 0)          <= 100
  );

COMMENT ON TABLE public.br_account_profiles IS
  'Fork (902): registration data of the organization (= accounts row): razão social, nome fantasia, CPF/CNPJ, contact, address.';

CREATE OR REPLACE FUNCTION public.br_account_profiles_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'account_id cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS br_account_profiles_touch ON public.br_account_profiles;
CREATE TRIGGER br_account_profiles_touch
  BEFORE INSERT OR UPDATE ON public.br_account_profiles
  FOR EACH ROW EXECUTE FUNCTION public.br_account_profiles_touch();

-- RLS: same rule as `accounts` (017): members read, admin+ write.
ALTER TABLE public.br_account_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS br_account_profiles_select ON public.br_account_profiles;
CREATE POLICY br_account_profiles_select ON public.br_account_profiles
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS br_account_profiles_insert ON public.br_account_profiles;
CREATE POLICY br_account_profiles_insert ON public.br_account_profiles
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS br_account_profiles_update ON public.br_account_profiles;
CREATE POLICY br_account_profiles_update ON public.br_account_profiles
  FOR UPDATE USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS br_account_profiles_delete ON public.br_account_profiles;
CREATE POLICY br_account_profiles_delete ON public.br_account_profiles
  FOR DELETE USING (public.is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.br_account_profiles TO authenticated;
