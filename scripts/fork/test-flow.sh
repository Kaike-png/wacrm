#!/usr/bin/env bash
# Commercial flow integration test against the LOCAL Supabase (fork,
# docs/MVP_FOUNDATION_AUDIT.md §29).
#
#   npm run test:flow
#
# Loads .env.local in a subshell (never leaks into your shell), forces the
# mock gateway, and runs src/billing/payments/commercial-flow.integration.test.ts.
# Refuses to run against a non-local Supabase URL: it creates and deletes
# an organization.
set -euo pipefail
cd "$(dirname "$0")/../.."

(
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
  case "${NEXT_PUBLIC_SUPABASE_URL:-}" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) echo "test-flow: NEXT_PUBLIC_SUPABASE_URL is not local; refusing" >&2; exit 2 ;;
  esac
  export FORK_DB_INTEGRATION=1 BILLING_PROVIDER=mock NODE_ENV=test TZ=UTC
  npx vitest run src/billing/payments/commercial-flow.integration.test.ts
)
