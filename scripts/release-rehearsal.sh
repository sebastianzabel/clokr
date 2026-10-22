#!/usr/bin/env bash
# Release rehearsal (Issue #709): replays the "Betrieb & Migration" steps of a release against a
# throwaway database restored from a demo dump, with the NEW api image, in the order the release
# notes name them. Every step's exit code and output go to a protocol file; any step whose exit
# code differs from the expected one blocks the release (exit 1).
#
#   scripts/release-rehearsal.sh --steps docs/release-notes/vX.Y.Z.steps \
#       --image ghcr.io/<owner>/clokr-api:<tag> [--host clokr-demo] [--dump latest|<path on the host>] \
#       [--protocol rehearsal-vX.Y.Z.txt]
#
# With --host the whole run happens on that machine over ssh: only this script, the steps file and
# the finished protocol cross the wire; the dump never leaves the host (it is read in place from
# the host's backup directory and copied only into the throwaway container). Without --host it runs
# locally against a local docker; then the dump must already be on this machine - never fetch a
# dump to a laptop unencrypted.
#
# Cleanup is guaranteed by a trap: the throwaway postgres container, its anonymous volume, its
# network and the working directory are removed on every exit path. The running stack, its DB, its
# volumes and its env file are never touched; the dump file itself is only read.
set -uo pipefail

STEPS="" IMAGE="" HOST="" DUMP="latest" PROTOCOL="" BACKUP_DIR="${REHEARSAL_BACKUP_DIR:-/opt/clokr/backups}"
PG_IMAGE="${REHEARSAL_PG_IMAGE:-postgres:18-alpine}"
while [ $# -gt 0 ]; do
  case "$1" in
    --steps) STEPS="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --dump) DUMP="$2"; shift 2 ;;
    --protocol) PROTOCOL="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[ -n "$STEPS" ] && [ -f "$STEPS" ] && [ -n "$IMAGE" ] || { echo "usage: --steps FILE --image IMAGE [--host H] [--dump latest|PATH] [--protocol FILE]" >&2; exit 64; }
[ -n "$PROTOCOL" ] || PROTOCOL="rehearsal-$(basename "$STEPS" .steps)-$(date +%Y%m%d-%H%M%S).txt"

# ── Remote mode: ship script + steps, run there, fetch only the protocol ────────────────────
if [ -n "$HOST" ]; then
  RDIR=$(ssh "$HOST" 'mktemp -d /tmp/rehearsal.XXXXXX') || exit 70
  trap 'ssh "$HOST" "rm -rf $RDIR" >/dev/null 2>&1' EXIT
  scp -q "$0" "$STEPS" "$HOST:$RDIR/" || exit 70
  ssh "$HOST" "bash $RDIR/$(basename "$0") --steps $RDIR/$(basename "$STEPS") --image '$IMAGE' --dump '$DUMP' --backup-dir '$BACKUP_DIR' --protocol $RDIR/protocol.txt"
  rc=$?
  scp -q "$HOST:$RDIR/protocol.txt" "$PROTOCOL" && echo "protocol: $PROTOCOL"
  exit $rc
fi

# ── Local (on the machine that holds the dump) ──────────────────────────────────────────────
ID="$(date +%s)-$$"
PG="clokr-rehearsal-pg-$ID"; NET="clokr-rehearsal-net-$ID"
RUNSECRET="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')rehearsal0000000000"
PGPASS="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
cleanup() {
  docker rm -f -v "$PG" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ "$DUMP" = "latest" ]; then DUMP="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1)"; fi
[ -f "$DUMP" ] || { echo "no dump found ($DUMP)" >&2; exit 66; }

FAILS=0
: > "$PROTOCOL"
log() { printf '%s\n' "$*" >> "$PROTOCOL"; }
log "# Release rehearsal protocol"
log "steps:  $(basename "$STEPS")"
log "image:  $IMAGE ($(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo 'digest unknown'))"
log "dump:   $(basename "$DUMP") (read in place, restored into a throwaway database)"
log "start:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log ""

