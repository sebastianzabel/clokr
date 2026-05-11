---
phase: 25-wifi-presence-stempel-fritzbox
plan: "04"
subsystem: api
tags: [presence, admin, crud, api-keys, audit]
dependency_graph:
  requires: [25-01, 25-02]
  provides: [admin-presence-sources-routes]
  affects: [app.ts, admin-presence-sources.ts]
tech_stack:
  added: []
  patterns: [soft-delete, rawKey-once, adapter-proxy, requireRole-gate]
key_files:
  created:
    - apps/api/src/routes/admin-presence-sources.ts
    - apps/api/src/__tests__/admin-presence-sources.test.ts
  modified:
    - apps/api/src/app.ts
decisions:
  - GET /opted-in registered before /:id parameterized routes to avoid path collision
  - Soft delete sets both deletedAt and isActive=false (audit-proof per CLAUDE.md)
  - rawKey returned exactly once in POST response; excluded from GET / list select
  - AbortSignal.timeout(5000) on adapter proxy to prevent hanging connections
  - PresenceDevice cleanup added to afterAll before cleanupTestData to avoid FK errors
metrics:
  duration: "3m 11s"
  completed: "2026-05-11"
  tasks_completed: 3
  files_created: 2
  files_modified: 1
---

# Phase 25 Plan 04: Admin Presence Sources CRUD Summary

PresenceSource admin CRUD routes with key provisioning, soft-delete, adapter proxy, and MAC assignment — all gated by ADMIN role with full AuditLog coverage.

## Routes Implemented

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/admin/presence-sources/opted-in | List employees with wifiPresenceEnabled=true |
| GET | /api/v1/admin/presence-sources | List active presence sources (excludes deletedAt != null) |
| POST | /api/v1/admin/presence-sources | Create presence source, returns rawKey once |
| PATCH | /api/v1/admin/presence-sources/:id | Update name, adapterUrl, and/or isActive |
| DELETE | /api/v1/admin/presence-sources/:id | Soft-delete (sets deletedAt + isActive=false) |
| GET | /api/v1/admin/presence-sources/:id/devices | Proxy adapter /devices endpoint (502 if no adapterUrl) |
| POST | /api/v1/admin/presence-sources/:id/devices/:mac/assign | Assign normalized MAC to employee |

## Tests

- **File:** `apps/api/src/__tests__/admin-presence-sources.test.ts`
- **Count:** 20 test cases
- **Status:** All 20 passing

### Coverage

- GET / empty list + EMPLOYEE 403
- POST / rawKey format (clk_ prefix, keyPrefix ellipsis), EMPLOYEE 403, missing name 400
- GET / after POST: rawKey and keyHash excluded from list items
- PATCH /:id name update with oldValue/newValue audit log assertion, empty body 400, not found 404, EMPLOYEE 403
- DELETE /:id soft-delete (DB asserts deletedAt != null, isActive=false, not in GET list), double-delete 404, EMPLOYEE 403
- GET /:id/devices no adapterUrl → 502 with German error, EMPLOYEE 403
- POST /:id/devices/:mac/assign normalized MAC (AA:BB → aa:bb), audit log ASSIGN_DEVICE, EMPLOYEE 403
- GET /opted-in ADMIN 200, EMPLOYEE 403
- CREATE audit log: entity="PresenceSource", action="CREATE", newValue.name assertion

## AuditLog Entries

| Action | Entity | Trigger |
|--------|--------|---------|
| CREATE | PresenceSource | POST / |
| UPDATE | PresenceSource | PATCH /:id (with oldValue + newValue) |
| DELETE | PresenceSource | DELETE /:id (with oldValue.name) |
| ASSIGN_DEVICE | PresenceDevice | POST /:id/devices/:mac/assign |

## Commits

| Hash | Task | Description |
|------|------|-------------|
| fa0bfbe | Task 1 | feat(25-04): add adminPresenceSourcesRoutes with 7 CRUD endpoints |
| 21f15ee | Task 2 | feat(25-04): register adminPresenceSourcesRoutes in app.ts |
| fb91c55 | Task 3 | test(25-04): add integration tests for admin-presence-sources (20 cases) |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

No new threat surface beyond what the plan's threat model covers. All routes gated by requireRole("ADMIN"), adapterUrl is operator-set (not per-request user input), rawKey not logged anywhere.

## Self-Check: PASSED

- `/Users/sebastianzabel/git/clokr/apps/api/src/routes/admin-presence-sources.ts` — exists
- `/Users/sebastianzabel/git/clokr/apps/api/src/__tests__/admin-presence-sources.test.ts` — exists
- Commits fa0bfbe, 21f15ee, fb91c55 — verified in git log
- TypeScript: exit 0
- Tests: 20/20 passed
