#!/usr/bin/env bash
# Operator helper of the simulation instance (Issue #715). See docs/simulation.md.
#
#   bin/sim.sh up            start the stack (api, db, mail catcher; add EDGE=1 for web + edge)
#   bin/sim.sh down          stop the stack (keeps data)
#   bin/sim.sh destroy       stop the stack and DELETE all data (down -v)
#   bin/sim.sh operator      create the operator account (once) and write .sim/operator.json
#   bin/sim.sh ro-role       create the read-only database role of the checker
#   bin/sim.sh logs [svc]    follow logs
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$HERE/docker-compose.sim.yml"
ENV_FILE="${SIM_ENV_FILE:-$HERE/sim.env}"
STATE_DIR="${SIM_STATE_DIR:-$HERE/.sim}"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy sim.env.example)" >&2; exit 1; }
dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  up)
    if [ "${EDGE:-0}" = "1" ]; then dc --profile edge up -d
    else dc up -d postgres redis minio mailpit api; fi
    ;;
  down) dc --profile edge down ;;
  destroy) dc --profile edge down -v; rm -f "$STATE_DIR/state.json" "$STATE_DIR/operator.json" ;;
  logs) dc logs -f --tail=100 "$@" ;;
  operator)
    mkdir -p "$STATE_DIR"
    umask 077
    email="${SIM_OPERATOR_EMAIL:-sim-operator@sim.invalid}"
    password="$(openssl rand -hex 16)Aa1!"
    out="$(dc exec -T -w /app/apps/api -e OPERATOR_PASSWORD="$password" api \
      pnpm tsx scripts/operator-account.ts --create --email "$email" --display-name "Sim Operator" --apply)"
    secret="$(printf '%s\n' "$out" | sed -n 's/^TOTP secret (shown once): //p')"
    [ -n "$secret" ] || { echo "Could not read the TOTP secret from the script output" >&2; exit 1; }
    printf '{"email":"%s","password":"%s","totpSecret":"%s"}\n' "$email" "$password" "$secret" \
      > "$STATE_DIR/operator.json"
    echo "Operator account written to $STATE_DIR/operator.json (mode 600)"
    ;;
  ro-role)
    ro_password="$(openssl rand -hex 16)"
    dc exec -T postgres psql -U clokr -d clokr -v ro_password="$ro_password" \
      < "$HERE/sql/readonly-role.sql" >/dev/null
    port="$(grep -E '^SIM_PG_PORT=' "$ENV_FILE" | cut -d= -f2 || true)"
    echo "SIM_DB_URL=postgresql://clokr_sim_ro:${ro_password}@127.0.0.1:${port:-15532}/clokr"
    echo "(put this line into $ENV_FILE)"
    ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
