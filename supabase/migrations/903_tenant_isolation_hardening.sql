-- 903_tenant_isolation_hardening (fork, docs/TENANCY.md)
--
-- Findings of the RLS / tenant-isolation review, fixed here. Every
-- public table already had RLS enabled with is_account_member() checks;
-- the gaps were around it:
--
--  1. SECURITY DEFINER functions callable by anyone. They bypass RLS and
--     take a bare row id, with no account check, so any signed-in user
--     (and even `anon`) could act on another tenant's rows:
--       record_webhook_failure(id, n) → disable another tenant's webhook
--       claim_ai_reply_slot(id, n)    → burn another tenant's AI quota
--       _bcast_bump / recompute_broadcast_counts → tamper with campaign stats
--       merge_duplicate_contacts/conversations   → global data rewrite
--     They are only meant for the service role (webhook/engine) and for
--     triggers (which run as the owner), so EXECUTE is revoked from
--     PUBLIC, anon and authenticated.
--
--  2. Cross-tenant references. RLS checks the row's own account_id, but
--     not the rows it points to: a member of tenant A could create a deal
--     on B's contact, tag A's contact with B's tag, reply to B's message
--     or assign a conversation to a user of B (who then got a notification
--     with A's contact name). `tenant_enforce_refs` triggers now require
--     every reference to belong to the same account — also for writes by
--     the service role (engine), so a bad id in an automation config cannot
--     leak either.
--
--  3. profiles INSERT. The policy only checks user_id = auth.uid(); a user
--     whose profile row was missing could insert one pointing at ANY
--     account with role owner. Client inserts are now limited to an
--     account the caller owns (normal profiles are created by
--     handle_new_user, which is unaffected).
--
--  4. Storage listing. The SELECT policies "… is publicly readable" let
--     anyone LIST every object of chat-media / flow-media / avatars
--     through the Storage API, i.e. enumerate every tenant's media. Public
--     URLs do not need a SELECT policy (public buckets are served without
--     RLS), so SELECT is narrowed to the caller's own folder.
--
-- Idempotent.

-- ------------------------------------------------------------
-- 1. Privileged functions: service role / triggers only
-- ------------------------------------------------------------

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.record_webhook_failure(uuid, integer)',
    'public.claim_ai_reply_slot(uuid, integer)',
    'public._bcast_bump(uuid, text, integer)',
    'public.recompute_broadcast_counts(uuid)',
    'public.merge_duplicate_contacts()',
    'public.merge_duplicate_conversations()'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- 2. Same-account references
-- ------------------------------------------------------------

-- Account of a row, by table. Whitelisted tables only (no dynamic SQL).
-- SECURITY DEFINER: must see rows the caller cannot (that is the point);
-- not executable by clients, so it is not an oracle.
CREATE OR REPLACE FUNCTION public.tenant_account_of(p_table TEXT, p_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v UUID;
BEGIN
  IF p_id IS NULL THEN
    RETURN NULL;
  END IF;
  CASE p_table
    WHEN 'contacts'               THEN SELECT account_id INTO v FROM contacts WHERE id = p_id;
    WHEN 'conversations'          THEN SELECT account_id INTO v FROM conversations WHERE id = p_id;
    WHEN 'pipelines'              THEN SELECT account_id INTO v FROM pipelines WHERE id = p_id;
    WHEN 'pipeline_stages'        THEN SELECT p.account_id INTO v FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = p_id;
    WHEN 'profiles'               THEN SELECT account_id INTO v FROM profiles WHERE id = p_id;
    WHEN 'user'                   THEN SELECT account_id INTO v FROM profiles WHERE user_id = p_id;
    WHEN 'tags'                   THEN SELECT account_id INTO v FROM tags WHERE id = p_id;
    WHEN 'custom_fields'          THEN SELECT account_id INTO v FROM custom_fields WHERE id = p_id;
    WHEN 'broadcasts'             THEN SELECT account_id INTO v FROM broadcasts WHERE id = p_id;
    WHEN 'messages'               THEN SELECT c.account_id INTO v FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = p_id;
    WHEN 'automations'            THEN SELECT account_id INTO v FROM automations WHERE id = p_id;
    WHEN 'automation_steps'       THEN SELECT a.account_id INTO v FROM automation_steps s JOIN automations a ON a.id = s.automation_id WHERE s.id = p_id;
    WHEN 'automation_logs'        THEN SELECT account_id INTO v FROM automation_logs WHERE id = p_id;
    WHEN 'flows'                  THEN SELECT account_id INTO v FROM flows WHERE id = p_id;
    WHEN 'flow_runs'              THEN SELECT account_id INTO v FROM flow_runs WHERE id = p_id;
    WHEN 'ai_knowledge_documents' THEN SELECT account_id INTO v FROM ai_knowledge_documents WHERE id = p_id;
    ELSE
      RAISE EXCEPTION 'tenant_account_of: unsupported table %', p_table;
  END CASE;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tenant_account_of(TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- Trigger arguments:
--   TG_ARGV[0]  where the row's account comes from: 'account_id' (own
--               column) or '<column>=<table>' (its parent, e.g.
--               'contact_id=contacts' for contact_tags).
--   TG_ARGV[1…] references to check: '<column>=<table>'. A trailing '?'
--               ('assigned_agent_id=user?') clears a foreign reference to
--               NULL (with a WARNING) instead of failing: used for
--               assignees, so a handoff to a user who has since left the
--               account still hands off (unassigned) instead of aborting
--               the whole update.
-- A NULL reference is fine; a missing row is left to the FK to report.
CREATE OR REPLACE FUNCTION public.tenant_enforce_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_row JSONB := to_jsonb(NEW);
  old_row JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  own_spec TEXT := TG_ARGV[0];
  own_col TEXT;
  own UUID;
  own_changed BOOLEAN;
  col TEXT;
  tbl TEXT;
  lenient BOOLEAN;
  ref_account UUID;
BEGIN
  IF own_spec = 'account_id' THEN
    own_col := 'account_id';
    own := (new_row ->> 'account_id')::UUID;
  ELSE
    own_col := split_part(own_spec, '=', 1);
    own := public.tenant_account_of(split_part(own_spec, '=', 2), (new_row ->> own_col)::UUID);
  END IF;
  IF own IS NULL THEN
    RETURN NEW;
  END IF;
  own_changed := old_row IS NULL OR (old_row ->> own_col) IS DISTINCT FROM (new_row ->> own_col);

  FOR i IN 1 .. TG_NARGS - 1 LOOP
    col := split_part(TG_ARGV[i], '=', 1);
    tbl := split_part(TG_ARGV[i], '=', 2);
    lenient := right(tbl, 1) = '?';
    tbl := rtrim(tbl, '?');
    CONTINUE WHEN (new_row ->> col) IS NULL;
    -- Unchanged reference on an unchanged row: already checked when written.
    CONTINUE WHEN NOT own_changed AND (old_row ->> col) IS NOT DISTINCT FROM (new_row ->> col);
    ref_account := public.tenant_account_of(tbl, (new_row ->> col)::UUID);
    IF lenient AND ref_account IS DISTINCT FROM own THEN
      RAISE WARNING 'tenant_enforce_refs: %.% is not a member of the account; cleared', TG_TABLE_NAME, col;
      NEW := jsonb_populate_record(NEW, jsonb_build_object(col, NULL));
    ELSIF ref_account IS NOT NULL AND ref_account <> own THEN
      RAISE EXCEPTION 'cross-tenant reference: %.% belongs to another account', TG_TABLE_NAME, col
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('deals',                         ARRAY['account_id', 'contact_id=contacts', 'conversation_id=conversations', 'pipeline_id=pipelines', 'stage_id=pipeline_stages', 'assigned_to=profiles?']),
      ('conversations',                 ARRAY['account_id', 'contact_id=contacts', 'assigned_agent_id=user?']),
      ('contact_notes',                 ARRAY['account_id', 'contact_id=contacts']),
      ('contact_tags',                  ARRAY['contact_id=contacts', 'tag_id=tags']),
      ('contact_custom_values',         ARRAY['contact_id=contacts', 'custom_field_id=custom_fields']),
      ('broadcast_recipients',          ARRAY['broadcast_id=broadcasts', 'contact_id=contacts']),
      ('messages',                      ARRAY['conversation_id=conversations', 'reply_to_message_id=messages']),
      ('message_reactions',             ARRAY['message_id=messages', 'conversation_id=conversations']),
      ('ai_knowledge_chunks',           ARRAY['account_id', 'document_id=ai_knowledge_documents']),
      ('ai_configs',                    ARRAY['account_id', 'handoff_agent_id=user?']),
      ('ai_usage_log',                  ARRAY['account_id', 'conversation_id=conversations']),
      ('automation_steps',              ARRAY['automation_id=automations', 'parent_step_id=automation_steps']),
      ('automation_logs',               ARRAY['account_id', 'automation_id=automations', 'contact_id=contacts']),
      ('automation_pending_executions', ARRAY['account_id', 'automation_id=automations', 'contact_id=contacts', 'log_id=automation_logs', 'parent_step_id=automation_steps']),
      ('flow_runs',                     ARRAY['account_id', 'flow_id=flows', 'contact_id=contacts', 'conversation_id=conversations', 'last_prompt_message_id=messages']),
      ('notifications',                 ARRAY['account_id', 'contact_id=contacts', 'conversation_id=conversations', 'user_id=user'])
    ) AS t(tbl, args)
  LOOP
    IF to_regclass('public.' || spec.tbl) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS tenant_enforce_refs ON public.%I', spec.tbl);
    EXECUTE format(
      'CREATE TRIGGER tenant_enforce_refs BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.tenant_enforce_refs(%s)',
      spec.tbl,
      (SELECT string_agg(quote_literal(a), ', ') FROM unnest(spec.args) AS a)
    );
  END LOOP;
END;
$$;

-- Report (not fix) pre-existing cross-tenant references, so an operator
-- can review them. Service role only.
CREATE OR REPLACE FUNCTION public.tenant_cross_reference_report()
RETURNS TABLE (table_name TEXT, column_name TEXT, row_count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'deals', 'contact_id', count(*) FROM deals d JOIN contacts c ON c.id = d.contact_id WHERE c.account_id <> d.account_id
  UNION ALL SELECT 'deals', 'pipeline_id', count(*) FROM deals d JOIN pipelines p ON p.id = d.pipeline_id WHERE p.account_id <> d.account_id
  UNION ALL SELECT 'conversations', 'contact_id', count(*) FROM conversations v JOIN contacts c ON c.id = v.contact_id WHERE c.account_id <> v.account_id
  UNION ALL SELECT 'contact_tags', 'tag_id', count(*) FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id JOIN tags t ON t.id = ct.tag_id WHERE t.account_id <> c.account_id
  UNION ALL SELECT 'contact_custom_values', 'custom_field_id', count(*) FROM contact_custom_values v JOIN contacts c ON c.id = v.contact_id JOIN custom_fields f ON f.id = v.custom_field_id WHERE f.account_id <> c.account_id
  UNION ALL SELECT 'broadcast_recipients', 'contact_id', count(*) FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id JOIN contacts c ON c.id = r.contact_id WHERE c.account_id <> b.account_id
  UNION ALL SELECT 'contact_notes', 'contact_id', count(*) FROM contact_notes n JOIN contacts c ON c.id = n.contact_id WHERE c.account_id <> n.account_id;
$$;

REVOKE EXECUTE ON FUNCTION public.tenant_cross_reference_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_cross_reference_report() TO service_role;

-- ------------------------------------------------------------
-- 3. profiles INSERT from the client
-- ------------------------------------------------------------

-- SECURITY DEFINER helper: the caller is not a member of the account
-- yet, so RLS would hide it. Only answers "do I own this account?".
CREATE OR REPLACE FUNCTION public.tenant_caller_owns_account(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = p_account_id AND a.owner_user_id = auth.uid()
  );
$$;

REVOKE EXECUTE ON FUNCTION public.tenant_caller_owns_account(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_caller_owns_account(UUID) TO authenticated, service_role;

-- SECURITY INVOKER on purpose: current_user must be the client role
-- (inside a SECURITY DEFINER function it would be the owner).
CREATE OR REPLACE FUNCTION public.profiles_guard_client_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND NEW.account_id IS NOT NULL
     AND NOT public.tenant_caller_owns_account(NEW.account_id)
  THEN
    RAISE EXCEPTION 'a profile can only be created for an account you own'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_client_insert ON public.profiles;
CREATE TRIGGER profiles_guard_client_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_client_insert();

-- ------------------------------------------------------------
-- 4. Storage: no cross-tenant listing
-- ------------------------------------------------------------

DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;

DROP POLICY IF EXISTS "Members can read own account media" ON storage.objects;
CREATE POLICY "Members can read own account media" ON storage.objects
  FOR SELECT USING (
    bucket_id IN ('chat-media', 'flow-media')
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::TEXT) = (storage.foldername(name))[1]
    )
  );

-- flow-media also accepts the legacy per-user folder (upload policy, 016).
DROP POLICY IF EXISTS "Users can read own legacy flow media" ON storage.objects;
CREATE POLICY "Users can read own legacy flow media" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'flow-media' AND (auth.uid())::TEXT = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users can read own avatar objects" ON storage.objects;
CREATE POLICY "Users can read own avatar objects" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'avatars' AND (auth.uid())::TEXT = (storage.foldername(name))[1]
  );
