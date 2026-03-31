---
phase: 01-test-infrastructure
plan: 03
subsystem: testing
tags: [playwright, e2e, storageState, auth, setup-project]

# Dependency graph
requires: []
provides:
  - Playwright storageState setup project that authenticates once and shares session across all E2E specs
  - auth.setup.ts saves .auth/admin.json after login using existing helpers.ts login()
  - playwright.config.ts wired with setup project and dependencies on all browser projects
  - .auth/ directory excluded from version control via apps/e2e/.gitignore
affects: [01-04, 01-05, 03-e2e-coverage]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Playwright storageState: auth.setup.ts runs once before browser projects via dependencies: ['setup']"
    - "Login reuse: browser projects receive pre-authenticated session, no login() needed per spec"

key-files:
  created:
    - apps/e2e/tests/auth.setup.ts
    - apps/e2e/.gitignore
  modified:
    - apps/e2e/playwright.config.ts

key-decisions:
  - "Keep workers: 1 and do not remove loginAsAdmin() from existing specs — done incrementally in Phase 3"
  - "Set fullyParallel: true since storageState eliminates shared-login bottleneck"

patterns-established:
  - "Auth setup pattern: single setup project with testMatch targeting auth.setup.ts, all browser projects depend on it"

requirements-completed: [TEST-02]

# Metrics
duration: 5min
completed: 2026-03-30
---

# Phase 01 Plan 03: Playwright StorageState Auth Setup Summary

**Playwright storageState setup project added — login runs once per test run, session shared across desktop-chrome, mobile-chrome, and tablet browser projects via .auth/admin.json**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-30T09:09:00Z
- **Completed:** 2026-03-30T09:11:09Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Created `auth.setup.ts` that calls the existing `login()` helper and saves storageState to `.auth/admin.json`
- Updated `playwright.config.ts` to add a `setup` project with `testMatch: /auth\.setup\.ts/` and wired all 3 browser projects with `dependencies: ["setup"]` and `storageState: ".auth/admin.json"`
- Created `apps/e2e/.gitignore` to exclude `.auth/`, `test-results/`, and `playwright-report/` from version control

## Task Commits

Each task was committed atomically:

1. **Task 1: Create auth.setup.ts and .gitignore for .auth/** - `50a4ae1` (feat)
2. **Task 2: Update playwright.config.ts with setup project and storageState wiring** - `c3b5592` (feat)

**Plan metadata:** (docs commit below)

## Files Created/Modified

- `apps/e2e/tests/auth.setup.ts` - One-time login that saves storageState to .auth/admin.json
- `apps/e2e/.gitignore` - Excludes .auth/, test-results/, playwright-report/ from VCS
- `apps/e2e/playwright.config.ts` - Added setup project, storageState and dependencies on all 3 browser projects, fullyParallel: true

## Decisions Made

- **Keep `workers: 1`**: Not removed in this plan — existing specs may have hidden ordering dependencies. Removal happens incrementally once specs are verified to be auth-independent (Phase 3).
- **Keep `loginAsAdmin()` calls in existing specs**: Redundant but harmless. Removing them is Phase 3 scope.
- **Set `fullyParallel: true`**: The storageState pattern means sessions are no longer shared state, so parallel execution is safe at the project level.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. The `.auth/` directory is created at runtime by the setup project when `npx playwright test` runs against a live application.

## Next Phase Readiness

- Plan 01-03 complete. The storageState infrastructure is in place.
- Existing E2E specs still call `loginAsAdmin()` redundantly — this is intentional and deferred to Phase 3.
- Ready for plan 01-04 (API test coverage expansion).

---
*Phase: 01-test-infrastructure*
*Completed: 2026-03-30*
