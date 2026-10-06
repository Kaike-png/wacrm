#!/usr/bin/env bash
# Grant / revoke / list platform admins (fork, docs/PLATFORM_ADMIN.md).
#
#   scripts/fork/platform-admin.sh grant  ana@empresa.com "motivo opcional"
#   scripts/fork/platform-admin.sh revoke ana@empresa.com
#   scripts/fork/platform-admin.sh list
#
# Talks to the database directly, on purpose: the application cannot
# create platform admins (no route, no client grant). Uses $DATABASE_URL
# when set (production: the Postgres connection string, as a role that
# owns the functions, e.g. postgres), otherwise the local Supabase
# container (supabase_db_<project>).
#
# The grant/revoke is recorded in platform_audit_log with the operator
# ($PLATFORM_OPERATOR, default: $USER@hostname) as the actor.
set -euo pipefail

cmd="${1:-}"
email="${2:-}"
note="${3:-}"
operator="${PLATFORM_OPERATOR:-${USER:-operator}@$(hostname)}"

psql_run() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qAt "$@"
  else
    local container="${SUPABASE_DB_CONTAINER:-supabase_db_wacrm}"
    docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"
  fi
}

case "$cmd" in
  grant)
    [[ -n "$email" ]] || { echo "usage: $0 grant <email> [note]" >&2; exit 2; }
    psql_run -v email="$email" -v op="$operator" -v note="$note" <<'SQL'
SELECT 'granted: ' || public.platform_grant_admin(:'email', :'op', NULLIF(:'note', ''));
SQL
    ;;
  revoke)
    [[ -n "$email" ]] || { echo "usage: $0 revoke <email>" >&2; exit 2; }
    psql_run -v email="$email" -v op="$operator" <<'SQL'
SELECT CASE WHEN public.platform_revoke_admin(:'email', :'op') THEN 'revoked' ELSE 'not an admin' END;
SQL
    ;;
  list)
    psql_run <<'SQL'
SELECT u.email || '  (since ' || to_char(pa.granted_at, 'YYYY-MM-DD') || COALESCE(', by ' || pa.granted_by, '') || ')'
  FROM public.platform_admins pa JOIN auth.users u ON u.id = pa.user_id ORDER BY pa.granted_at;
SQL
    ;;
  *)
    echo "usage: $0 grant <email> [note] | revoke <email> | list" >&2
    exit 2
    ;;
esac
