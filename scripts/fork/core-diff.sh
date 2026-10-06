#!/usr/bin/env bash
# Lists every upstream-owned ("core") file this fork has changed, so a
# merge can be planned before it starts. Fork-owned paths are excluded.
#
#   scripts/fork/core-diff.sh            # vs merge-base with upstream/main
#   scripts/fork/core-diff.sh <ref>      # vs an explicit upstream ref/tag
#
# Requires the `upstream` remote (see docs/UPSTREAM_STRATEGY.md).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

ref="${1:-upstream/main}"
if ! git rev-parse --verify --quiet "$ref" >/dev/null; then
  echo "error: '$ref' not found. Run: git remote add upstream https://github.com/ArnasDon/wacrm.git && git fetch upstream" >&2
  exit 1
fi
base="$(git merge-base HEAD "$ref")"

# Fork-owned paths: never conflict with upstream by construction.
owned='^(src/custom/|src/billing/|src/modules/|src/integrations/|src/app/(.*/)?\(fork\)/|supabase/migrations/9[0-9][0-9]_|scripts/fork/|public/brand/|docs/SAAS_BR_ANALYSIS\.md$|docs/UPSTREAM_STRATEGY\.md$|docs/BRANDING\.md$|docs/LOCALIZATION\.md$|docs/BRAZILIAN_CONTACTS\.md$|docs/TENANCY\.md$|docs/ONBOARDING\.md$|docs/WHATSAPP_SAAS\.md$|docs/PLATFORM_ADMIN\.md$|docs/PLANS\.md$|docs/USAGE\.md$|docs/BILLING\.md$|docs/ASAAS\.md$|docs/DELINQUENCY\.md$|supabase/tests/|\.github/workflows/fork-)'

echo "upstream ref : $ref"
echo "merge-base   : $(git log -1 --format='%h %ad %s' --date=short "$base")"
echo "fork commits : $(git rev-list --count "$base"..HEAD)"
echo "upstream new : $(git rev-list --count HEAD.."$ref") commit(s) not merged yet"
echo

changed="$(git diff --name-status "$base" -- . | grep -Ev "\s${owned#^}" || true)"
# Also include uncommitted edits to core files.
dirty="$(git status --porcelain --untracked-files=no | awk '{print $2}' | grep -Ev "${owned}" || true)"

echo "== Core files changed since merge-base (committed) =="
if [ -n "$changed" ]; then echo "$changed"; else echo "(none)"; fi
echo
echo "== Core files with uncommitted edits =="
if [ -n "$dirty" ]; then echo "$dirty"; else echo "(none)"; fi
echo
echo "== FORK-PATCH markers in core =="
git grep -n 'FORK-PATCH(P-' -- src ':!src/custom' ':!src/billing' ':!src/modules' ':!src/integrations' || echo "(none)"

if [ "$(git rev-list --count HEAD.."$ref")" -gt 0 ]; then
  echo
  echo "== Core files touched by BOTH sides (likely conflicts) =="
  ours="$(git diff --name-only "$base" HEAD | grep -Ev "${owned}" || true)"
  theirs="$(git diff --name-only "$base" "$ref")"
  both="$(comm -12 <(echo "$ours" | sort) <(echo "$theirs" | sort))"
  if [ -n "$both" ]; then echo "$both"; else echo "(none)"; fi
fi
