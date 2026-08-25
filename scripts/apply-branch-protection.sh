#!/usr/bin/env bash
#
# Branch protection as a checkable artifact.
#
# docs/ci-branch-protection.md describes the intended required-check set in
# prose. Prose drifts silently: on 2026-08-26 `main` was found with an EMPTY
# required-check list while the runbook still claimed four blocking checks.
# This script makes the intended state executable, so drift is detectable
# instead of merely documented.
#
#   ./scripts/apply-branch-protection.sh            # --check (read-only, default)
#   ./scripts/apply-branch-protection.sh --apply    # write the intended state
#
# --check exits non-zero on drift, which is what makes it usable from the
# sprint-rollover checklist and from CI.
#
# Requires: gh (authenticated, `repo` scope), python3.

set -euo pipefail

REPO="${CLOKR_REPO:-sebastianzabel/clokr}"

# Branches that carry releases and therefore must be protected.
BRANCHES=(main release/1.9.x)

# The merge-blocking check set. Job names come from .github/workflows/ci.yml.
#
# Deliberately NOT included:
#   lighthouse, axe-scan     — run with continue-on-error by design; promotion
#                              to blocking is scheduled for Phase 73.
#   visual-regression        — listed as required in the runbook's table but
#                              absent from its payload. The job always reports
#                              (only its steps are path-filtered), so it is
#                              technically eligible; it is left advisory because
#                              the baselines are arm64-local vs amd64-CI and it
#                              fails for reasons unrelated to the change under
#                              review. Add it here once the baselines are fixed.
REQUIRED_CHECKS=(test codeql secret-scan docker)

MODE="check"
case "${1:-}" in
  --apply) MODE="apply" ;;
  --check | "") MODE="check" ;;
  -h | --help)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "unknown argument: $1 (expected --check or --apply)" >&2
    exit 2
    ;;
esac

# ── Helpers ───────────────────────────────────────────────────────────

# Current protection for a branch, or the literal `null` if unprotected.
fetch_protection() {
  local branch="$1"
  gh api "/repos/${REPO}/branches/${branch}/protection" 2>/dev/null || echo "null"
}

# ── Check mode ────────────────────────────────────────────────────────

drift=0

export WANT_CHECKS="${REQUIRED_CHECKS[*]}"

for branch in "${BRANCHES[@]}"; do
  current="$(fetch_protection "$branch")"

  report="$(
    printf '%s' "$current" | BRANCH="$branch" python3 -c '
import json, sys, os

want = os.environ["WANT_CHECKS"].split()
branch = os.environ["BRANCH"]
raw = sys.stdin.read().strip()

try:
    cur = json.loads(raw)
except json.JSONDecodeError:
    cur = None

if not cur:
    print(f"DRIFT\t{branch}\tno branch protection configured at all")
    sys.exit(0)

rsc = cur.get("required_status_checks") or {}
have = sorted(c["context"] for c in rsc.get("checks", []))
strict = rsc.get("strict")

problems = []
missing = [c for c in want if c not in have]
extra = [c for c in have if c not in want]
if missing:
    problems.append("missing required checks: " + ", ".join(missing))
if extra:
    problems.append("unexpected required checks: " + ", ".join(extra))
if strict is not True:
    problems.append(f"strict is {strict!r}, expected True")

if problems:
    for p in problems:
        print(f"DRIFT\t{branch}\t{p}")
else:
    print(f"OK\t{branch}\t{len(have)} required checks, strict=True")
'
  )" || true

  while IFS=$'\t' read -r status br msg; do
    [ -z "${status:-}" ] && continue
    if [ "$status" = "OK" ]; then
      printf '  \033[32m✓\033[0m %-16s %s\n' "$br" "$msg"
    else
      printf '  \033[31m✗\033[0m %-16s %s\n' "$br" "$msg"
      drift=1
    fi
  done <<<"$report"
done

if [ "$MODE" = "check" ]; then
  if [ "$drift" -ne 0 ]; then
    echo
    echo "Branch protection has drifted. Re-apply with:"
    echo "  $0 --apply"
    exit 1
  fi
  exit 0
fi

# ── Apply mode ────────────────────────────────────────────────────────
#
# GitHub's protection PUT replaces the whole object: any field omitted from
# the body is reset to its default. So every apply reads the current state
# first and carries the non-check settings forward unchanged. This script
# only ever asserts the required-check set — it never decides review counts
# or admin enforcement on your behalf.

echo
for branch in "${BRANCHES[@]}"; do
  current="$(fetch_protection "$branch")"

  body="$(
    printf '%s' "$current" | python3 -c '
import json, sys, os

want = os.environ["WANT_CHECKS"].split()
raw = sys.stdin.read().strip()

try:
    cur = json.loads(raw)
except json.JSONDecodeError:
    cur = None
cur = cur or {}

# Carry forward everything we are not asserting. Defaults below match the
# Phase 70 pre-state recorded in docs/ci-branch-protection.md.
reviews = cur.get("required_pull_request_reviews")
if reviews:
    reviews = {
        "required_approving_review_count": reviews.get("required_approving_review_count", 0),
        "dismiss_stale_reviews": reviews.get("dismiss_stale_reviews", False),
        "require_code_owner_reviews": reviews.get("require_code_owner_reviews", False),
        "require_last_push_approval": reviews.get("require_last_push_approval", False),
    }
else:
    reviews = {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews": False,
        "require_code_owner_reviews": False,
        "require_last_push_approval": False,
    }

body = {
    "required_status_checks": {
        "strict": True,
        # app_id -1 = any GitHub App may post this context. Required because
        # these are Actions job names, not app-bound checks.
        "checks": [{"context": c, "app_id": -1} for c in want],
    },
    "enforce_admins": bool((cur.get("enforce_admins") or {}).get("enabled", False)),
    "required_pull_request_reviews": reviews,
    "restrictions": None,
    "allow_force_pushes": bool((cur.get("allow_force_pushes") or {}).get("enabled", False)),
    "allow_deletions": bool((cur.get("allow_deletions") or {}).get("enabled", False)),
}
json.dump(body, sys.stdout)
'
  )"

  printf '  applying to %s ... ' "$branch"
  if printf '%s' "$body" | gh api --method PUT \
    -H "Accept: application/vnd.github+json" \
    "/repos/${REPO}/branches/${branch}/protection" \
    --input - >/dev/null; then
    echo "done"
  else
    echo "FAILED"
    exit 1
  fi
done

echo
echo "Re-checking:"
exec "$0" --check
