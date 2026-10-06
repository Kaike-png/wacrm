-- Tenant isolation tests (fork, docs/TENANCY.md).
--
-- pgTAP, run against a real database with every migration applied:
--
--   npm run test:db            (scripts/fork/test-db.sh)
--   supabase test db           (Supabase CLI picks up supabase/tests/)
--
-- Everything runs in one transaction and is rolled back. Two
-- organizations (A, B) are seeded with a row in every tenant table;
-- then each check runs as a real client role (`authenticated` with the
-- user's JWT claims, or `anon`), exactly what PostgREST/Realtime do.
-- The checks are generic where possible (every table with account_id),
-- so a new upstream or fork table is covered automatically.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

-- ------------------------------------------------------------------
-- Identities
-- ------------------------------------------------------------------
-- a_owner owns A, a_viewer is a viewer of A, b_owner owns B, c_orphan
-- has no profile (bootstrap failure case).

CREATE FUNCTION pg_temp.login(uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::TEXT, true);
  PERFORM set_config('request.jwt.claim.sub', uid::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;

CREATE FUNCTION pg_temp.login_anon() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('role', 'anon', true);
END $$;

CREATE FUNCTION pg_temp.login_service() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('role', 'service_role', true);
END $$;

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'a-owner@iso.test', '', now(), '{"full_name":"Org A"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'a-viewer@iso.test', '', now(), '{"full_name":"A Viewer"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'b-owner@iso.test', '', now(), '{"full_name":"Org B"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'cccccccc-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'c-orphan@iso.test', '', now(), '{"full_name":"Orphan"}', now(), now());

-- handle_new_user bootstrapped one account + owner profile per user.
CREATE TEMP TABLE ids AS
SELECT
  (SELECT account_id FROM profiles WHERE user_id = 'aaaaaaaa-0000-4000-8000-000000000001') AS acc_a,
  (SELECT account_id FROM profiles WHERE user_id = 'bbbbbbbb-0000-4000-8000-000000000001') AS acc_b,
  'aaaaaaaa-0000-4000-8000-000000000001'::UUID AS a_owner,
  'aaaaaaaa-0000-4000-8000-000000000002'::UUID AS a_viewer,
  'bbbbbbbb-0000-4000-8000-000000000001'::UUID AS b_owner,
  'cccccccc-0000-4000-8000-000000000001'::UUID AS c_orphan;
GRANT SELECT ON ids TO PUBLIC;

-- Isolation is plan-independent: no plan = no limits (907). Limits are
-- covered by billing_plans.test.sql.
DELETE FROM billing_subscriptions WHERE account_id IN (SELECT acc_a FROM ids UNION ALL SELECT acc_b FROM ids);

-- a_viewer joins A as viewer; c_orphan loses its profile.
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'viewer'
WHERE user_id = (SELECT a_viewer FROM ids);
DELETE FROM profiles WHERE user_id = (SELECT c_orphan FROM ids);

SELECT is((SELECT status FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'trial',
  'a new organization starts in trial');
SELECT is((SELECT count(*) FROM onboarding_progress WHERE account_id = (SELECT acc_a FROM ids)), 0::BIGINT,
  'a new organization has not started onboarding (904)');

-- ------------------------------------------------------------------
-- Seed: one row in every tenant table, for A and for B
-- ------------------------------------------------------------------

CREATE FUNCTION pg_temp.seed(acc UUID, uid UUID, tag TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  r JSONB := '{}';
  contact UUID; conv UUID; msg UUID; tg UUID; cf UUID; pl UUID; st UUID;
  bc UUID; au UUID; step UUID; fl UUID; run UUID; doc UUID; ep UUID; lg UUID;
BEGIN
  INSERT INTO contacts (user_id, account_id, phone, name)
    VALUES (uid, acc, '+55119' || CASE tag WHEN 'A' THEN '11111111' ELSE '22222222' END, 'Contact ' || tag)
    RETURNING id INTO contact;
  INSERT INTO br_contact_profiles (contact_id, account_id, person_type, tax_id)
    VALUES (contact, acc, 'PF', '52998224725');
  INSERT INTO conversations (user_id, account_id, contact_id) VALUES (uid, acc, contact) RETURNING id INTO conv;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text)
    VALUES (conv, 'customer', 'text', 'secret of ' || tag) RETURNING id INTO msg;
  INSERT INTO message_reactions (message_id, conversation_id, actor_type, emoji) VALUES (msg, conv, 'customer', '👍');
  INSERT INTO tags (user_id, account_id, name) VALUES (uid, acc, 'tag ' || tag) RETURNING id INTO tg;
  INSERT INTO contact_tags (contact_id, tag_id) VALUES (contact, tg);
  INSERT INTO custom_fields (user_id, account_id, field_name) VALUES (uid, acc, 'field ' || tag) RETURNING id INTO cf;
  INSERT INTO contact_custom_values (contact_id, custom_field_id, value) VALUES (contact, cf, 'v');
  INSERT INTO contact_notes (contact_id, user_id, account_id, note_text) VALUES (contact, uid, acc, 'note ' || tag);
  INSERT INTO pipelines (user_id, account_id, name) VALUES (uid, acc, 'pipe ' || tag) RETURNING id INTO pl;
  INSERT INTO pipeline_stages (pipeline_id, name, position) VALUES (pl, 'stage', 0) RETURNING id INTO st;
  INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, contact_id, title, value)
    VALUES (uid, acc, pl, st, contact, 'deal ' || tag, 1000);
  INSERT INTO broadcasts (user_id, account_id, name, template_name) VALUES (uid, acc, 'bc ' || tag, 'tpl') RETURNING id INTO bc;
  INSERT INTO broadcast_recipients (broadcast_id, contact_id) VALUES (bc, contact);
  INSERT INTO automations (user_id, account_id, name, trigger_type) VALUES (uid, acc, 'auto ' || tag, 'new_message_received') RETURNING id INTO au;
  INSERT INTO automation_steps (automation_id, step_type, position) VALUES (au, 'add_tag', 0) RETURNING id INTO step;
  INSERT INTO automation_logs (automation_id, user_id, account_id, trigger_event, status, contact_id)
    VALUES (au, uid, acc, 'test', 'success', contact) RETURNING id INTO lg;
  INSERT INTO automation_pending_executions (automation_id, user_id, account_id, next_step_position, run_at, contact_id, log_id)
    VALUES (au, uid, acc, 1, now(), contact, lg);
  INSERT INTO flows (user_id, account_id, name, trigger_type) VALUES (uid, acc, 'flow ' || tag, 'manual') RETURNING id INTO fl;
  INSERT INTO flow_nodes (flow_id, node_key, node_type) VALUES (fl, 'start', 'start');
  INSERT INTO flow_runs (flow_id, user_id, account_id, contact_id, conversation_id) VALUES (fl, uid, acc, contact, conv) RETURNING id INTO run;
  INSERT INTO flow_run_events (flow_run_id, event_type) VALUES (run, 'started');
  INSERT INTO message_templates (user_id, account_id, name, body_text) VALUES (uid, acc, 'tpl_' || lower(tag), 'Olá');
  INSERT INTO quick_replies (account_id, user_id, title) VALUES (acc, uid, 'qr ' || tag);
  INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, access_token) VALUES (uid, acc, 'pnid-' || tag, 'enc-token-' || tag);
  INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (acc, 'key ' || tag, 'wacrm_live_' || tag, 'hash-' || tag);
  INSERT INTO webhook_endpoints (account_id, url, secret) VALUES (acc, 'https://example.com/' || tag, 'whsec-' || tag) RETURNING id INTO ep;
  INSERT INTO ai_configs (account_id, provider, model, api_key) VALUES (acc, 'openai', 'gpt-4o-mini', 'enc-ai-' || tag);
  INSERT INTO ai_knowledge_documents (account_id, title, content) VALUES (acc, 'doc ' || tag, 'kb ' || tag) RETURNING id INTO doc;
  INSERT INTO ai_knowledge_chunks (document_id, account_id, content) VALUES (doc, acc, 'chunk ' || tag);
  INSERT INTO ai_usage_log (account_id, mode, provider, model, conversation_id) VALUES (acc, 'draft', 'openai', 'gpt-4o-mini', conv);
  INSERT INTO notifications (account_id, user_id, title, conversation_id, contact_id) VALUES (acc, uid, 'n ' || tag, conv, contact);
  INSERT INTO member_presence (user_id, account_id, status) VALUES (uid, acc, 'online');
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES (acc, 'tok-' || tag, 'agent', now() + interval '1 day');
  INSERT INTO onboarding_progress (account_id, current_step, completed_steps)
    VALUES (acc, 'team', ARRAY['organization', 'company']);
  INSERT INTO br_account_profiles (account_id, person_type, tax_id, legal_name)
    VALUES (acc, 'PJ', '11222333000181', 'Org ' || tag || ' Ltda');
  r := jsonb_build_object('contact', contact, 'conversation', conv, 'message', msg, 'tag', tg,
    'custom_field', cf, 'pipeline', pl, 'stage', st, 'broadcast', bc, 'automation', au,
    'step', step, 'flow', fl, 'run', run, 'endpoint', ep);
  RETURN r;
END $$;

CREATE TEMP TABLE seeded AS
SELECT pg_temp.seed(acc_a, a_owner, 'A') AS a, pg_temp.seed(acc_b, b_owner, 'B') AS b FROM ids;
GRANT SELECT ON seeded TO PUBLIC;

INSERT INTO storage.objects (bucket_id, name, owner)
SELECT 'chat-media', 'account-' || acc_b || '/1700000000000-boleto.pdf', b_owner FROM ids;

-- Tables that carry account_id (computed as postgres, read by the clients).
CREATE TEMP TABLE tenant_tables AS
SELECT c.table_name::TEXT AS t
FROM information_schema.columns c
JOIN information_schema.tables tb USING (table_schema, table_name)
WHERE c.table_schema = 'public' AND c.column_name = 'account_id' AND tb.table_type = 'BASE TABLE';
GRANT SELECT ON tenant_tables TO PUBLIC;

-- Tables (with account_id) in which the current role can see rows of `acc`.
CREATE FUNCTION pg_temp.tables_with_rows_of(acc UUID) RETURNS TEXT[] LANGUAGE plpgsql AS $$
DECLARE t TEXT; n BIGINT; found TEXT[] := '{}';
BEGIN
  FOR t IN SELECT tenant_tables.t FROM tenant_tables ORDER BY 1 LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE account_id = $1', t) INTO n USING acc;
    EXCEPTION WHEN insufficient_privilege THEN n := 0;
    END;
    IF n > 0 THEN found := found || t; END IF;
  END LOOP;
  SELECT count(*) INTO n FROM public.accounts WHERE id = acc;
  IF n > 0 THEN found := found || 'accounts'::TEXT; END IF;
  RETURN found;
END $$;

-- Child tables without account_id: rows of the seeded graph of `side`.
CREATE FUNCTION pg_temp.child_rows_of(side TEXT) RETURNS TEXT[] LANGUAGE plpgsql AS $$
DECLARE s JSONB; found TEXT[] := '{}'; n BIGINT;
BEGIN
  SELECT CASE side WHEN 'a' THEN a ELSE b END INTO s FROM seeded;
  SELECT count(*) INTO n FROM messages WHERE conversation_id = (s->>'conversation')::UUID; IF n > 0 THEN found := found || 'messages'::TEXT; END IF;
  SELECT count(*) INTO n FROM message_reactions WHERE conversation_id = (s->>'conversation')::UUID; IF n > 0 THEN found := found || 'message_reactions'::TEXT; END IF;
  SELECT count(*) INTO n FROM contact_tags WHERE contact_id = (s->>'contact')::UUID; IF n > 0 THEN found := found || 'contact_tags'::TEXT; END IF;
  SELECT count(*) INTO n FROM contact_custom_values WHERE contact_id = (s->>'contact')::UUID; IF n > 0 THEN found := found || 'contact_custom_values'::TEXT; END IF;
  SELECT count(*) INTO n FROM pipeline_stages WHERE pipeline_id = (s->>'pipeline')::UUID; IF n > 0 THEN found := found || 'pipeline_stages'::TEXT; END IF;
  SELECT count(*) INTO n FROM broadcast_recipients WHERE broadcast_id = (s->>'broadcast')::UUID; IF n > 0 THEN found := found || 'broadcast_recipients'::TEXT; END IF;
  SELECT count(*) INTO n FROM automation_steps WHERE automation_id = (s->>'automation')::UUID; IF n > 0 THEN found := found || 'automation_steps'::TEXT; END IF;
  SELECT count(*) INTO n FROM flow_nodes WHERE flow_id = (s->>'flow')::UUID; IF n > 0 THEN found := found || 'flow_nodes'::TEXT; END IF;
  SELECT count(*) INTO n FROM flow_run_events WHERE flow_run_id = (s->>'run')::UUID; IF n > 0 THEN found := found || 'flow_run_events'::TEXT; END IF;
  RETURN found;
END $$;

-- ------------------------------------------------------------------
-- 1. Schema-wide guarantees (as postgres)
-- ------------------------------------------------------------------

SELECT is(
  ARRAY(SELECT c.relname::TEXT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity ORDER BY 1),
  '{}'::TEXT[],
  'every public table has row level security enabled');

SELECT is(
  ARRAY(SELECT c.relname::TEXT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
          AND c.relname NOT IN ('automation_pending_executions', -- service role only, by design
                                'platform_admins', 'platform_audit_log', -- 906: no client access at all
                                'billing_customers', 'billing_webhook_events', -- 909: server only
                                'billing_delinquency') -- 911: server only
        ORDER BY 1),
  '{}'::TEXT[],
  'every public table has policies (or is a reviewed service-only table)');

SELECT is(
  ARRAY(SELECT (tablename || '.' || policyname)::TEXT FROM pg_policies
        WHERE schemaname = 'public' AND (qual = 'true' OR with_check = 'true')
          -- 907: the plan catalog is public to signed-in users (read-only, no tenant data)
          AND tablename NOT IN ('billing_features', 'billing_plans', 'billing_plan_features')
        ORDER BY 1),
  '{}'::TEXT[],
  'no public policy is unconditional (USING true / WITH CHECK true)');

SELECT is(
  ARRAY(SELECT (p.tablename || '.' || p.policyname)::TEXT FROM pg_policies p JOIN tenant_tables tt ON tt.t = p.tablename
        WHERE p.schemaname = 'public' AND p.cmd IN ('SELECT', 'ALL')
          AND p.qual NOT LIKE '%is_account_member%' AND p.qual NOT LIKE '%auth.uid()%'
        ORDER BY 1),
  '{}'::TEXT[],
  'every read policy of a tenant table is scoped by membership or by the user');

-- SECURITY DEFINER functions bypass RLS. Each one a client can EXECUTE
-- was reviewed and checks auth.uid()/membership itself (or is a trigger).
SELECT is(
  ARRAY(SELECT p.proname::TEXT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND p.prorettype <> 'trigger'::regtype
          AND (has_function_privilege('anon', p.oid, 'EXECUTE')
               OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          AND p.proname NOT IN (
            'is_account_member',          -- membership of auth.uid()
            'billing_my_entitlements',    -- 907: auth.uid()'s own organization only
            'billing_my_usage',           -- 908: auth.uid()'s own organization only
            'peek_invitation',            -- by secret token hash
            'redeem_invitation',          -- auth.uid() + token
            'remove_account_member',      -- caller admin+, same account
            'set_member_role',            -- caller admin+, same account
            'transfer_account_ownership', -- caller owner, same account
            'touch_presence',             -- auth.uid() own row
            'tenant_caller_owns_account'  -- answers only for auth.uid()
          )
        ORDER BY 1),
  '{}'::TEXT[],
  'no unreviewed SECURITY DEFINER function is callable by clients');

-- ------------------------------------------------------------------
-- 2. Reads: nobody sees another tenant
-- ------------------------------------------------------------------

SELECT pg_temp.login(b_owner) FROM ids;
SELECT ok(
  pg_temp.tables_with_rows_of((SELECT acc_b FROM ids)) @> ARRAY[
    'accounts', 'br_account_profiles', 'contacts', 'br_contact_profiles', 'conversations', 'deals',
    'tags', 'custom_fields', 'contact_notes', 'pipelines', 'broadcasts', 'automations',
    'automation_logs', 'flows', 'flow_runs', 'message_templates', 'quick_replies',
    'whatsapp_config', 'api_keys', 'webhook_endpoints', 'ai_configs', 'ai_knowledge_documents',
    'ai_knowledge_chunks', 'ai_usage_log', 'notifications', 'member_presence',
    'account_invitations', 'onboarding_progress'],
  'sanity: B sees its own rows in every seeded table (the checks below are not vacuous)');
SELECT is(cardinality(pg_temp.child_rows_of('b')), 9, 'sanity: B sees its own child rows');
SELECT is((SELECT count(*) FROM storage.objects WHERE bucket_id = 'chat-media'), 1::BIGINT,
  'sanity: B can read its own chat media');
RESET ROLE;

SELECT pg_temp.login(a_owner) FROM ids;
SELECT is(pg_temp.tables_with_rows_of((SELECT acc_b FROM ids)), '{}'::TEXT[],
  'A owner sees no row of B in any table with account_id');
SELECT is(pg_temp.child_rows_of('b'), '{}'::TEXT[],
  'A owner sees no child row of B (messages, tags, stages, recipients, steps, nodes…)');
SELECT is((SELECT count(*) FROM accounts), 1::BIGINT, 'A owner sees exactly one organization');
SELECT is((SELECT count(*) FROM profiles WHERE account_id <> (SELECT acc_a FROM ids)), 0::BIGINT,
  'A owner sees no profile of another organization');
SELECT is((SELECT count(*) FROM storage.objects WHERE bucket_id = 'chat-media'), 0::BIGINT,
  'A owner cannot list B chat media');
SELECT is((SELECT count(*) FROM filter_contacts_by_tags(ARRAY[((SELECT b FROM seeded)->>'tag')::UUID])), 0::BIGINT,
  'A cannot find B contacts through filter_contacts_by_tags');
SELECT is((SELECT count(*) FROM match_ai_knowledge_fts((SELECT acc_b FROM ids), 'kb', 10)), 0::BIGINT,
  'A cannot search B knowledge base through match_ai_knowledge_fts');
RESET ROLE;

SELECT pg_temp.login(a_viewer) FROM ids;
SELECT is(pg_temp.tables_with_rows_of((SELECT acc_b FROM ids)), '{}'::TEXT[],
  'A viewer sees no row of B');
SELECT ok(pg_temp.tables_with_rows_of((SELECT acc_a FROM ids)) @> ARRAY['accounts', 'contacts', 'br_account_profiles'],
  'A viewer sees its own organization data');
RESET ROLE;

SELECT pg_temp.login_anon();
SELECT is(pg_temp.tables_with_rows_of((SELECT acc_a FROM ids)) || pg_temp.tables_with_rows_of((SELECT acc_b FROM ids)),
  '{}'::TEXT[], 'anon sees no tenant row at all');
SELECT is(pg_temp.child_rows_of('a') || pg_temp.child_rows_of('b'), '{}'::TEXT[], 'anon sees no child row');
SELECT is((SELECT count(*) FROM storage.objects), 0::BIGINT, 'anon cannot list any storage object');
RESET ROLE;

SELECT pg_temp.login(c_orphan) FROM ids;
SELECT is(pg_temp.tables_with_rows_of((SELECT acc_b FROM ids)), '{}'::TEXT[],
  'a user without profile sees nothing of B');
RESET ROLE;

-- ------------------------------------------------------------------
-- 3. Writes into another tenant
-- ------------------------------------------------------------------

SELECT pg_temp.login(a_owner) FROM ids;

SELECT throws_ok(
  format('INSERT INTO contacts (user_id, account_id, phone) VALUES (%L, %L, %L)', a_owner, acc_b, '+5511933333333'),
  '42501', NULL, 'A cannot insert a contact into B') FROM ids;
SELECT throws_ok(
  format('INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, title) VALUES (%L, %L, %L, %L, %L)',
         a_owner, acc_b, (SELECT b FROM seeded)->>'pipeline', (SELECT b FROM seeded)->>'stage', 'x'),
  '42501', NULL, 'A cannot insert a deal into B') FROM ids;
SELECT throws_ok(
  format('INSERT INTO br_account_profiles (account_id, legal_name) VALUES (%L, %L) ON CONFLICT (account_id) DO UPDATE SET legal_name = excluded.legal_name', acc_b, 'hijack'),
  '42501', NULL, 'A cannot write B organization profile') FROM ids;

-- UPDATE/DELETE of B rows silently match nothing (RLS filters them out).
-- A statement refused by column privileges (905) also changed nothing.
CREATE FUNCTION pg_temp.affected(sql TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE n BIGINT;
BEGIN
  EXECUTE sql; GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
EXCEPTION WHEN insufficient_privilege THEN RETURN 0;
END $$;

SELECT is(pg_temp.affected(format('UPDATE %I SET account_id = account_id WHERE account_id = %L', t, (SELECT acc_b FROM ids))),
          0::BIGINT, format('A cannot UPDATE B rows in %s', t))
FROM tenant_tables WHERE t NOT IN ('automation_pending_executions', 'automation_logs', 'flow_runs', 'ai_usage_log',
                                   'member_presence', 'notifications') ORDER BY t;
SELECT is(pg_temp.affected(format('DELETE FROM %I WHERE account_id = %L', t, (SELECT acc_b FROM ids))),
          0::BIGINT, format('A cannot DELETE B rows in %s', t))
FROM tenant_tables ORDER BY t;
SELECT is(pg_temp.affected(format('UPDATE accounts SET name = %L WHERE id = %L', 'pwned', (SELECT acc_b FROM ids))),
          0::BIGINT, 'A cannot rename organization B');
SELECT is(pg_temp.affected(format('DELETE FROM messages WHERE conversation_id = %L', (SELECT b FROM seeded)->>'conversation')),
          0::BIGINT, 'A cannot delete B messages');

-- Moving an own row into B is rejected by WITH CHECK.
SELECT throws_ok(
  format('UPDATE contacts SET account_id = %L WHERE id = %L', acc_b, (SELECT a FROM seeded)->>'contact'),
  '42501', NULL, 'A cannot move its contact into B') FROM ids;

-- ------------------------------------------------------------------
-- 4. References into another tenant (903: tenant_enforce_refs)
-- ------------------------------------------------------------------

SELECT throws_ok(
  format('INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, contact_id, title) VALUES (%L, %L, %L, %L, %L, %L)',
         a_owner, acc_a, (SELECT a FROM seeded)->>'pipeline', (SELECT a FROM seeded)->>'stage', (SELECT b FROM seeded)->>'contact', 'x'),
  '42501', NULL, 'A cannot create a deal on B contact') FROM ids;
SELECT throws_ok(
  format('INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, title) VALUES (%L, %L, %L, %L, %L)',
         a_owner, acc_a, (SELECT a FROM seeded)->>'pipeline', (SELECT b FROM seeded)->>'stage', 'x'),
  '42501', NULL, 'A cannot put a deal in a stage of B') FROM ids;
SELECT throws_ok(
  format('INSERT INTO contact_tags (contact_id, tag_id) VALUES (%L, %L)', (SELECT a FROM seeded)->>'contact', (SELECT b FROM seeded)->>'tag'),
  '42501', NULL, 'A cannot tag its contact with a tag of B');
SELECT throws_ok(
  format('INSERT INTO contact_custom_values (contact_id, custom_field_id, value) VALUES (%L, %L, %L)',
         (SELECT a FROM seeded)->>'contact', (SELECT b FROM seeded)->>'custom_field', 'x'),
  '42501', NULL, 'A cannot fill a custom field of B');
SELECT throws_ok(
  format('INSERT INTO messages (conversation_id, sender_type, content_type, content_text, reply_to_message_id) VALUES (%L, %L, %L, %L, %L)',
         (SELECT a FROM seeded)->>'conversation', 'agent', 'text', 'x', (SELECT b FROM seeded)->>'message'),
  '42501', NULL, 'A cannot reply to a message of B');
SELECT throws_ok(
  format('INSERT INTO broadcast_recipients (broadcast_id, contact_id) VALUES (%L, %L)', (SELECT a FROM seeded)->>'broadcast', (SELECT b FROM seeded)->>'contact'),
  '42501', NULL, 'A cannot add a B contact to its campaign');
SELECT throws_ok(
  format('INSERT INTO contact_notes (contact_id, user_id, account_id, note_text) VALUES (%L, %L, %L, %L)',
         (SELECT b FROM seeded)->>'contact', a_owner, acc_a, 'x'),
  '42501', NULL, 'A cannot attach a note to a B contact') FROM ids;
SELECT throws_ok(
  format('INSERT INTO conversations (user_id, account_id, contact_id) VALUES (%L, %L, %L)', a_owner, acc_a, (SELECT b FROM seeded)->>'contact'),
  '42501', NULL, 'A cannot open a conversation with a B contact') FROM ids;

-- Assigning to a user of B is neutralised (cleared), so B gets no notification.
UPDATE conversations SET assigned_agent_id = (SELECT b_owner FROM ids)
WHERE id = ((SELECT a FROM seeded)->>'conversation')::UUID;
SELECT is((SELECT assigned_agent_id FROM conversations WHERE id = ((SELECT a FROM seeded)->>'conversation')::UUID), NULL,
  'assigning A conversation to a B user is cleared');
RESET ROLE;
SELECT is((SELECT count(*) FROM notifications WHERE user_id = (SELECT b_owner FROM ids) AND account_id = (SELECT acc_a FROM ids)),
  0::BIGINT, 'B user received no notification about A data');

-- The engine (service role) is held to the same rule.
SELECT pg_temp.login_service();
SELECT throws_ok(
  format('INSERT INTO contact_tags (contact_id, tag_id) VALUES (%L, %L)', (SELECT a FROM seeded)->>'contact', (SELECT b FROM seeded)->>'tag'),
  '42501', NULL, 'service role cannot link tenants either (bad id in an automation config)');
RESET ROLE;

-- ------------------------------------------------------------------
-- 5. Privileged functions
-- ------------------------------------------------------------------

SELECT pg_temp.login(a_owner) FROM ids;
SELECT throws_ok(format('SELECT record_webhook_failure(%L, 1)', (SELECT b FROM seeded)->>'endpoint'),
  '42501', NULL, 'A cannot disable B webhook via record_webhook_failure');
SELECT throws_ok(format('SELECT claim_ai_reply_slot(%L, 20)', (SELECT b FROM seeded)->>'conversation'),
  '42501', NULL, 'A cannot burn B AI reply slots');
SELECT throws_ok(format('SELECT _bcast_bump(%L, %L, 100)', (SELECT b FROM seeded)->>'broadcast', 'sent_count'),
  '42501', NULL, 'A cannot tamper with B campaign counters');
SELECT throws_ok('SELECT merge_duplicate_contacts()', '42501', NULL, 'clients cannot run the global contact merge');
SELECT throws_ok(format('SELECT tenant_account_of(%L, %L)', 'contacts', (SELECT b FROM seeded)->>'contact'),
  '42501', NULL, 'clients cannot use tenant_account_of as an oracle');
SELECT throws_ok(format('SELECT set_member_role(%L, %L)', b_owner, 'viewer'),
  NULL, NULL, 'A admin cannot change the role of a B member') FROM ids;
SELECT throws_ok(format('SELECT remove_account_member(%L)', b_owner),
  NULL, NULL, 'A admin cannot remove a B member') FROM ids;
RESET ROLE;
SELECT is((SELECT is_active FROM webhook_endpoints WHERE id = ((SELECT b FROM seeded)->>'endpoint')::UUID), true,
  'B webhook is still active');

-- ------------------------------------------------------------------
-- 6. Profiles cannot be pointed at another tenant
-- ------------------------------------------------------------------

SELECT pg_temp.login(a_owner) FROM ids;
SELECT throws_ok(format('UPDATE profiles SET account_id = %L WHERE user_id = %L', acc_b, a_owner),
  '42501', NULL, 'A cannot move its own profile into B') FROM ids;
RESET ROLE;
SELECT pg_temp.login(a_viewer) FROM ids;
SELECT throws_ok(format('UPDATE profiles SET account_role = %L WHERE user_id = %L', 'owner', a_viewer),
  '42501', NULL, 'a viewer cannot promote itself to owner') FROM ids;
RESET ROLE;
SELECT pg_temp.login(c_orphan) FROM ids;
SELECT throws_ok(
  format('INSERT INTO profiles (user_id, full_name, email, account_id, account_role) VALUES (%L, %L, %L, %L, %L)',
         c_orphan, 'x', 'c-orphan@iso.test', acc_b, 'owner'),
  '42501', NULL, 'a user without profile cannot attach itself to B as owner') FROM ids;
RESET ROLE;

-- ------------------------------------------------------------------
-- 7. Organization (accounts + br_account_profiles)
-- ------------------------------------------------------------------

SELECT pg_temp.login(a_owner) FROM ids;
SELECT is(pg_temp.affected(format('UPDATE accounts SET name = %L WHERE id = %L', 'Org A renamed', (SELECT acc_a FROM ids))),
  1::BIGINT, 'A owner can rename its organization');
SELECT throws_ok(format('UPDATE accounts SET status = %L WHERE id = %L', 'active', acc_a),
  '42501', NULL, 'A owner cannot change its own status (billing only)') FROM ids;
SELECT throws_ok(format('UPDATE accounts SET trial_ends_at = now() + interval %L WHERE id = %L', '10 years', acc_a),
  '42501', NULL, 'A owner cannot extend its own trial') FROM ids;
SELECT throws_ok(format('UPDATE accounts SET owner_user_id = %L WHERE id = %L', a_viewer, acc_a),
  '42501', NULL, 'owner_user_id only changes through transfer_account_ownership') FROM ids;
SELECT lives_ok(
  format('UPDATE br_account_profiles SET trade_name = %L, phone = %L, email = %L, postal_code = %L, city = %L, state = %L WHERE account_id = %L',
         'Org A', '+5521999999999', 'contato@orga.com.br', '20040002', 'Rio de Janeiro', 'RJ', acc_a),
  'A owner can edit its registration data') FROM ids;
SELECT throws_ok(format('UPDATE br_account_profiles SET tax_id = %L WHERE account_id = %L', '11222333000182', acc_a),
  '23514', NULL, 'an invalid CNPJ is rejected') FROM ids;
SELECT throws_ok(format('UPDATE br_account_profiles SET phone = %L WHERE account_id = %L', '(21) 99999-9999', acc_a),
  '23514', NULL, 'phone must be stored as E.164') FROM ids;
SELECT throws_ok(format('UPDATE br_account_profiles SET account_id = %L WHERE account_id = %L', acc_b, acc_a),
  NULL, NULL, 'the organization profile cannot be moved to another account') FROM ids;
RESET ROLE;

SELECT pg_temp.login(a_viewer) FROM ids;
SELECT is(pg_temp.affected(format('UPDATE accounts SET name = %L WHERE id = %L', 'viewer', (SELECT acc_a FROM ids))),
  0::BIGINT, 'a viewer cannot rename the organization');
SELECT is(pg_temp.affected(format('UPDATE br_account_profiles SET legal_name = %L WHERE account_id = %L', 'viewer', (SELECT acc_a FROM ids))),
  0::BIGINT, 'a viewer cannot edit the registration data');
SELECT is((SELECT trade_name FROM br_account_profiles), 'Org A', 'a viewer can read its organization profile');
RESET ROLE;

SELECT pg_temp.login_service();
SELECT lives_ok(format('UPDATE accounts SET status = %L WHERE id = %L', 'past_due', acc_a),
  'billing (service role) can change the status') FROM ids;
RESET ROLE;
SELECT is((SELECT status FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'past_due', 'status changed');
SELECT ok((SELECT status_changed_at = now() FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'status_changed_at is stamped');
SELECT throws_ok(format('UPDATE accounts SET status = %L WHERE id = %L', 'deleted', acc_a),
  '23514', NULL, 'only the five lifecycle states exist') FROM ids;

-- ------------------------------------------------------------------
-- 8. Onboarding progress (904)
-- ------------------------------------------------------------------

SELECT pg_temp.login(a_viewer) FROM ids;
SELECT is(pg_temp.affected(format('UPDATE onboarding_progress SET completed_at = now() WHERE account_id = %L', (SELECT acc_a FROM ids))),
  0::BIGINT, 'a viewer cannot complete the onboarding');
RESET ROLE;
SELECT pg_temp.login(a_owner) FROM ids;
SELECT is(pg_temp.affected(format('UPDATE onboarding_progress SET current_step = %L, completed_by = %L WHERE account_id = %L',
  'whatsapp', (SELECT b_owner FROM ids), (SELECT acc_a FROM ids))), 1::BIGINT, 'the owner advances the onboarding');
SELECT is((SELECT completed_by FROM onboarding_progress WHERE account_id = (SELECT acc_a FROM ids)), NULL,
  'completed_by cannot point at a user of another organization');
SELECT throws_ok(format('UPDATE onboarding_progress SET current_step = %L WHERE account_id = %L', 'billing', acc_a),
  '23514', NULL, 'only the known onboarding steps exist') FROM ids;
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
