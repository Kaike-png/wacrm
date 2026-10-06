-- 900_custom_account_locale (fork, docs/LOCALIZATION.md)
--
-- Per-tenant regional settings.
--
--   accounts.locale    BCP 47 formatting locale (dates, numbers, money),
--                      default 'pt-BR'. The UI *language* is still set
--                      per deploy (NEXT_PUBLIC_APP_LOCALE).
--   accounts.timezone  IANA time zone, default 'America/Sao_Paulo'. Used
--                      to display timestamps and by the automation
--                      engine's time-of-day condition.
--   accounts.default_currency (upstream 021): new accounts default to
--                      'BRL' instead of 'USD'. Existing rows are left
--                      untouched; change them in Configurações → Região
--                      e moeda (or see docs/LOCALIZATION.md for SQL).
--
-- RLS: no change. The upstream `accounts_select` / `accounts_update`
-- policies (017) cover new columns: members read, admins+ write.
--
-- Idempotent, like every migration in this repo.

CREATE OR REPLACE FUNCTION public.is_valid_timezone(tz TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF tz IS NULL OR btrim(tz) = '' THEN
    RETURN FALSE;
  END IF;
  PERFORM now() AT TIME ZONE tz;
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'pt-BR';

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_locale_format;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_locale_format
  CHECK (locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$');

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_timezone_valid;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_timezone_valid
  CHECK (public.is_valid_timezone(timezone));

ALTER TABLE public.accounts
  ALTER COLUMN default_currency SET DEFAULT 'BRL';

COMMENT ON COLUMN public.accounts.locale IS
  'Fork (900): BCP 47 locale for formatting dates/numbers/money, e.g. pt-BR.';
COMMENT ON COLUMN public.accounts.timezone IS
  'Fork (900): IANA time zone for display and automation time-of-day conditions.';
