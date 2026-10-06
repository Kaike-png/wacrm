#!/usr/bin/env bash
# Database tests (pgTAP) — tenant isolation and RLS (docs/TENANCY.md).
#
#   npm run test:db
#
# Runs every supabase/tests/database/*.test.sql inside a rolled-back
# transaction against a database with all migrations applied:
#   1. $DATABASE_URL with psql, if set;
#   2. otherwise the local Supabase container (`supabase start`), via docker.
# (`supabase test db` runs the same files through pg_prove.)
#
# Exit status 1 if any test fails, errors, or the plan is incomplete.
set -uo pipefail
cd "$(dirname "$0")/../.."

run_sql() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=0 -f "$1"
  else
    local container
    container="$(docker ps --format '{{.Names}}' | grep -m1 '^supabase_db_')" || {
      echo "test-db: no DATABASE_URL and no running supabase_db_* container (run: supabase start)" >&2
      exit 2
    }
    docker exec -i "$container" psql -U postgres -X -q -t -A -v ON_ERROR_STOP=0 < "$1"
  fi
}

status=0
for file in supabase/tests/database/*.test.sql; do
  out="$(run_sql "$file" 2>&1)"
  total="$(grep -cE '^(ok|not ok) ' <<<"$out")"
  failed="$(grep -E '^not ok ' <<<"$out")"
  errors="$(grep -E '^(ERROR|psql:.*ERROR)' <<<"$out" | grep -v 'current transaction is aborted' | head -5)"
  plan="$(grep -oE '^1\.\.[0-9]+' <<<"$out" | tail -1)"
  if [[ -n "$failed" || -n "$errors" || -z "$plan" || "${plan#1..}" != "$total" ]]; then
    status=1
    echo "✗ $file ($total tests, plan ${plan:-none})"
    [[ -n "$failed" ]] && echo "$failed" | sed 's/^/    /'
    [[ -n "$errors" ]] && echo "$errors" | sed 's/^/    /'
    grep -E '^# ' <<<"$out" | head -20 | sed 's/^/    /'
  else
    echo "✓ $file ($total tests)"
  fi
done
exit $status
