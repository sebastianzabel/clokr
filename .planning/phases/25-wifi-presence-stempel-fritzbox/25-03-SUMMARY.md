---
phase: 25-wifi-presence-stempel-fritzbox
plan: "03"
subsystem: api/presence
tags: [wifi-presence, webhook, time-entry, audit-log, fastify, prisma]
dependency_graph:
  requires: ["25-01", "25-02"]
  provides: ["POST /api/v1/presence/events", "presenceRoutes"]
  affects: ["apps/api/src/app.ts", "apps/api/src/routes/presence.ts"]
tech_stack:
  added: []
  patterns:
    - "PresenceSource Bearer key auth via SHA256 hash lookup (mirrors NFC TerminalApiKey pattern)"
    - "Direct prisma.auditLog.create for purgeable field (audit plugin lacks purgeable interface)"
    - "Shift window gate using ShiftWindow.startUtc/endUtc from getCurrentShift()"
    - "Employee lookup via user.isActive (no deletedAt field on Employee — DSGVO anonymization)"
key_files:
  created:
    - apps/api/src/routes/presence.ts
    - apps/api/src/__tests__/presence-webhook.test.ts
  modified:
    - apps/api/src/app.ts
decisions:
  - "Used direct prisma.auditLog.create throughout (not app.audit()) because audit plugin interface has no purgeable field"
  - "isLocked check uses TimeEntry.isLocked field — no ClosedMonth/closedMonth model exists in schema"
  - "Employee soft-delete: Employee has no deletedAt. Deactivated employees filtered via user.isActive=true"
  - "ShiftWindow returned by getCurrentShift() already provides startUtc/endUtc as pre-computed UTC Dates — no manual fromZonedTime() needed in presence.ts"
  - "Out-of-window DISCONNECT events return 200 silently (idempotent) — adapter should not receive errors for business-logic rejections"
  - "Clock-out writes TimeEntry update inside $transaction; AuditLog written outside transaction for simplicity"
metrics:
  duration: "10m"
  completed: "2026-05-11"
  tasks_completed: 3
  files_created: 2
  files_modified: 1
requirements: ["WIFI-01", "WIFI-03", "WIFI-04"]
---

# Phase 25 Plan 03: Presence Webhook Handler Summary

Implemented `POST /api/v1/presence/events` — the hub endpoint for WiFi presence clock-in/out via FritzBox adapter Bearer key auth, shift-window gate, cross-source dedup, and purgeable AuditLog writes.

## What Was Built

### Task 1: presenceRoutes handler (`apps/api/src/routes/presence.ts`)

Full webhook pipeline in a single `POST /events` route:

1. Bearer key auth → SHA256 → `PresenceSource.keyHash` lookup; revoked keys → 401
2. `normalizeMac()` canonicalization of incoming MAC
3. Tenant-scoped employee lookup via `wifiMacs: { has: mac }` + `user: { isActive: true }`
4. Shift-window gate: `getCurrentShift()` returns `ShiftWindow | null`; event must be within `±wifiPresenceWindowMinutes` of `startUtc` or `endUtc`
5. Cross-source dedup: existing NFC/MANUAL/CORRECTION entry → `WIFI_PRESENCE_CONFIRMED`, no stamp
6. `connected` event: create WIFI `TimeEntry` in `$transaction` (race-guard re-check inside tx)
7. `disconnected` event: close open WIFI entry via `$transaction`, check `isLocked` first
8. Every branch writes an `AuditLog` with the correct `action` and `purgeable` value

### Task 2: Route registration (`apps/api/src/app.ts`)

Import and register `presenceRoutes` at `/api/v1/presence`. Appended after existing registrations without touching any other routes.

### Task 3: Integration tests (`apps/api/src/__tests__/presence-webhook.test.ts`)

9 tests covering all behavioral branches (REQ-01 through REQ-09). All pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Employee.deletedAt does not exist**
- **Found during:** Task 1 execution (TypeScript compiled clean, but runtime 500 on first test run)
- **Issue:** Plan template showed `deletedAt: null` in the employee query filter, but `Employee` model has no `deletedAt` field. Employee "deletion" in Clokr is DSGVO anonymization — deactivation is tracked via `User.isActive`
- **Fix:** Changed filter from `deletedAt: null` to `user: { isActive: true }`
- **Files modified:** `apps/api/src/routes/presence.ts`
- **Commit:** 38a6838

**2. [Rule 1 - Bug] ShiftWindow API mismatch**
- **Found during:** Implementation review of `getCurrentShift()` (25-02 output)
- **Issue:** Plan's `<interfaces>` section documented `getCurrentShift()` as returning `{ id, date, startTime, endTime }` strings that needed manual `fromZonedTime()` conversion. Actual implementation (25-02) returns `ShiftWindow { shift, startUtc, endUtc }` with pre-computed UTC Dates
- **Fix:** Used `shiftWindow.startUtc` / `shiftWindow.endUtc` directly; removed `fromZonedTime()` import (unused)
- **Files modified:** `apps/api/src/routes/presence.ts`

**3. [Rule 1 - Bug] Invalid MAC in REQ-03 test**
- **Found during:** Task 3 test run
- **Issue:** Test generated MAC using `RUN_ID.slice(0, 2)` which can produce non-hex chars; `normalizeMac()` throws, triggering global error handler → 500
- **Fix:** Changed to a fixed valid but unregistered MAC `"de:ad:be:ef:00:01"`
- **Files modified:** `apps/api/src/__tests__/presence-webhook.test.ts`

### Schema Findings (Not Deviations — Just Facts)

- **No ClosedMonth model**: The plan mentioned checking `ClosedMonth.isLocked`. No such model exists. Used `TimeEntry.isLocked` field instead (correct per schema)
- **AuditLog.tenantId**: Not present on `AuditLog` model — omitted from all audit writes
- **PresenceSource.isActive**: Field exists (`Boolean @default(true)`) but plan only required checking `revokedAt`. Did not add `isActive` check to keep consistent with `TerminalApiKey` pattern (which also only checks `revokedAt`)

## Test Results

```
 Test Files  1 passed (1)
       Tests  9 passed (9)
   Duration  ~2s
```

All 9 REQ tests pass. 3 pre-existing failures in `overtime-calc.test.ts` and `time-entries-validation.test.ts` are not caused by this plan (those files were not touched).

## Known Stubs

None. All 9 handler branches are fully implemented and tested.

## Threat Flags

No new security surface beyond what is documented in the plan's `<threat_model>`. All 7 threats (T-25-03-01 through T-25-03-07) are mitigated in the implementation.

## Self-Check: PASSED

- [x] `apps/api/src/routes/presence.ts` exists — confirmed
- [x] `apps/api/src/__tests__/presence-webhook.test.ts` exists — confirmed
- [x] `apps/api/src/app.ts` has 2 presenceRoutes lines — confirmed
- [x] All 9 tests pass — confirmed
- [x] TypeScript clean (presence.ts) — confirmed
- [x] Commits exist: 96fda01 (Task 1), 7344672 (Task 2), 38a6838 (Task 3)
