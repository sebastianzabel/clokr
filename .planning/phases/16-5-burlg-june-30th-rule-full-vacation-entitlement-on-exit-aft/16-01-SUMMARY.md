---
phase: 16-5-burlg-june-30th-rule-full-vacation-entitlement-on-exit-aft
plan: 01
subsystem: api
tags: [vacation-calc, burlg, leave, typescript, vitest, tdd]

# Dependency graph
requires: []
provides:
  - "calculateProRataVacation with § 5 Abs. 2 BUrlG H2 short-circuit guard"
  - "TDD test coverage for H2 boundary cases (Jul 1, Aug 15, non-30 base)"
affects:
  - leave booking (downstream caller of calculateProRataVacation)
  - entitlements endpoint
  - leave approval warning logic

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "H2 guard inserted before monthly-loop: `if (exitDate.getMonth() >= 6) return baseDays;`"

key-files:
  created: []
  modified:
    - apps/api/src/utils/vacation-calc.ts
    - apps/api/src/utils/__tests__/vacation-calc.test.ts

key-decisions:
  - "H2 check uses `getMonth() >= 6` (July=6 through Dec=11) — fires BEFORE the monthly-loop, bypassing it entirely for H2 exits"
  - "exitYear === year is already guaranteed at this point by the two year guards above, so no additional year check needed"
  - "TDD RED phase confirmed via tsx direct invocation (vitest requires DB setup for globalSetup, workaround: used vitest via symlinked node_modules)"

patterns-established:
  - "BUrlG H2 rule: any exit in July (month index 6) or later in same year = full annual entitlement"

requirements-completed:
  - BURLG-H2-01
  - BURLG-H2-02

# Metrics
duration: 9min
completed: 2026-04-15
---

# Phase 16 Plan 01: H2 Halbjahresregel Guard Summary

**`calculateProRataVacation` now returns full annual entitlement for H2 exits (July 1+) via `§ 5 Abs. 2 BUrlG` short-circuit guard inserted before the monthly-loop**

## Performance

- **Duration:** 9 min
- **Started:** 2026-04-15T08:34:13Z
- **Completed:** 2026-04-15T08:43:14Z
- **Tasks:** 1 (TDD)
- **Files modified:** 2

## Accomplishments
- Added `if (exitDate.getMonth() >= 6) return baseDays;` guard to `calculateProRataVacation` — positions 4th in the guard chain (after year-boundary checks, before monthly-loop)
- Added 3 new TDD test cases for H2 boundary: Jul 1 (month index 6), Aug 15 (month index 7), and base=25 variant
- All 29 vacation-calc unit tests pass (26 original + 3 new H2 tests)
- Existing Jun 30 pro-rata test (`returns 15`) remains unchanged and green

## Task Commits

Each task was committed atomically:

1. **Task 1: Add H2 branch to calculateProRataVacation (TDD)** - `14fd3e1` (feat)

## Files Created/Modified
- `apps/api/src/utils/vacation-calc.ts` - Added `§ 5 Abs. 2 BUrlG` H2 guard at line 128, before monthly-loop
- `apps/api/src/utils/__tests__/vacation-calc.test.ts` - Added 3 H2 test cases inside `describe("calculateProRataVacation")`

## Decisions Made
- H2 guard uses `getMonth() >= 6` which covers July (6) through December (11) — semantically correct and minimal
- Guard is inserted after `if (exitYear < year) return 0;` — at this point `exitYear === year` is guaranteed, so no additional year check needed
- The guard fires BEFORE the monthly-loop, so the loop is completely bypassed for H2 exits (performance benefit, correct per plan spec D-04)

## Deviations from Plan

None - plan executed exactly as written.

**Note on TDD RED phase:** The RED phase was verified via `npx tsx` direct invocation which confirmed `calculateProRataVacation(30, 2026, new Date(2026, 6, 1))` returned `15` (wrong) before the fix. The worktree doesn't have its own `node_modules`, so vitest was run by temporarily creating a symlink to the main repo's `node_modules`. This is a worktree infrastructure consideration, not a deviation from plan logic.

## Issues Encountered
- Worktree lacks `node_modules` — vitest cannot run directly from worktree path. Resolved by creating a temporary symlink to main repo's `node_modules` for the GREEN verification run, then removing it before commit.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `calculateProRataVacation` is fully corrected — all downstream callers (leave booking, entitlements endpoint, approval warning) inherit the fix automatically
- Ready for plan 16-02 which likely covers downstream caller verification or edge cases

---
*Phase: 16-5-burlg-june-30th-rule-full-vacation-entitlement-on-exit-aft*
*Completed: 2026-04-15*
