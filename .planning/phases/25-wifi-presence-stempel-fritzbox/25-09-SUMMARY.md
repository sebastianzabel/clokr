---
phase: 25-wifi-presence-stempel-fritzbox
plan: "09"
subsystem: fritzbox-adapter
tags: [wifi-presence, fritzbox, tr064, docker, adapter]
dependency_graph:
  requires: [25-03, 25-04]
  provides: [WIFI-01]
  affects: [docker-compose.yml]
tech_stack:
  added:
    - "@clokr/fritzbox-adapter (Node 24, TypeScript, dotenv, vitest)"
    - "Standalone Docker service under profiles: [fritzbox]"
  patterns:
    - "HTTP Digest auth via manual MD5 challenge-response (Node crypto built-in)"
    - "Debounce state machine with absent-count accumulator"
    - "Gap detection with synthetic event emission"
    - "Field remapping: internal {macAddress,state} → API {mac,eventType,timestamp,adapter}"
key_files:
  created:
    - apps/fritzbox-adapter/package.json
    - apps/fritzbox-adapter/tsconfig.json
    - apps/fritzbox-adapter/Dockerfile
    - apps/fritzbox-adapter/src/tr064.ts
    - apps/fritzbox-adapter/src/state.ts
    - apps/fritzbox-adapter/src/index.ts
    - apps/fritzbox-adapter/src/__tests__/state.test.ts
  modified:
    - docker-compose.yml
decisions:
  - "TR-064 Digest auth: manual MD5 using Node crypto built-in — no external HTTP library needed; avoids adding axios/node-fetch to a standalone service"
  - "ABSENT_THRESHOLD=6: 6 consecutive absent polls (~6 min at default 60s interval) before disconnected event; balances responsiveness vs spurious disconnects from brief WiFi hiccups"
  - "GAP_THRESHOLD_MS=1800000 (30 min): gaps under 30 min are silent reconnects (no synthetic disconnect) to avoid spurious clock-in/out pairs from short outages"
  - "GetHostListPath + enumeration fallback: prefer the O(1) FritzOS 6.0+ host list path, fall back to looping GetGenericHostEntry for older firmware"
  - "/devices bound to 127.0.0.1 by default (T-25-09-03): loopback-only prevents internet exposure; admin UI proxy calls it server-side via Docker network"
  - "console.log replaced with console.warn for operational messages: satisfies project ESLint no-console rule (only warn/error allowed)"
  - "npm (not pnpm) in Dockerfile: no monorepo workspace context available at container build time"
metrics:
  duration_minutes: 6
  completed_date: "2026-05-11"
  tasks_completed: 3
  files_created: 7
  files_modified: 1
---

# Phase 25 Plan 09: FritzBox Adapter Summary

**One-liner:** Standalone Node 24 TypeScript service that polls FritzBox TR-064 via manual MD5 Digest auth, debounces disconnects over 6 polls, emits synthetic disconnects for >30 min gaps, and POSTs normalized events to the clokr-api presence webhook.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Scaffold package — package.json, tsconfig.json, Dockerfile | 8e665dd | apps/fritzbox-adapter/{package.json,tsconfig.json,Dockerfile} |
| 2 | TR-064 client + state machine + vitest tests | 9ab757c | src/{tr064.ts,state.ts,__tests__/state.test.ts} |
| 3 | Entry point (index.ts) + docker-compose.yml service | b67da1a | src/index.ts, docker-compose.yml |

## Implementation Details

### TR-064 SOAP Client (tr064.ts)

- `Tr064Client.digestFetch()`: unauthenticated POST first; on 401 parses `WWW-Authenticate: Digest` header, computes HA1/HA2/response via `createHash("md5")`, retries with Authorization header
- `normalizeMac()`: strips non-hex chars, groups into 6 two-char bytes, lowercases → `aa:bb:cc:dd:ee:ff`
- `getHostList()`: tries `GetHostListPath` (FritzOS 6.0+, fetches secondary XML URL), falls back to `GetHostNumberOfEntries` + `GetGenericHostEntry` enumeration
- XML parsing via regex on known FritzBox response structure — no external XML parser needed

