---
phase: 03-e2e-and-ui-quality
plan: 02
subsystem: testing
tags: [playwright, e2e, leave-flow, monatsabschluss, password-policy, employee-management]

# Dependency graph
requires:
  - phase: 03-e2e-and-ui-quality-01
    provides: "E2E test infrastructure with loginAsAdmin helper and storageState auth"
provides:
  - "E2E-03: Substantive leave creation and approval flow with employee-creates/admin-approves pattern"
  - "E2E-04: Employee creation test filling all form fields and asserting table presence"
  - "E2E-05: Monatsabschluss close test with API pre-seeding, click assertion, and API verification"
  - "UI-05: Password policy persistence test with page reload verification"
affects: [03-e2e-and-ui-quality-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Employee-creates/admin-approves pattern using explicit Bearer token for employee, browser context for admin"
    - "API pre-seeding before UI action to guarantee deterministic test state"
    - "page.request with explicit Authorization header for cross-user API calls within E2E tests"

key-files:
  created: []
  modified:
    - apps/e2e/tests/leave-flow.spec.ts
    - apps/e2e/tests/admin-settings-flow.spec.ts

key-decisions:
  - "Use employee API login (max@clokr.de / mitarbeiter5678) with explicit Bearer header to create leave as employee, avoiding self-approval block when admin reviews"
  - "SICK leave type for E2E approval test - avoids vacation entitlement constraints in test DB"
  - "Pre-seed time entry via API before Monatsabschluss UI test - guarantees firstActionableMonth exists and close button is visible"
  - "Find first open/partial/ready month dynamically across years - avoids hardcoded date dependencies"
  - "409 Conflict from time-entry POST treated as success - employee already has data for that day, still closeable"
  - "All if (await el.isVisible()) optional assertion patterns replaced with hard await expect().toBeVisible()"

patterns-established:
  - "Cross-user API pattern: page.request.post('/api/v1/auth/login') -> explicit Bearer header in subsequent requests"
  - "Year-status API for dynamic month discovery before UI interaction"

requirements-completed: [E2E-03, E2E-04, E2E-05, UI-05]

# Metrics
duration: 10min
completed: 2026-03-31
---

# Phase 3 Plan 2: Substantive Leave and Admin E2E Tests Summary

**E2E tests for leave approval (employee-creates/admin-approves via API token), employee creation, Monatsabschluss close with API pre-seeding, and password policy persistence with reload verification**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-31T05:53:31Z
- **Completed:** 2026-03-31T06:03:31Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Replaced scaffold leave-flow.spec.ts (full of `if (await isVisible)` optional checks) with substantive hard-assertion tests including the deterministic employee-creates / admin-approves flow
- Added employee creation test (E2E-04) using specific form field IDs from the actual HTML, completing the full create-to-table-assertion cycle
- Added Monatsabschluss test (E2E-05) that pre-seeds a time entry via API, dynamically discovers the first actionable month, clicks "Abschliessen", and verifies via both UI text and API year-status response
- Added password policy test (UI-05) that changes min-length, saves, reloads page, asserts persisted value, and restores original value

## Task Commits

Each task was committed atomically:

1. **Task 1: Write substantive leave approval E2E flow** - `355737d` (feat)
2. **Task 2: Write substantive admin employee, Monatsabschluss, and password policy E2E tests** - `393d50f` (feat)

**Plan metadata:** (docs commit below)

## Files Created/Modified

- `apps/e2e/tests/leave-flow.spec.ts` - Replaced scaffold with 7 substantive tests: page tabs, UI form create, API-based employee-creates/admin-approves approval, special leave dropdown, calendar navigation, tab switching, team toggle
- `apps/e2e/tests/admin-settings-flow.spec.ts` - Added E2E-04 employee creation, E2E-05 Monatsabschluss close with pre-seeding, UI-05 password policy persistence; converted all existing optional assertions to hard expects

## Decisions Made

- Employee login via `page.request.post("/api/v1/auth/login")` with explicit `Authorization: Bearer ${employeeToken}` header in the leave creation POST — this is the only way to create leave as a different user than the admin in the browser context. This avoids the self-approval block at leave.ts line 502.
- SICK leave type avoids vacation entitlement balance constraints that could make the test fail in DB states with low vacation balance.
- Monatsabschluss pre-seeding uses dynamic year discovery (prior year then current) rather than hardcoded 2026-01 to avoid fragility as time passes.
- 409 from time-entry POST (entry already exists) is treated as acceptable — the employee already has data for that day and can still be closed.
- The "Abschliessen" button only appears for `firstActionableMonth` — test finds and clicks the only visible close button.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Converted existing optional assertions to hard expects across all kept tests**
- **Found during:** Task 2 review
- **Issue:** Plan specified converting `if (await el.isVisible())` to hard `await expect(el).toBeVisible()` for all kept tests, but the existing `navigate all admin tabs`, `admin vacation — open/close accordion`, and `admin system — toggle 2FA` tests still used conditional patterns
- **Fix:** Replaced all three with hard assertions in the kept tests; additionally converted password checkbox and year navigation in new tests to use expect().toBeVisible()
- **Files modified:** apps/e2e/tests/admin-settings-flow.spec.ts
- **Verification:** `grep -n "if (await"` returns empty for both test files
- **Committed in:** 393d50f

---

**Total deviations:** 1 auto-fixed (missing critical conversion)
**Impact on plan:** Necessary to satisfy the no-optional-assertion requirement. No scope creep.

## Issues Encountered

None - plan executed as specified. The API interfaces described in the plan matched the actual implementations.

## Known Stubs

None - all tests exercise real API endpoints and UI interactions. No hardcoded empty values or mock data paths.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 03 plan 03 can proceed: E2E tests for 4 critical flows are now substantive with hard assertions
- All requirement IDs E2E-03, E2E-04, E2E-05, UI-05 fulfilled
- Password policy persistence test (UI-05) verifies real API round-trip via GET /settings/security after reload

## Self-Check: PASSED

- FOUND: apps/e2e/tests/leave-flow.spec.ts
- FOUND: apps/e2e/tests/admin-settings-flow.spec.ts
- FOUND: .planning/phases/03-e2e-and-ui-quality/03-02-SUMMARY.md
- FOUND commit: 355737d (Task 1 - leave flow)
- FOUND commit: 393d50f (Task 2 - admin settings)
- FOUND commit: af4b9be (docs/metadata)

---
*Phase: 03-e2e-and-ui-quality*
*Completed: 2026-03-31*
