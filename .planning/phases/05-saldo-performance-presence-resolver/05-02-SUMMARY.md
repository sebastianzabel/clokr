---
phase: 05-saldo-performance-presence-resolver
plan: 02
subsystem: api
tags: [overtime, leave, imports, saldo, updateOvertimeAccount]

# Dependency graph
requires:
  - phase: 05-saldo-performance-presence-resolver/05-01
    provides: "updateOvertimeAccount utility function that performs the stored balance write"
provides:
  - "leave.ts calls updateOvertimeAccount after CANCELLATION_REQUESTED→CANCELLED approval"
  - "leave.ts calls updateOvertimeAccount after PENDING→APPROVED approval"
  - "imports.ts collects affectedEmployeeIds and calls updateOvertimeAccount per employee post-loop"
affects:
  - 05-saldo-performance-presence-resolver

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Catch-and-log pattern for non-critical post-write balance updates: errors logged but parent operation not aborted"
    - "affectedEmployeeIds Set pattern to deduplicate per-employee post-loop operations"

key-files:
  created: []
  modified:
    - apps/api/src/routes/leave.ts
    - apps/api/src/routes/imports.ts

key-decisions:
  - "updateOvertimeAccount is called AFTER recalculateSnapshots in both leave approval paths — ensures snapshot carryOver is the base before the open-period calculation runs"
  - "Errors in updateOvertimeAccount are caught and logged, not re-thrown — balance update failure does not abort the leave approval or import operation"
  - "affectedEmployeeIds deduplicated via Set to avoid redundant per-employee calls when the same employee has multiple rows in a single CSV import"

patterns-established:
  - "Non-critical post-write side-effects: always .catch() and log errors without re-throwing"
  - "Post-loop aggregation: collect affected entity IDs during loop, then fan-out after loop"

requirements-completed:
  - SALDO-02

# Metrics
duration: 15min
completed: 2026-04-11
---

# Phase 05 Plan 02: SALDO-02 — Close Missing updateOvertimeAccount Write-Caller Gaps Summary

**Leave approval and CSV time-entry import now synchronously update OvertimeAccount.balanceHours via updateOvertimeAccount calls, closing the last write-path gaps for the stored balance architecture.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-11T18:25:00Z
- **Completed:** 2026-04-11T18:40:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Added `updateOvertimeAccount` import and two call sites in `leave.ts` (CANCELLATION_REQUESTED→CANCELLED and PENDING→APPROVED approval paths), called after `recalculateSnapshots` in each block
- Added `updateOvertimeAccount` import, `affectedEmployeeIds` Set collection, and post-loop per-employee calls in `imports.ts` POST /time-entries handler
- TypeScript compiles cleanly with no errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Add updateOvertimeAccount import and calls to leave.ts** - `64e6a93` (feat)
2. **Task 2: Add post-loop updateOvertimeAccount calls to imports.ts** - `604f700` (feat)

**Plan metadata:** (docs commit below)

## Files Created/Modified
- `apps/api/src/routes/leave.ts` - Added import + 2 updateOvertimeAccount call sites after recalculateSnapshots blocks
- `apps/api/src/routes/imports.ts` - Added import + affectedEmployeeIds Set + post-loop per-employee updateOvertimeAccount calls

## Decisions Made
- `updateOvertimeAccount` called after `recalculateSnapshots` in both approval paths to ensure snapshot carryOver is the correct base before the open-period recalculation
- Errors caught and logged (not re-thrown) to avoid aborting the parent leave approval or import operation
- `affectedEmployeeIds` uses a `Set<string>` to deduplicate employees appearing in multiple import rows

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing test failure in `time-entries-validation.test.ts` (2 tests: "blocks POST /clock-in with 409 when a valid open entry exists") unrelated to this plan's changes. These tests existed at the base commit (9c4cdb9) and were not introduced by this plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Write-path gaps for leave and imports are closed
- OvertimeAccount.balanceHours is now updated on all write paths: time-entry create/update/delete (existing), leave approval/cancellation (this plan), and bulk CSV import (this plan)
- Ready for Phase 05-03 which builds on the complete stored balance architecture

---
*Phase: 05-saldo-performance-presence-resolver*
*Completed: 2026-04-11*
