---
phase: 01-test-infrastructure
plan: 05
subsystem: testing
tags: [vitest, prisma, postgresql, dotenv, test-isolation]

# Dependency graph
requires: []
provides:
  - Test schema isolation via PostgreSQL ?schema=test parameter
  - globalSetup hook overriding DATABASE_URL before app boots
  - pretest script pushing Prisma schema to test DB before each test run
  - try/catch cleanup guards on all 12 test suite afterAll handlers
affects: [02-api-coverage, 03-e2e-coverage]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "vitest globalSetup for DATABASE_URL override (not setupFiles — must run before module import)"
    - "Shell source (.env.test) to pass TEST_DATABASE_URL to prisma db push in pretest script"
    - "try/catch in afterAll around cleanupTestData to prevent orphaned test data on failure"

key-files:
  created:
    - apps/api/.env.test (gitignored — contains TEST_DATABASE_URL with ?schema=test)
    - apps/api/vitest.setup.ts
  modified:
    - apps/api/vitest.config.ts
    - apps/api/package.json
    - apps/api/src/__tests__/setup.ts
    - apps/api/src/__tests__/auth.test.ts
    - apps/api/src/__tests__/auto-break.test.ts
    - apps/api/src/__tests__/employees.test.ts
    - apps/api/src/__tests__/imports.test.ts
    - apps/api/src/__tests__/leave-config.test.ts
    - apps/api/src/__tests__/leave.test.ts
    - apps/api/src/__tests__/notifications.test.ts
    - apps/api/src/__tests__/overtime-calc.test.ts
    - apps/api/src/__tests__/password-policy.test.ts
    - apps/api/src/__tests__/saldo-snapshot.test.ts
    - apps/api/src/__tests__/shifts.test.ts
    - apps/api/src/__tests__/time-entries.test.ts
    - .gitignore

key-decisions:
  - "Use globalSetup (not setupFiles) for DATABASE_URL override — globalSetup runs before test workers load modules, ensuring Fastify reads the test DB URL"
  - "Use shell source (.env.test) in pretest instead of dotenv CLI — dotenv v17.3.1 ships no CLI binary, shell source is reliable cross-platform"
  - "try/catch (not try/finally) in afterAll — closeTestApp() is a no-op singleton so it runs unconditionally after the try/catch block"

patterns-established:
  - "Pattern 1: globalSetup for env override — any test infrastructure needing env before module load uses globalSetup"
  - "Pattern 2: pretest scripts for DB schema prep — use shell source to load .env.test, set DATABASE_URL, run prisma db push"
  - "Pattern 3: try/catch in afterAll cleanup — all test cleanup wrapped to prevent orphaned data on failure"

requirements-completed: [TEST-01]

# Metrics
duration: 6min
completed: 2026-03-30
---

# Phase 1 Plan 5: Test Schema Isolation Summary

**Vitest globalSetup routing API tests to PostgreSQL ?schema=test, with pretest prisma db push and try/catch cleanup guards across all 12 test suites**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-30T09:10:07Z
- **Completed:** 2026-03-30T09:15:58Z
- **Tasks:** 2
- **Files modified:** 17

## Accomplishments

- Created `apps/api/.env.test` with `TEST_DATABASE_URL` pointing to test schema (gitignored)
- Created `apps/api/vitest.setup.ts` with `setup()` function that overrides `DATABASE_URL` before app boots via vitest `globalSetup`
- Added `pretest` script to `apps/api/package.json` using shell `source` to load `.env.test` and push Prisma schema to test DB
- Wrapped `cleanupTestData` calls in all 12 test suite `afterAll` handlers with try/catch to prevent orphaned test data on failure
- Added JSDoc comment to `cleanupTestData` documenting the required try/catch pattern for future test authors

## Task Commits

Each task was committed atomically:

1. **Task 1: Create .env.test (gitignored), vitest.setup.ts, and update vitest.config.ts** - `2c02131` (chore)
2. **Task 2: Add pretest script to package.json and try/catch to setup.ts cleanup** - `c6ecfdb` (chore)

**Plan metadata:** (docs commit to follow)

## Files Created/Modified

- `apps/api/.env.test` - TEST_DATABASE_URL with ?schema=test (gitignored, not committed)
- `apps/api/vitest.setup.ts` - globalSetup module exporting setup() that sets DATABASE_URL=TEST_DATABASE_URL
- `apps/api/vitest.config.ts` - Added globalSetup: ["./vitest.setup.ts"]
- `apps/api/package.json` - Added pretest script: shell source .env.test then prisma db push --skip-generate
- `apps/api/src/__tests__/setup.ts` - Updated JSDoc on cleanupTestData with required try/catch pattern
- `apps/api/src/__tests__/*.test.ts` (12 files) - Wrapped cleanupTestData calls in try/catch in afterAll
- `.gitignore` - Added apps/api/.env.test entry

## Decisions Made

- **globalSetup vs setupFiles:** Used `globalSetup` because it runs before any test worker loads modules. `setupFiles` runs in the worker context after app modules are imported — too late to override DATABASE_URL before `buildApp()` reads it.
- **Shell source vs dotenv CLI:** dotenv v17.3.1 ships no CLI binary. Shell `set -a; . ./.env.test; set +a` is the reliable cross-platform alternative, correctly stripping quoted values.
- **try/catch vs try/finally:** Since `closeTestApp()` is a no-op singleton, wrapping only `cleanupTestData` in try/catch and calling `closeTestApp()` unconditionally after gives the same guarantee as try/finally with cleaner code.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Replaced dotenv CLI pretest script with shell source approach**
- **Found during:** Task 2 (Add pretest script)
- **Issue:** Plan specified `dotenv -e .env.test -- sh -c '...'` but dotenv v17.3.1 (installed) ships no CLI binary — the command would fail with "command not found"
- **Fix:** Used `sh -c 'set -a; . ./.env.test; set +a; DATABASE_URL=$TEST_DATABASE_URL ...'` instead — shell source correctly strips quotes and exports variables
- **Files modified:** apps/api/package.json
- **Verification:** Tested locally: `sh -c 'set -a; . ./.env.test; set +a; echo $TEST_DATABASE_URL'` outputs correct URL
- **Committed in:** c6ecfdb (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — wrong CLI assumption)
**Impact on plan:** Essential fix. Without it, pretest would fail with command not found on every test run. Functionally identical outcome.

## Issues Encountered

None beyond the dotenv CLI deviation documented above.

## User Setup Required

`apps/api/.env.test` is gitignored and must be created manually on each developer machine and in CI:

```
TEST_DATABASE_URL="postgresql://clokr:password@localhost:5432/clokr?schema=test"
```

Credentials match `.env` DATABASE_URL — only `?schema=test` is added. The test schema is created automatically by `prisma db push` on first `pnpm test` run.

## Next Phase Readiness

- Test isolation complete: all tests will connect to `?schema=test` instead of the dev database
- pretest ensures the test schema is always up-to-date before tests run
- try/catch cleanup guards prevent orphaned test data from failing tests blocking subsequent runs
- Ready for Phase 1 Plan 6 (ArbZG edge case tests) — test infrastructure foundation is solid

---
*Phase: 01-test-infrastructure*
*Completed: 2026-03-30*