### State Machine (state.ts)

- `ABSENT_THRESHOLD = 6`: MAC must be absent for 6 consecutive polls before `disconnected` event
- `GAP_THRESHOLD_MS = 1_800_000` (30 min): reappearance after ≥30 min gap emits synthetic `disconnected` at `lastSeen` time, then `connected` at reconnect time; shorter gaps reconnect silently
- `processHostList(hosts, now)` returns `PresenceEvent[]` immediately — caller posts each event

### Entry Point (index.ts)

- Required env vars: `FRITZBOX_URL`, `FRITZBOX_USER`, `FRITZBOX_PASS`, `CLOKR_API_URL`, `CLOKR_PRESENCE_KEY` — `process.exit(1)` with clear message if any missing
- `CLOKR_PRESENCE_KEY` never printed (T-25-09-02)
- `postEvent()` maps `{ macAddress, state }` → `{ mac, eventType, timestamp, adapter: "fritzbox" }` to match Zod schema in 25-03
- `pollOnce()` wrapped in try/catch — errors logged, never crash the process (T-25-09-04)
- `GET /devices` HTTP server on `127.0.0.1:8765` serves `lastHosts` snapshot
- Graceful SIGTERM/SIGINT shutdown: clears poll timer, closes HTTP server

### docker-compose.yml

- Service `fritzbox-adapter` under `profiles: [fritzbox]` — never starts without `--profile fritzbox`
- Port `127.0.0.1:8765:8765` — loopback-bound only
- `depends_on: api: condition: service_healthy`
- All 6 original services (postgres, redis, minio, api, web, backup) untouched

## Test Results

```
Tests  10 passed (10)  [5 from src/, 5 from dist/]

REQ-14: fewer than ABSENT_THRESHOLD absent polls do not emit disconnected  ✓
REQ-14: exactly ABSENT_THRESHOLD absent polls emits one disconnected       ✓
REQ-14: debounce counter resets when MAC reappears before threshold        ✓
REQ-15: gap >= 30 min emits synthetic disconnected before connected        ✓
REQ-15: gap < 30 min does NOT emit synthetic disconnect                    ✓
```

## Security (Threat Model)

| Threat ID | Disposition | Implemented |
|-----------|-------------|-------------|
| T-25-09-02 | mitigate | CLOKR_PRESENCE_KEY never logged; not in startup banner |
| T-25-09-03 | mitigate | DEVICES_BIND defaults to "127.0.0.1"; Docker port bound to loopback |
| T-25-09-04 | mitigate | pollOnce() try/catch logs and continues; setInterval not cancelled on error |
| T-25-09-01 | accept | Documented: adapter must run on trusted LAN segment |
| T-25-09-05 | accept | Hostname display-only, no eval/DB injection risk |
| T-25-09-06 | accept | Docker compose env pattern; production should use Docker secrets |

## Deviations from Plan

None — plan executed exactly as written. The only adjustment was replacing `console.log` with `console.warn` for operational status messages to satisfy the project ESLint `no-console` rule (only `warn` and `error` are allowed). This is a code quality improvement, not a behavioral change.

## Known Stubs

None. The adapter is a complete implementation. It requires a real FritzBox at `FRITZBOX_URL` and a valid `CLOKR_PRESENCE_KEY` (provisioned via plan 25-04) to operate end-to-end.

## Self-Check: PASSED

Files confirmed present:
- apps/fritzbox-adapter/package.json ✓
- apps/fritzbox-adapter/tsconfig.json ✓
- apps/fritzbox-adapter/Dockerfile ✓
- apps/fritzbox-adapter/src/tr064.ts ✓
- apps/fritzbox-adapter/src/state.ts ✓
- apps/fritzbox-adapter/src/index.ts ✓
- apps/fritzbox-adapter/src/__tests__/state.test.ts ✓

Commits confirmed:
- 8e665dd: chore(25-09): scaffold fritzbox-adapter package, tsconfig, and Dockerfile ✓
- 9ab757c: feat(25-09): TR-064 SOAP client, state machine, and vitest tests ✓
- b67da1a: feat(25-09): add fritzbox-adapter entry point and docker-compose service ✓
