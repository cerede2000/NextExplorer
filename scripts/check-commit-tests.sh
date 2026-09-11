#!/usr/bin/env bash
#
# Refuse a commit that changes application code without touching a test.
#
# The rule is that a change in behaviour arrives with the test that holds it,
# in the same commit. Measured over v3.0.2..v3.5.0 it held for 91 commits and
# not for 12, and three of the twelve touched access control — each followed
# by a test later, or not, with nothing to say which.
#
# Some changes rightly carry no test: a refactor under tests that already
# exist, a move, a rename. Those say so with a trailer, so the exception is a
# decision someone wrote down rather than something nobody noticed:
#
#     No-test: pure extraction, covered by tests/routes/shares.test.js
#
# Usage:  scripts/check-commit-tests.sh <base>..<head>
#
set -euo pipefail

RANGE="${1:?usage: $0 <base>..<head>}"

CODE='^(backend|frontend)/src/.*\.(js|mjs|cjs|vue)$'
TESTS='^backend/tests/|\.spec\.js$|^frontend/e2e/'

offenders=0
checked=0
for sha in $(git rev-list --no-merges "$RANGE"); do
  checked=$((checked + 1))
  files="$(git show --name-only --format= "$sha")"
  code="$(printf '%s\n' "$files" | grep -E "$CODE" | grep -vE '\.spec\.js$' || true)"
  [ -n "$code" ] || continue
  printf '%s\n' "$files" | grep -qE "$TESTS" && continue

  reason="$(git log -1 --format='%(trailers:key=No-test,valueonly)' "$sha" | sed '/^$/d' | head -1)"
  [ -n "$reason" ] && continue

  offenders=$((offenders + 1))
  echo "✗ $(git log -1 --format='%h %s' "$sha")"
  printf '%s\n' "$code" | sed 's/^/    /'
done

if [ "$offenders" -gt 0 ]; then
  echo
  echo "$offenders commit(s) change application code without a test."
  echo "Add the test to the commit, or say why there is none with a trailer:"
  echo "    No-test: <reason>"
  exit 1
fi
echo "OK: $checked commit(s) checked; every code change carries a test or a stated reason."
