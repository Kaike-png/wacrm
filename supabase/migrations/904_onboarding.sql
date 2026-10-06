-- 904_onboarding (fork, docs/ONBOARDING.md)
--
-- Progress of the first-run setup wizard (/onboarding), per organization
-- (= accounts row). One row per account; NO row means "onboarding not
-- started" for accounts created after this migration.
--
-- Accounts that already exist are in use, so they are backfilled as
-- completed: nobody already working is pushed into the wizard.
--
-- RLS like `accounts` (017): members read, admin+ write. completed_by
-- must be a member (tenant_enforce_refs, 903 — cleared otherwise).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.onboarding_progress (
  account_id      UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  current_step    TEXT NOT NULL DEFAULT 'organization',
  completed_steps TEXT[] NOT NULL DEFAULT '{}',
  skipped_steps   TEXT[] NOT NULL DEFAULT '{}',
  completed_at    TIMESTAMPTZ,
  completed_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.onboarding_progress DROP CONSTRAINT IF EXISTS onboarding_progress_steps;
ALTER TABLE public.onboarding_progress ADD CONSTRAINT onboarding_progress_steps
  CHECK (
    current_step IN ('organization', 'company', 'team', 'whatsapp', 'done')
    AND completed_steps <@ ARRAY['organization', 'company', 'team', 'whatsapp']::TEXT[]
    AND skipped_steps   <@ ARRAY['organization', 'company', 'team', 'whatsapp']::TEXT[]
  );

COMMENT ON TABLE public.onboarding_progress IS
  'Fork (904): first-run setup wizard progress per organization. No row = not started.';

-- Existing organizations are already set up.
INSERT INTO public.onboarding_progress (account_id, current_step, completed_at)
SELECT a.id, 'done', now()
FROM public.accounts a
WHERE NOT EXISTS (SELECT 1 FROM public.onboarding_progress o WHERE o.account_id = a.id);

CREATE OR REPLACE FUNCTION public.onboarding_progress_touch()
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

DROP TRIGGER IF EXISTS onboarding_progress_touch ON public.onboarding_progress;
CREATE TRIGGER onboarding_progress_touch
  BEFORE INSERT OR UPDATE ON public.onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION public.onboarding_progress_touch();

DROP TRIGGER IF EXISTS tenant_enforce_refs ON public.onboarding_progress;
CREATE TRIGGER tenant_enforce_refs
  BEFORE INSERT OR UPDATE ON public.onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION public.tenant_enforce_refs('account_id', 'completed_by=user?');

ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_progress_select ON public.onboarding_progress;
CREATE POLICY onboarding_progress_select ON public.onboarding_progress
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS onboarding_progress_insert ON public.onboarding_progress;
CREATE POLICY onboarding_progress_insert ON public.onboarding_progress
  FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS onboarding_progress_update ON public.onboarding_progress;
CREATE POLICY onboarding_progress_update ON public.onboarding_progress
  FOR UPDATE USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE ON public.onboarding_progress TO authenticated;
