---
phase: 16-5-burlg-june-30th-rule-full-vacation-entitlement-on-exit-aft
plan: 02
subsystem: api
tags: [vacation-calc, burlg, leave, typescript, entitlements, pro-rata]

# Dependency graph
requires:
  - phase: 16-01
    provides: "calculateProRataVacation with § 5 Abs. 2 BUrlG H2 short-circuit guard"
provides:
  - "H1 pro-rata cap enforced at booking time in POST /leave/requests"
  - "effectiveEntitlementDays field in GET /entitlements/:employeeId response"
affects:
  - leave booking (POST /leave/requests now enforces pro-rata cap for H1 exits)
  - entitlements frontend (can display reduced effective entitlement for H1-exiting employees)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "H1 cap in booking handler: fetch exitDate from DB scoped by tenantId, compare getMonth() < 6, apply calculateProRataVacation before falling through to standard avail1 check"
    - "effectiveEntitlementDays in GET response: single findUnique per handler call, inline per-row call to calculateProRataVacation, non-VACATION rows use totalDays"

key-files:
  created: []
  modified:
    - apps/api/src/routes/leave.ts

key-decisions:
  - "H1 cap placed inside the existing `if (ent1 && split.year1Days > 0)` block, using early return to avoid restructuring the surrounding Year 2 cross-year block"
  - "Employee exitDate fetch is scoped with `{ id: employeeId, tenantId }` in both callers — cross-tenant access structurally prevented"
  - "effectiveEntitlementDays uses `vacationNames.includes(r.leaveType.name)` (already defined above in the handler) — no duplicate variable introduced"
  - "Pre-existing test failures in overtime-calc.test.ts and time-entries-validation.test.ts are out of scope (4 failures present before changes, unrelated to leave.ts)"

patterns-established:
  - "BUrlG H1 cap pattern: check exitDate from DB, getFullYear() === year1 && getMonth() < 6, then apply pro-rata before existing avail check"
  - "effectiveEntitlementDays: always present on /entitlements rows; equals totalDays when no cap applies"

requirements-completed:
  - BURLG-H2-03
  - BURLG-H2-04
  - BURLG-H2-05

# Metrics
duration: 18min
completed: 2026-04-15
---

# Phase 16 Plan 02: H1 cap wired into leave booking and entitlements response

**H1-exiting employees are now blocked at booking from exceeding their pro-rata entitlement (§ 5 Abs. 2 BUrlG), and GET /entitlements exposes `effectiveEntitlementDays` on every row for frontend display**

## Performance

- **Duration:** 18 min
- **Started:** 2026-04-15T10:40:00Z
- **Completed:** 2026-04-15T10:58:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Wired `calculateProRataVacation` into the Year 1 entitlement check block in `POST /leave/requests` — H1 exits trigger a 400 with `"Anteiliger Urlaub bei Austritt in H1 überschritten (N Tage anteilig)"` when booking would exceed the pro-rata cap
- H2 exits (month >= 6) fall through to the original `avail1` check — no behavioral change for those employees
- Added single `findUnique` employee fetch to `GET /entitlements/:employeeId` handler; all response rows now include `effectiveEntitlementDays`
- VACATION rows compute `calculateProRataVacation(totalDays, year, exitDate)` when exitDate is set; non-VACATION and no-exitDate rows return `totalDays`
- TypeScript compiles clean (0 errors)
- All leave-related tests pass (405 tests pass; 4 pre-existing failures in unrelated test files)

## Task Commits

Each task was committed atomically:

1. **Task 1: H1 pro-rata cap in POST leave booking handler** - `b9cb437` (feat)
2. **Task 2: Add effectiveEntitlementDays to GET /entitlements response** - `720014b` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `apps/api/src/routes/leave.ts` - H1 cap block in POST /leave/requests booking handler (~line 246) + employee fetch and effectiveEntitlementDays in GET /entitlements handler (~line 1300)

## Decisions Made
- Placed the H1 cap as a conditional branch within the existing `if (ent1 && split.year1Days > 0)` block. The `else if (split.year1Days > avail1)` ensures H2 exits and employees without exitDate continue using the standard avail1 path — no behavioral regression.
- Used `vacationNames` (already defined earlier in the GET /entitlements handler) for the `isVacationRow` check — no duplicate definition.
- Both DB fetches use `{ id: employeeId, tenantId }` where clause — tenant isolation maintained per CLAUDE.md multi-tenancy rules.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Worktree branch needed reset to expected base commit `0c0a75d` (soft reset + restore to clean up staged deletes from prior merged work). No impact on logic.
- 4 pre-existing test failures in `overtime-calc.test.ts` and `time-entries-validation.test.ts` — verified unrelated to leave.ts changes, out of scope per CLAUDE.md deviation scope boundary rule.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three BURLG-H2 requirements now fully implemented: `calculateProRataVacation` has the H2 guard (16-01), the booking handler enforces the H1 cap (16-02 Task 1), and the entitlements endpoint exposes the effective entitlement for frontend display (16-02 Task 2)
- Frontend can now read `effectiveEntitlementDays` from GET /entitlements to display the correct cap to H1-exiting employees
- No blockers for subsequent phases

---
*Phase: 16-5-burlg-june-30th-rule-full-vacation-entitlement-on-exit-aft*
*Completed: 2026-04-15*
