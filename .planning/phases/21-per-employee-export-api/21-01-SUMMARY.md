---
plan: 21-01
phase: 21-per-employee-export-api
status: complete
started: "2026-04-25T20:56:51Z"
completed: "2026-04-25T21:10:00Z"
subsystem: reports
tags: [datev, export, reports, rpt-03, rpt-04]
requirements: [RPT-03, RPT-04]
dependency_graph:
  requires: []
  provides:
    - "GET /api/v1/reports/datev/employee — per-employee DATEV LODAS TXT export"
    - "buildDatevLodas() — shared DATEV formatting utility in reports.ts"
  affects:
    - "apps/api/src/routes/reports.ts"
tech_stack:
  added: []
  patterns:
    - "Module-scope helper extraction (buildDatevLodas) to prevent format divergence"
key_files:
  modified:
    - "apps/api/src/routes/reports.ts"
decisions:
  - "buildDatevLodas() kept module-scope (not exported) — used only within reports.ts"
  - "DatevEmployee type defined separately from EmployeeWithIncludes — narrower shape for DATEV-specific fields"
  - "breakMinutes cast via Number() in buildDatevLodas — fixes implicit bigint arithmetic from Prisma Decimal type"
metrics:
  duration: "~13 minutes"
  completed: "2026-04-25"
  tasks_completed: 3
  files_modified: 1
---

# Phase 21 Plan 01: Per-Employee DATEV LODAS Export Summary

**One-liner:** Extracted `buildDatevLodas()` shared utility from inline DATEV handler and added `GET /api/v1/reports/datev/employee` per-employee export endpoint with CP1252/CRLF/INI-section format parity.

## What Was Built

- `buildDatevLodas()` module-scope function in `reports.ts` — produces a CP1252-encoded Buffer with the full DATEV LODAS TXT (3 INI sections, 12-field semicolon rows, CRLF endings)
- `GET /api/v1/reports/datev/employee?employeeId=&year=&month=` — new endpoint, `requireRole("ADMIN","MANAGER")`, tenant-isolated, audit-logged with `type: "DATEV_EMPLOYEE"`
- Company-wide `GET /api/v1/reports/datev` refactored to call `buildDatevLodas()` — eliminates format divergence risk

## Tasks Completed

| Task | Description | Outcome |
|------|-------------|---------|
| Task 1 | Extract buildDatevLodas() and refactor /datev | Complete — tsc passes, handler calls utility |
| Task 2 | Add GET /datev/employee endpoint | Complete — route registered, tenant isolated, audit logged |
| Task 3 | Smoke tests via curl | Complete — 200 with valid DATEV TXT, CRLF confirmed, PDF 200 confirmed, 404 and 400 work |

## Smoke Test Results

| Test | Expected | Actual |
|------|----------|--------|
| GET /datev/employee → valid employee | 200 + DATEV TXT | 200 |
| DATEV TXT INI sections count | 3 | 3 |
| CRLF line endings | Present | Confirmed (0d0a in xxd) |
| GET /monthly/pdf → valid employee (RPT-04) | 200 + PDF | 200, PDF v1.3 |
| Unknown employeeId | 404 | 404 |
| Missing employeeId param | 400 | 400 |
| Company-wide GET /datev | 200 + DATEV TXT | 200 |

Note: Employee-role 403 gate verified by code inspection (`requireRole("ADMIN","MANAGER")` at line 727) — demo employee accounts do not have known passwords in the current seed data.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed breakMinutes bigint arithmetic in buildDatevLodas**
- **Found during:** Task 1 extraction
- **Issue:** Original inline code used `e.breakMinutes` directly in subtraction (`- e.breakMinutes`) where the Prisma type is `Decimal | null`, which TypeScript would coerce unsafely. The extracted helper uses `Number(e.breakMinutes ?? 0)` consistently.
- **Fix:** Applied `Number(e.breakMinutes ?? 0)` in the `workedMinutes` reduce inside `buildDatevLodas()`
- **Files modified:** `apps/api/src/routes/reports.ts`
- **Commit:** b582bd7

## Known Stubs

None — endpoint returns real DATEV data from the database.

## Threat Flags

No new threat surface beyond what was planned in the threat model. All mitigations applied:
- T-21-01: `requireRole("ADMIN","MANAGER")` applied at line 727
- T-21-02: `tenantId: req.user.tenantId` in employee findFirst where clause (line 762)
- T-21-03: Company-wide /datev retains `requireRole("ADMIN")` only gate
- T-21-04: findFirst returns null → 404 (no data disclosure)
- T-21-05: `app.audit()` with `type: "DATEV_EMPLOYEE"` and `employeeId`

## Self-Check: PASSED

- [x] `apps/api/src/routes/reports.ts` exists and modified
- [x] Commit b582bd7 exists
- [x] `buildDatevLodas` appears 4 times in reports.ts (type comment + function definition + 2 call sites)
- [x] `datev/employee` route registered at line 725
- [x] `requireRole("ADMIN", "MANAGER")` at line 727
- [x] `tenantId: req.user.tenantId` confirmed at line 762
- [x] `DATEV_EMPLOYEE` audit entry confirmed in source
- [x] TypeScript compiles without errors
- [x] Smoke tests: all expected HTTP codes returned
