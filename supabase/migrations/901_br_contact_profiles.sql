-- 901_br_contact_profiles (fork, docs/BRAZILIAN_CONTACTS.md)
--
-- Brazilian registration data of a contact: pessoa física/jurídica,
-- CPF/CNPJ, razão social and address. 1:1 with `contacts`.
--
-- Why a table and not `custom_fields`: custom fields are an untyped
-- TEXT key/value catalogue that admins can rename or delete at any
-- time (deleting a field cascades its values), with no validation and
-- no way to index or constrain a value. CPF/CNPJ and the address need
-- a fixed shape, real validation in the database and stable names for
-- integrations (NF-e, boleto, CEP lookup).
--
-- Why not columns on `contacts`: that table is upstream's; every new
-- column there is a merge risk. Name, phone, e-mail and nome fantasia
-- (`contacts.company`) already live there and are NOT duplicated here.
--
-- Storage: CPF = 11 digits, CNPJ = 14 uppercase chars (alphanumeric
-- CNPJ, IN RFB 2.229/2024: first 12 may be letters), CEP = 8 digits,
-- all without mask. The check digits are validated here too, so the
-- API, imports and direct SQL cannot store an invalid document.
--
-- Tenancy: `account_id` is always copied from the contact by a trigger
-- (never trusted from the client), and RLS mirrors `contacts`
-- (members read, agent+ write).
--
-- Idempotent, like every migration in this repo.

