---
phase: 25-wifi-presence-stempel-fritzbox
plan: "05"
subsystem: api
tags: [fastify, prisma, wifi, gdpr, audit-trail, mac-address, typescript]

# Dependency graph
requires:
  - phase: 25-01
    provides: "Employee schema fields: wifiPresenceEnabled, wifiOptInAt; PresenceDevice model with tenantId_mac unique"
  - phase: 25-02
    provides: "normalizeMac() utility for MAC address canonicalization"
provides:
  - "GET /api/v1/employees/me/wifi — employee reads own opt-in status and device list"
  - "PATCH /api/v1/employees/me/wifi — employee toggles GDPR wifi opt-in; wifiOptInAt stamped on enable"
  - "POST /api/v1/employees/me/wifi/devices — employee registers MAC device (normalized, duplicate-checked per tenant)"
  - "DELETE /api/v1/employees/me/wifi/devices/:id — employee removes own device (403 on foreign device)"
  - "17 integration tests covering all four endpoints"
affects:
  - 25-06 (admin device assignment builds on same PresenceDevice model)
  - 25-07 (wifi presence scanner reads employee wifiPresenceEnabled + devices)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "WiFi self-service routes appended inside existing employeeRoutes() function"
    - "tenantId_mac unique constraint for per-tenant MAC deduplication (not per-employee)"
    - "addedAt field (not createdAt) for PresenceDevice — actual schema field name"
    - "GDPR consent preservation: wifiOptInAt never nulled on opt-out, purgeable never set on consent audit entries"

key-files:
  created:
    - apps/api/src/__tests__/me-wifi.test.ts
  modified:
    - apps/api/src/routes/employees.ts

key-decisions:
  - "Unique constraint is tenantId_mac (not employeeId_mac as plan assumed) — a MAC can only belong to one employee per tenant"
  - "PresenceDevice uses addedAt (not createdAt) — actual Prisma schema field name from plan 25-01"
  - "wifiOptInAt never nulled on opt-out: preserves GDPR consent withdrawal trace per §147 AO"
  - "purgeable flag is intentionally absent from all wifi audit entries — consent events are permanently retained"

patterns-established:
  - "WiFi self-service: employeeId always sourced from req.user.employeeId (JWT), never from request body"
  - "Own-data guard: device.employeeId vs req.user.employeeId checked before DELETE"

requirements-completed: [WIFI-02, WIFI-04]

# Metrics
duration: 5min
completed: 2026-05-11
---

# Phase 25 Plan 05: Self-Service WiFi Endpoints Summary

**GDPR-compliant employee WiFi opt-in API with MAC device enrollment via four new routes in employeeRoutes(), using tenantId_mac deduplication and permanent consent audit trail**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-05-11T19:07:30Z
- **Completed:** 2026-05-11T19:12:01Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Four WiFi self-service routes added to `employeeRoutes()` in `employees.ts`
- GDPR consent preservation: `wifiOptInAt` stamped on first opt-in, preserved on opt-out
- MAC normalization via existing `normalizeMac()` utility; invalid MACs return 400 before any DB write
- Own-data guard: 403 returned when employee attempts to delete another employee's device
- 17 integration tests passing, covering all four endpoints, audit log, auth guard, opt-in toggle, MAC validation, and cross-employee protection

## Task Commits

1. **Task 1: Add self-service WiFi routes** - `02d8d15` (feat)
2. **Task 2: Integration test suite** - `7482bcc` (test)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `apps/api/src/routes/employees.ts` — Added `normalizeMac` import, three WiFi Zod schemas, four new route handlers (GET/PATCH /me/wifi, POST/DELETE /me/wifi/devices)
- `apps/api/src/__tests__/me-wifi.test.ts` — 17 integration tests for all four endpoints

## Decisions Made

- **tenantId_mac uniqueness**: The plan specified `@@unique([employeeId, mac])` but the actual schema from plan 25-01 uses `@@unique([tenantId, mac])`. A MAC maps to exactly one employee per tenant (not per employee globally). Duplicate check uses `tenantId_mac` compound key accordingly.
- **addedAt not createdAt**: PresenceDevice uses `addedAt` as the timestamp field (not `createdAt`). Selects and orderBy updated to use the correct field name.
- **tenantId required in create**: `presenceDevice.create` requires `tenantId` in addition to `employeeId` since the schema has a non-nullable `tenantId` field.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed incorrect Prisma field names and unique constraint key**
- **Found during:** Task 1 (TypeScript compile check)
- **Issue:** Plan specified `createdAt`, `employeeId_mac`, and omitted `tenantId` in create — all incorrect vs actual Prisma-generated types from plan 25-01's schema
- **Fix:** Changed `createdAt` → `addedAt`, `employeeId_mac` → `tenantId_mac`, added `tenantId` to `presenceDevice.create` data
- **Files modified:** `apps/api/src/routes/employees.ts`
- **Verification:** `pnpm --filter @clokr/api exec tsc --noEmit` exits 0
- **Committed in:** `02d8d15` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - schema field mismatch between plan spec and actual generated types)
**Impact on plan:** Fix was necessary for correctness; no scope changes.

## Issues Encountered

TypeScript compile errors revealed the actual Prisma schema shape differs from what the plan interface block described (plan 25-01 added `tenantId` to PresenceDevice and used `addedAt` instead of `createdAt`, and the unique index is per-tenant not per-employee). Fixed inline before tests ran.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Four employee self-service WiFi endpoints fully tested and committed
- Plan 25-06 (admin device assignment) can immediately use `presenceDevice` with `tenantId_mac` unique constraint
- Plan 25-07 (wifi presence scanner) can read `wifiPresenceEnabled` and `presenceDevices` from employee records

---
*Phase: 25-wifi-presence-stempel-fritzbox*
*Completed: 2026-05-11*
