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

echo "→ prod-deploy.sh — manual deploy (D-04: not invoked by CI)"
echo "  host:        ${DMZ_HOST}"
echo "  dir:         ${CLOKR_DIR}"
echo "  compose:     ${COMPOSE_FILE}"
echo "  base url:    ${BASE_URL}"
echo "  target ver:  ${TARGET_VERSION:-<keep current>}"
echo ""

if [[ -n "$TARGET_VERSION" ]]; then
  echo "→ Setting CLOKR_VERSION=${TARGET_VERSION} in ${DMZ_HOST}:${CLOKR_DIR}/.env"
  # If CLOKR_VERSION already present, replace it; otherwise append it.
  ssh "$DMZ_HOST" "cd ${CLOKR_DIR} && \
    if grep -q '^CLOKR_VERSION=' .env; then \
      sed -i 's|^CLOKR_VERSION=.*|CLOKR_VERSION=${TARGET_VERSION}|' .env; \
    else \
      echo 'CLOKR_VERSION=${TARGET_VERSION}' >> .env; \
    fi"
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
echo "→ Pulling api + web images on ${DMZ_HOST}"
ssh "$DMZ_HOST" "cd ${CLOKR_DIR} && docker compose -f ${COMPOSE_FILE} pull api web" \
  || { echo "ERROR: docker compose pull failed"; exit 2; }

echo "→ Restarting api + web on ${DMZ_HOST}"
ssh "$DMZ_HOST" "cd ${CLOKR_DIR} && docker compose -f ${COMPOSE_FILE} up -d api web" \
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