-- ------------------------------------------------------------
-- Validators (same algorithm as src/modules/br/documents.ts)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.br_is_valid_cpf(doc TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  d INT[];
  s INT;
  r INT;
  dv1 INT;
  dv2 INT;
BEGIN
  IF doc IS NULL OR doc !~ '^[0-9]{11}$' OR doc ~ '^(.)\1{10}$' THEN
    RETURN FALSE;
  END IF;
  d := ARRAY(SELECT substr(doc, i, 1)::INT FROM generate_series(1, 11) AS i);
  s := 0;
  FOR i IN 1..9 LOOP s := s + d[i] * (11 - i); END LOOP;
  r := s % 11;
  dv1 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  s := 0;
  FOR i IN 1..10 LOOP s := s + d[i] * (12 - i); END LOOP;
  r := s % 11;
  dv2 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  RETURN dv1 = d[10] AND dv2 = d[11];
END;
$$;

CREATE OR REPLACE FUNCTION public.br_is_valid_cnpj(doc TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v INT[];
  w1 INT[] := ARRAY[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  w2 INT[] := ARRAY[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  s INT;
  r INT;
  dv1 INT;
  dv2 INT;
BEGIN
  IF doc IS NULL OR doc !~ '^[0-9A-Z]{12}[0-9]{2}$' OR doc ~ '^(.)\1{13}$' THEN
    RETURN FALSE;
  END IF;
  -- Character value = ASCII code - 48 ('0'..'9' → 0..9, 'A' → 17).
  v := ARRAY(SELECT ascii(substr(doc, i, 1)) - 48 FROM generate_series(1, 14) AS i);
  s := 0;
  FOR i IN 1..12 LOOP s := s + v[i] * w1[i]; END LOOP;
  r := s % 11;
  dv1 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  s := 0;
  FOR i IN 1..13 LOOP s := s + v[i] * w2[i]; END LOOP;
  r := s % 11;
  dv2 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  RETURN dv1 = v[13] AND dv2 = v[14];
END;
$$;

-- ------------------------------------------------------------
-- Table
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.br_contact_profiles (
  contact_id    UUID PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  person_type   TEXT,
  tax_id        TEXT,
  legal_name    TEXT,
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

ALTER TABLE public.br_contact_profiles
  DROP CONSTRAINT IF EXISTS br_contact_profiles_person_type;
ALTER TABLE public.br_contact_profiles
  ADD CONSTRAINT br_contact_profiles_person_type
  CHECK (person_type IS NULL OR person_type IN ('PF', 'PJ'));

ALTER TABLE public.br_contact_profiles
  DROP CONSTRAINT IF EXISTS br_contact_profiles_tax_id_valid;
ALTER TABLE public.br_contact_profiles
  ADD CONSTRAINT br_contact_profiles_tax_id_valid
  CHECK (
    tax_id IS NULL
    OR (person_type = 'PF' AND public.br_is_valid_cpf(tax_id))
    OR (person_type = 'PJ' AND public.br_is_valid_cnpj(tax_id))
  );

ALTER TABLE public.br_contact_profiles
  DROP CONSTRAINT IF EXISTS br_contact_profiles_postal_code;
ALTER TABLE public.br_contact_profiles
  ADD CONSTRAINT br_contact_profiles_postal_code
  CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{8}$');

ALTER TABLE public.br_contact_profiles
  DROP CONSTRAINT IF EXISTS br_contact_profiles_state;
ALTER TABLE public.br_contact_profiles
  ADD CONSTRAINT br_contact_profiles_state
  CHECK (state IS NULL OR state IN (
    'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA',
    'PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
  ));

ALTER TABLE public.br_contact_profiles
  DROP CONSTRAINT IF EXISTS br_contact_profiles_lengths;
ALTER TABLE public.br_contact_profiles
  ADD CONSTRAINT br_contact_profiles_lengths
  CHECK (
    coalesce(length(legal_name), 0)    <= 200
    AND coalesce(length(street), 0)        <= 200
    AND coalesce(length(street_number), 0) <= 20
    AND coalesce(length(complement), 0)    <= 100
    AND coalesce(length(district), 0)      <= 100
    AND coalesce(length(city), 0)          <= 100
  );

-- Lookup by document inside an account (not UNIQUE on purpose: several
-- contacts — people/phones — can belong to the same CNPJ, and one person
-- can have two numbers).
CREATE INDEX IF NOT EXISTS idx_br_contact_profiles_account_tax_id
  ON public.br_contact_profiles (account_id, tax_id)
  WHERE tax_id IS NOT NULL;

COMMENT ON TABLE public.br_contact_profiles IS
  'Fork (901): Brazilian registration data of a contact (CPF/CNPJ, razão social, address). Name/phone/e-mail/nome fantasia stay in contacts.';
COMMENT ON COLUMN public.br_contact_profiles.tax_id IS
  'CPF (11 digits) or CNPJ (14 chars, alphanumeric allowed), without mask; check digits enforced.';
COMMENT ON COLUMN public.br_contact_profiles.postal_code IS
  'CEP, 8 digits without mask.';

-- ------------------------------------------------------------
-- Tenancy + updated_at
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.br_contact_profiles_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The account is the contact's, whatever the client sent.
  SELECT c.account_id INTO NEW.account_id
  FROM public.contacts c
  WHERE c.id = NEW.contact_id;
  IF NEW.account_id IS NULL THEN
    RAISE EXCEPTION 'contact % not found', NEW.contact_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS br_contact_profiles_before_write ON public.br_contact_profiles;
CREATE TRIGGER br_contact_profiles_before_write
  BEFORE INSERT OR UPDATE ON public.br_contact_profiles
  FOR EACH ROW EXECUTE FUNCTION public.br_contact_profiles_before_write();

-- ------------------------------------------------------------
-- RLS: same rule as `contacts` (017): members read, agent+ write.
-- ------------------------------------------------------------

ALTER TABLE public.br_contact_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS br_contact_profiles_select ON public.br_contact_profiles;
CREATE POLICY br_contact_profiles_select ON public.br_contact_profiles
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS br_contact_profiles_insert ON public.br_contact_profiles;
CREATE POLICY br_contact_profiles_insert ON public.br_contact_profiles
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS br_contact_profiles_update ON public.br_contact_profiles;
CREATE POLICY br_contact_profiles_update ON public.br_contact_profiles
  FOR UPDATE USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS br_contact_profiles_delete ON public.br_contact_profiles;
CREATE POLICY br_contact_profiles_delete ON public.br_contact_profiles
  FOR DELETE USING (public.is_account_member(account_id, 'agent'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.br_contact_profiles TO authenticated;
