---
phase: 05-saldo-performance-presence-resolver
plan: 03
subsystem: api
tags: [fastify, typescript, dashboard, presence, vitest, unit-test]

# Dependency graph
requires:
  - phase: 05-saldo-performance-presence-resolver
    provides: "Phase context — CANCELLATION_REQUESTED flow, isInvalid entry semantics (D-08, D-09, D-10)"
provides:
  - "resolvePresenceState() pure utility function in apps/api/src/utils/presence.ts"
  - "13 unit tests covering all presence status branches (no DB required)"
  - "Fixed dashboard team-week handler with correct isInvalid filtering and CANCELLATION_REQUESTED leave support"
affects: [dashboard, team-week, presence-state, leave-cancellation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure utility pattern: presence logic extracted from route handler into testable pure function"
    - "Priority-ordered status resolution: clocked_in > present > leave (CANCELLATION_REQUESTED first) > absence > scheduled > missing > none"

key-files:
  created:
    - apps/api/src/utils/presence.ts
    - apps/api/src/__tests__/presence.test.ts
  modified:
    - apps/api/src/routes/dashboard.ts

key-decisions:
  - "CANCELLATION_REQUESTED leave returns status=absent with reason 'Urlaubsstornierung beantragt' — leave is legally active until cancellation is approved (D-09)"
  - "isInvalid:true entries are filtered out entirely before presence resolution — they must not count as present or clocked_in (D-08)"
  - "workedMinutes calculation in dashboard also skips isInvalid entries for consistency"
  - "Presence beats leave: if employee has a valid time entry, status is present/clocked_in regardless of any leave record"

patterns-established:
  - "Pure utility extraction: business logic in routes can be extracted to utils/ as pure functions with typed input interfaces for unit testability"

requirements-completed: [RPT-04]

# Metrics
duration: 15min
completed: 2026-04-11
---

# Phase 05 Plan 03: RPT-04 — resolvePresenceState() Utility + Dashboard Fix Summary

**Pure `resolvePresenceState()` utility extracted from dashboard.ts, with 13 unit tests and bug fixes for CANCELLATION_REQUESTED leave visibility and isInvalid entry filtering in team-week handler**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-11T18:25:00Z
- **Completed:** 2026-04-11T18:40:00Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Created `presence.ts` pure utility with `resolvePresenceState()` — no DB dependency, fully importable in isolation
- Wrote 13 unit tests covering all 8 priority branches including D-08 (isInvalid filtering) and D-09 (CANCELLATION_REQUESTED reason)
- Fixed dashboard team-week query: added `isInvalid` to time entry select, added `CANCELLATION_REQUESTED` to leave status filter, selected `status` field on leave records
- Replaced 30-line inline status determination block in dashboard.ts with single `resolvePresenceState()` call

## Task Commits

Each task was committed atomically:

1. **Task 1: Create presence.ts utility** - `2f5be84` (feat)
2. **Task 2: Write unit tests in presence.test.ts** - `03d3002` (test)
3. **Task 3: Fix dashboard.ts team-week handler** - `ff7407a` (fix)

## Files Created/Modified
- `apps/api/src/utils/presence.ts` - Pure utility: resolvePresenceState() + PresenceStatus, PresenceEntry, PresenceLeave, PresenceAbsence, PresenceResult types
- `apps/api/src/__tests__/presence.test.ts` - 13 unit tests, no DB required, all passing
- `apps/api/src/routes/dashboard.ts` - Fixed team-week handler: isInvalid select, CANCELLATION_REQUESTED in leave filter, resolvePresenceState() call

## Decisions Made
- `CANCELLATION_REQUESTED` leave maps to `status: "absent"` with reason `"Urlaubsstornierung beantragt"` — consistent with leave remaining legally active until cancellation is approved (per ArbZG/BUrlG leave cancellation flow)
- Priority order places CANCELLATION_REQUESTED before APPROVED leave in the resolver so the more specific status message is shown
- `workedMinutes` in dashboard.ts now also filters `isInvalid` entries (not just the status resolver) for consistent worked hours reporting

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered
- `pnpm --filter @clokr/api exec tsc --noEmit` failed in the worktree because node_modules are not installed in the worktree directory (they live in the main repo). Used `cd /Users/sebastianzabel/git/clokr && node_modules/.bin/tsc --noEmit -p apps/api/tsconfig.json` directly, which succeeded.
- Similarly `pnpm --filter @clokr/api exec vitest run` would not find test files in the worktree. Used `node_modules/.bin/vitest run <absolute-path>` from main repo — all 13 tests passed.

## User Setup Required
None — no external service configuration required.

## Next Phase Readiness
- `resolvePresenceState()` is ready for reuse in any future presence/attendance reporting (e.g., monthly presence reports)
- Dashboard team-week endpoint now correctly handles CANCELLATION_REQUESTED employees and invalid entries
- No blockers for subsequent plans in phase 05

## Self-Check

- [x] `apps/api/src/utils/presence.ts` created and exports all required types
- [x] `apps/api/src/__tests__/presence.test.ts` created with 13 tests all passing
- [x] `apps/api/src/routes/dashboard.ts` uses `resolvePresenceState()`, has `isInvalid: true` in select, has `CANCELLATION_REQUESTED` in leave query
- [x] TypeScript compiles with no errors
- [x] Commits 2f5be84, 03d3002, ff7407a exist

## Self-Check: PASSED

---
*Phase: 05-saldo-performance-presence-resolver*
*Completed: 2026-04-11*
