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
#
# `main` only: the 1.9.x patch line is retired. Development and tagging both
# happen on main now (see docs/release-process.md). release/1.9.x is frozen
# history — its release tags are independent objects and survive the branch,
# and int pins a tag rather than tracking the branch, so nothing depends on
# it staying protected. Re-add a branch here the moment a maintenance line
# is reopened.
BRANCHES=(main)

# The merge-blocking check set. These are CHECK RUN names as GitHub reports
# them, which is not always the job id in ci.yml — a matrix job reports one
# check per leg, named after the whole `include` entry.
#
# `docker-gate` rather than `docker` for exactly that reason: `docker` is a
# matrix job and never reports a check under its bare name when it runs, so
# requiring it would leave every PR waiting on a status that never arrives.
# That is what the runbook's payload asked for, and the likeliest reason
# main's list was found empty. docker-gate is a no-op job whose only purpose
# is to be a stable context. See the comment on it in ci.yml.
#
# observed_check_names() below refuses to apply a context nobody reports, so
# a new check must have run at least once before it can be required.
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
REQUIRED_CHECKS=(
  test
  codeql
  secret-scan
  docker-gate
)

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

# Check-run names GitHub actually reported, unioned across several recent PRs.
#
# One commit is not a safe reference. A matrix job reports one check per leg
# when it runs ("docker (clokr-api, ...)") but a single check under the bare
# job name when it is skipped ("docker") — so a PR whose `test` failed shows
# only the skipped form, and a PR that went green shows only the expanded
# form. Sampling one commit would reject whichever set it happened to miss.
observed_check_names() {
  local shas
  shas="$(gh pr list --state all --limit "${SAMPLE_PRS:-8}" --json headRefOid \
    --jq '.[].headRefOid' 2>/dev/null || true)"
  [ -z "$shas" ] && shas="$(gh api "/repos/${REPO}/commits/main" --jq .sha 2>/dev/null || true)"
  [ -z "$shas" ] && return 0
  while IFS= read -r sha; do
    [ -z "$sha" ] && continue
    gh api "/repos/${REPO}/commits/${sha}/check-runs" --paginate \
      --jq '.check_runs[].name' 2>/dev/null || true
  done <<<"$shas" | sort -u
}

# ── Check mode ────────────────────────────────────────────────────────

drift=0

# Newline-delimited: check names contain spaces and commas (matrix legs).
WANT_CHECKS="$(printf '%s\n' "${REQUIRED_CHECKS[@]}")"
export WANT_CHECKS

for branch in "${BRANCHES[@]}"; do
  current="$(fetch_protection "$branch")"

  report="$(
    printf '%s' "$current" | BRANCH="$branch" python3 -c '
import json, sys, os

want = [c for c in os.environ["WANT_CHECKS"].splitlines() if c.strip()]
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
#
# Guard first: a required context that no workflow reports never resolves, so
# the PR waits forever and the branch is effectively frozen. That failure mode
# is invisible until someone opens the next PR, so refuse it up front.

echo "Verifying every required context is actually reported ..."
observed="$(observed_check_names)"
if [ -z "$observed" ]; then
  echo "  ! could not read any check runs — skipping verification" >&2
else
  unknown=0
  for check in "${REQUIRED_CHECKS[@]}"; do
    if ! printf '%s\n' "$observed" | grep -qxF "$check"; then
      echo "  ✗ no workflow reports a check named: $check" >&2
      unknown=1
    fi
  done
  if [ "$unknown" -ne 0 ]; then
    echo >&2
    echo "  Contexts observed on the reference commit:" >&2
    printf '%s\n' "$observed" | sed 's/^/    /' >&2
    echo >&2
    echo "  Refusing to apply. A required check that is never reported blocks" >&2
    echo "  every pull request indefinitely. Fix REQUIRED_CHECKS in $0." >&2
    exit 1
  fi
  echo "  all ${#REQUIRED_CHECKS[@]} contexts confirmed"
fi

echo
for branch in "${BRANCHES[@]}"; do
  current="$(fetch_protection "$branch")"

  body="$(
    printf '%s' "$current" | python3 -c '
import json, sys, os

want = [c for c in os.environ["WANT_CHECKS"].splitlines() if c.strip()]
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
