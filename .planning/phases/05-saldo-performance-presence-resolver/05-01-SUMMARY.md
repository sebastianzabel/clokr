---
phase: 05-saldo-performance-presence-resolver
plan: "01"
title: "SALDO-01 — Remove Eager Recalculation from GET"
subsystem: api/overtime
tags: [performance, overtime, saldo, read-path]
dependency_graph:
  requires: []
  provides: [O(1)-overtime-read]
  affects: [apps/api/src/routes/overtime.ts, apps/api/src/__tests__/overtime-calc.test.ts]
tech_stack:
  added: []
  patterns: [read-only GET handler, write-path side effects for recalculation]
key_files:
  created: []
  modified:
    - apps/api/src/routes/overtime.ts
    - apps/api/src/__tests__/overtime-calc.test.ts
decisions:
  - GET /overtime/:employeeId reads stored balanceHours directly (O(1)); recalculation happens only on write operations (POST time-entries, PUT time-entries, etc.)
  - Tests rewritten to use POST /api/v1/time-entries route to trigger updateOvertimeAccount as a write-path side effect before asserting balance change
metrics:
  duration: "~10 minutes"
  completed_date: "2026-04-11"
  tasks_completed: 2
  files_modified: 2
---

# Phase 05 Plan 01: SALDO-01 — Remove Eager Recalculation from GET Summary

**One-liner:** Removed eager `updateOvertimeAccount()` call from GET overtime handler, making reads O(1) stored lookups and rewriting two tests to use the POST write path.

## What Was Done

### Task 1: Remove updateOvertimeAccount() from GET handler

Modified `apps/api/src/routes/overtime.ts`:
- Removed the two-line eager recalculation block (`await updateOvertimeAccount(...)`) from the GET `/:employeeId` handler
- Removed `updateOvertimeAccount` from the import statement (kept `getEffectiveSchedule` which is used elsewhere in the file at line 733)
- The GET handler now performs a single `prisma.overtimeAccount.findUnique()` read and returns the stored balance — no DB writes on reads

### Task 2: Rewrite tests that depended on GET-triggered recalculation

Modified `apps/api/src/__tests__/overtime-calc.test.ts`:
- Rewrote "overtime recalculates on GET" → "overtime balance updates after creating a time entry via API": now POSTs a 10h entry via `/api/v1/time-entries` (which fires `updateOvertimeAccount` as a side effect), then GETs and asserts the balance changed
- Rewrote "overtime saldo includes today only when entries exist" → "overtime balance includes today only when entry created via API": same pattern — entries created via API route, not direct DB insert
- All other tests (COMPLIANCE block, Monatsabschluss block, saldo period test) left unchanged
- All 9 tests pass

## Verification Results

- TypeScript compilation: No errors introduced in overtime.ts (pre-existing errors in test files are module resolution issues unrelated to this change)
- Test suite: `9 passed (9)` — all tests in overtime-calc.test.ts pass
- Grep check: `grep -n "updateOvertimeAccount" apps/api/src/routes/overtime.ts` returns no results

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | d88c72c | feat(05-01): remove eager updateOvertimeAccount() from GET overtime handler |
| 2 | 7690ec3 | test(05-01): rewrite overtime-calc tests to use API route instead of direct DB insert |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — GET /overtime/:employeeId previously introduced write amplification risk (T-05-01-02 in plan threat model). Removing the write call eliminates that risk. The endpoint remains protected by the pre-existing `requireAuth` guard.

## Self-Check: PASSED

- [x] `apps/api/src/routes/overtime.ts` — modified, no updateOvertimeAccount references
- [x] `apps/api/src/__tests__/overtime-calc.test.ts` — modified, 9/9 tests pass
- [x] Commit d88c72c exists (Task 1)
- [x] Commit 7690ec3 exists (Task 2)