docker network create "$NET" >/dev/null || exit 70
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=clokr -e POSTGRES_PASSWORD="$PGPASS" \
  -e POSTGRES_DB=clokr "$PG_IMAGE" >/dev/null || exit 70
for i in $(seq 1 60); do
  docker exec "$PG" pg_isready -U clokr -d clokr >/dev/null 2>&1 && break; sleep 1
done
# The server restarts once during init; wait for a real query to succeed.
for i in $(seq 1 30); do docker exec "$PG" psql -U clokr -d clokr -tAc 'select 1' >/dev/null 2>&1 && break; sleep 1; done

DSN="postgresql://clokr:${PGPASS}@${PG}:5432/clokr"

# step <id> <phase> <expected-rc> <command...> : runs, records rc and output, compares to expected
step() {
  local id="$1" phase="$2" expect="$3"; shift 3
  local out="$WORK/out.txt" rc
  "$@" > "$out" 2>&1; rc=$?
  # expected is one exit code or a comma list ("0,2": clean or findings, both fine for an audit)
  local verdict=FAIL; case ",$expect," in *",$rc,"*) verdict=PASS ;; esac
  [ "$verdict" = PASS ] || FAILS=$((FAILS+1))
  log "## [$verdict] $id (phase $phase, expected exit $expect, actual exit $rc)"
  log '```'; cat "$out" >> "$PROTOCOL"; log '```'; log ""
  echo "[$verdict] $id exit=$rc (expected $expect)"
  return $rc
}

restore() {
  docker cp "$DUMP" "$PG:/tmp/restore.dump" && \
  docker exec "$PG" pg_restore -U clokr -d clokr --no-owner --exit-on-error /tmp/restore.dump
  local rc=$?
  docker exec "$PG" rm -f /tmp/restore.dump
  return $rc
}
api() { # run a command inside the new api image against the throwaway DB (never the image's migrating entrypoint)
  # The config module validates these at import; the values are throwaway and only live in this container.
  docker run --rm --network "$NET" -e DATABASE_URL="$DSN" -e NODE_ENV=production \
    -e JWT_SECRET="$RUNSECRET-jwt" -e JWT_REFRESH_SECRET="$RUNSECRET-refresh" -e ENCRYPTION_KEY="$RUNSECRET-enc" \
    --entrypoint sh "$IMAGE" -c "$1"
}
migrate() {
  # Same prisma lookup and command the image entrypoint uses (apps/api/docker-entrypoint.sh)
  api 'cd /app/packages/db && P=$(find /app/node_modules -name prisma -path "*/node_modules/.bin/prisma" | head -1); "$P" migrate deploy'
}

step restore setup 0 restore
SKIP_REST=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  IFS='|' read -r phase expect id kind arg <<< "$line"
  phase="${phase// /}"; expect="${expect// /}"; id="${id// /}"; kind="${kind// /}"; arg="${arg# }"
  if [ "$SKIP_REST" = 1 ] && [ "$phase" != pre ]; then
    log "## [SKIPPED] $id (an earlier migrate step failed)"; log ""; echo "[SKIPPED] $id"; continue
  fi
  case "$kind" in
    sql)     step "$id" "$phase" "$expect" docker exec "$PG" psql -U clokr -d clokr -v ON_ERROR_STOP=1 -tA -c "$arg" ;;
    script)  step "$id" "$phase" "$expect" api "cd /app/apps/api && pnpm tsx scripts/$arg" ;;
    migrate) before=$FAILS; step "$id" "$phase" "$expect" migrate; [ "$FAILS" -gt "$before" ] && SKIP_REST=1 ;;
    *) log "## [FAIL] $id: unknown step kind '$kind'"; FAILS=$((FAILS+1)) ;;
  esac
done < "$STEPS"

log "end:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$FAILS" = 0 ]; then log "RESULT: PASS - all steps returned the expected exit code"; echo "RESULT: PASS"; exit 0; fi
log "RESULT: FAIL - $FAILS step(s) deviated; the release is blocked"; echo "RESULT: FAIL ($FAILS)"; exit 1
