#!/usr/bin/env bash
# scripts/prod-deploy.sh — manual prod-deploy helper for the operator.
#
# Per Phase 71 decision D-04: this script is NEVER invoked by CI.
# the operator runs it from his operator machine when he wants to deploy.
#
# Usage:
#   ./scripts/prod-deploy.sh                 # deploy version currently in prod-host's .env
#   ./scripts/prod-deploy.sh v1.8.0          # deploy specific version (updates .env on prod-host)
#
# Configuration (env vars; defaults documented in docs/prod-deploy.md):
#   DMZ_HOST       — ssh hostname/alias for prod-host (REQUIRED)
#   CLOKR_DIR      — remote directory containing docker-compose.prod.yml + .env (default: /opt/clokr)
#   BASE_URL       — public base URL for smoke probes (default: https://clokr.example.com)
#   COMPOSE_FILE   — compose filename on prod-host (default: docker-compose.prod.yml)
#
# Prerequisites:
#   - SSH access to ${DMZ_HOST} as user with docker permissions
#   - prod-host has docker-compose.prod.yml + .env at ${CLOKR_DIR}
#   - jq available on the operator machine
#
# Exit codes:
#   0  — deploy succeeded + smoke passed
#   1  — pre-flight check failed (missing host, no jq, etc.)
#   2  — ssh/docker step failed
#   3  — smoke test failed (health or version mismatch — see docs/prod-deploy.md § Rollback)

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
DMZ_HOST="${DMZ_HOST:?Set DMZ_HOST to the prod-host ssh hostname/alias}"
CLOKR_DIR="${CLOKR_DIR:-/opt/clokr}"
BASE_URL="${BASE_URL:-https://clokr.example.com}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

# ── Pre-flight ───────────────────────────────────────────────────────────────
command -v jq  >/dev/null || { echo "ERROR: jq required on operator machine";  exit 1; }
command -v ssh >/dev/null || { echo "ERROR: ssh required on operator machine"; exit 1; }

# ── Arg parsing ──────────────────────────────────────────────────────────────
TARGET_VERSION="${1:-}"   # optional: pin to a specific version

# WR-02: Validate TARGET_VERSION against a strict semver allowlist BEFORE it is
# interpolated into the remote `.env` mutation. Without this guard a typo-ed arg
# containing `&`, `|`, or `'` would break the sed substitution or, worse, inject
# shell tokens into the remote command. Realistic threat is operator fat-finger,
# not network attacker — but defense-in-depth keeps `.env` from silent corruption.
if [[ -n "$TARGET_VERSION" ]]; then
  if [[ ! "$TARGET_VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
    echo "ERROR: TARGET_VERSION '${TARGET_VERSION}' is not a valid semver tag (e.g. v1.8.4 or 1.8.4-rc1)" >&2
    exit 1
  fi
fi

echo "→ prod-deploy.sh — manual deploy (D-04: not invoked by CI)"
echo "  host:        ${DMZ_HOST}"
echo "  dir:         ${CLOKR_DIR}"
echo "  compose:     ${COMPOSE_FILE}"
echo "  base url:    ${BASE_URL}"
echo "  target ver:  ${TARGET_VERSION:-<keep current>}"
echo ""

if [[ -n "$TARGET_VERSION" ]]; then
  # Strip the leading `v` if present so the image tag matches what release.yml pushes:
  # release.yml computes `VERSION=${GITHUB_REF_NAME#v}` and tags the image without the v
  # prefix (e.g. `1.8.4`, not `v1.8.4`). Both `v1.8.4` and `1.8.4` are accepted as input.
  IMAGE_TAG="${TARGET_VERSION#v}"

  # Determine the image references for this release.
  # Owner = github.com/sebastianzabel — release.yml lowercases this to `sebastianzabel`
  # (env.REGISTRY=ghcr.io). Hardcoded here to keep the script self-contained.
  API_IMAGE="ghcr.io/sebastianzabel/clokr-api:${IMAGE_TAG}"
  WEB_IMAGE="ghcr.io/sebastianzabel/clokr-web:${IMAGE_TAG}"

  echo "→ Setting CLOKR_API_IMAGE=${API_IMAGE} and CLOKR_WEB_IMAGE=${WEB_IMAGE} in ${DMZ_HOST}:${CLOKR_DIR}/.env"

  # The prod docker-compose.yml on prod-host references ${CLOKR_API_IMAGE} and ${CLOKR_WEB_IMAGE}
  # (NOT ${CLOKR_VERSION}). Writing CLOKR_VERSION here was a dead-letter that never updated the
  # running image tag — v1.8.3 required a manual SSH fix on prod-host. See Phase 76.14.
  #
  # WR-01: Write both image refs atomically via a single awk pass that emits the
  # full new file, then `mv` it into place (atomic rename(2)). This prevents the
  # half-update scenario where API gets the new tag but WEB doesn't — leaving the
  # subsequent `docker compose pull` to fetch a mismatched pair.
  # IN-01 co-fix: drop the stale CLOKR_VERSION= line (legacy dead-letter from
  # pre-Phase-76.14 deploys) so debugging operators don't get misled by it.
  ssh "$DMZ_HOST" "cd ${CLOKR_DIR} && \
    awk -v api='CLOKR_API_IMAGE=${API_IMAGE}' -v web='CLOKR_WEB_IMAGE=${WEB_IMAGE}' '
      /^CLOKR_API_IMAGE=/ { print api; api_seen=1; next }
      /^CLOKR_WEB_IMAGE=/ { print web; web_seen=1; next }
      /^CLOKR_VERSION=/   { next }
      { print }
      END {
        if (!api_seen) print api
        if (!web_seen) print web
      }
    ' .env > .env.new && mv .env.new .env"
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
echo "→ Pulling api + web images on ${DMZ_HOST}"
ssh "$DMZ_HOST" "cd ${CLOKR_DIR} && docker compose -f ${COMPOSE_FILE} pull clokr-api clokr-web" \
  || { echo "ERROR: docker compose pull failed"; exit 2; }

echo "→ Restarting api + web on ${DMZ_HOST}"
ssh "$DMZ_HOST" "cd ${CLOKR_DIR} && docker compose -f ${COMPOSE_FILE} up -d clokr-api clokr-web" \
  || { echo "ERROR: docker compose up -d failed"; exit 2; }

echo "→ Waiting 20s for containers to become healthy..."
sleep 20

# ── Smoke (D-18: /api/v1/health + /api/v1/version) ───────────────────────────
echo "→ Smoke: ${BASE_URL}/api/v1/health"
STATUS=$(curl -sfS --max-time 10 "${BASE_URL}/api/v1/health" | jq -r '.status')
if [[ "$STATUS" != "ok" ]]; then
  echo "FAIL: health status=${STATUS} (expected: ok)"
  echo "See docs/prod-deploy.md § Rollback for next steps."
  exit 3
fi
echo "  health OK"

echo "→ Smoke: ${BASE_URL}/api/v1/version"
ACTUAL=$(curl -sfS --max-time 10 "${BASE_URL}/api/v1/version" | jq -r '.version')
echo "  deployed version: ${ACTUAL}"

if [[ -n "$TARGET_VERSION" ]]; then
  EXPECTED="${TARGET_VERSION#v}"
  if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: version mismatch (expected ${EXPECTED}, got ${ACTUAL})"
    echo "This usually means the image didn't roll out — check 'docker compose ps' on ${DMZ_HOST}."
    echo "See docs/prod-deploy.md § Rollback if forward-fix is not viable."
    exit 3
  fi
  echo "  version match OK"
fi

echo ""
echo "✓ Deploy + smoke succeeded."
