#!/usr/bin/env bash
# Concurrency test for plan limits (fork, docs/MVP_FOUNDATION_AUDIT.md).
#
#   npm run test:db:race
#
# pgTAP runs in ONE session, so it cannot show a race. This script commits
# a throwaway organization, fires N concurrent transactions that each try
# to create "the last allowed" item, and checks the plan limit held:
#
#   max_automations (START = 5): 4 exist, 6 concurrent inserts → exactly 1 wins
#   max_users       (START = 2): owner + 3 concurrent invitations → exactly 1 wins
#
# Uses $DATABASE_URL (psql) or the local supabase_db_* container. Always
# deletes its fixtures (trap). Exit 1 on failure.
set -uo pipefail
cd "$(dirname "$0")/../.."

psql_run() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 "$@"
  else
    local container
    container="$(docker ps --format '{{.Names}}' | grep -m1 '^supabase_db_')" || {
      echo "race: no DATABASE_URL and no running supabase_db_* container" >&2
      exit 2
    }
    docker exec -i "$container" psql -U postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"
  fi
}

UID_OWNER="eeeeeeee-7777-4000-8000-$(printf '%012d' $((RANDOM * RANDOM)))"
cleanup() {
  psql_run -c "DELETE FROM public.accounts WHERE id = (SELECT account_id FROM public.profiles WHERE user_id = '$UID_OWNER');
               DELETE FROM auth.users WHERE id = '$UID_OWNER';" >/dev/null 2>&1
}
trap cleanup EXIT

ACC="$(psql_run -c "
  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-000000000000', '$UID_OWNER', 'authenticated', 'authenticated',
          'race-$UID_OWNER@race.test', '', now(), '{}', now(), now());
  INSERT INTO public.billing_subscriptions (account_id, plan_code)
  SELECT account_id, 'start' FROM public.profiles WHERE user_id = '$UID_OWNER'
  ON CONFLICT (account_id) DO UPDATE SET plan_code = 'start';
  SELECT account_id FROM public.profiles WHERE user_id = '$UID_OWNER';")"
ACC="$(tr -d '[:space:]' <<<"$ACC")"
[[ -n "$ACC" ]] || { echo "race: could not create the fixture organization" >&2; exit 1; }

psql_run -c "INSERT INTO public.automations (user_id, account_id, name, trigger_type, is_active)
             SELECT '$UID_OWNER', '$ACC', 'race ' || g, 'new_contact_created', false FROM generate_series(1, 4) g;" >/dev/null

status=0
race() { # $1 label, $2 sql, $3 parallel, $4 expected total, $5 count sql
  local pids=() i
  for ((i = 1; i <= $3; i++)); do
    psql_run -c "BEGIN; $2; SELECT pg_sleep(0.4); COMMIT;" >/dev/null 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  local total
  total="$(tr -d '[:space:]' <<<"$(psql_run -c "$5")")"
  if [[ "$total" == "$4" ]]; then
    echo "✓ $1: $3 concurrent creations, limit held ($total)"
  else
    echo "✗ $1: expected $4, got $total (race condition)"
    status=1
  fi
}

race "max_automations" \
  "INSERT INTO public.automations (user_id, account_id, name, trigger_type, is_active) VALUES ('$UID_OWNER', '$ACC', 'race x', 'new_contact_created', false)" \
  6 5 "SELECT count(*) FROM public.automations WHERE account_id = '$ACC'"

race "max_users" \
  "INSERT INTO public.account_invitations (account_id, token_hash, role, expires_at) VALUES ('$ACC', md5(random()::text), 'agent', now() + interval '1 day')" \
  3 2 "SELECT (SELECT count(*) FROM public.profiles WHERE account_id = '$ACC') + (SELECT count(*) FROM public.account_invitations WHERE account_id = '$ACC')"

exit $status
