---
phase: 01-test-infrastructure
plan: 06
subsystem: testing
tags: [vitest, coverage, v8, thresholds, prisma]

# Dependency graph
requires:
  - phase: 01-test-infrastructure/01-05
    provides: globalSetup for test DB isolation, pretest prisma db push
provides:
  - Coverage thresholds enforced in vitest.config.ts (lines=37, functions=37, branches=24)
  - Baseline coverage measurements for the API codebase (2026-03-30)
  - pnpm test:coverage exits 0 when coverage meets thresholds, exits 1 on regression
affects: [02-api-coverage]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "coverage.thresholds in vitest.config.ts: lines/functions/branches set 4pp below baseline"
    - "Baseline measured before setting thresholds (D-04: not aspirational)"
    - "globalSetup resolved relative to root — use ../path.ts when root: ./src"

key-files:
  created: []
  modified:
    - apps/api/vitest.config.ts
    - apps/api/package.json
    - apps/api/src/__tests__/employees.test.ts

key-decisions:
  - "Thresholds set 4pp below measured baseline (not aspirational) per D-04: lines=37, functions=37, branches=24"
  - "globalSetup path is ../vitest.setup.ts (not ./vitest.setup.ts) when root: ./src — vitest resolves globalSetup relative to root"
  - "Prisma 7.x removed --skip-generate flag from db push — pretest script updated"
  - "Employee tests used password test1234 (8 chars) which fails DEFAULT_PASSWORD_POLICY (min 12, uppercase, special) — updated to Test@1234567!"

patterns-established:
  - "Pattern 1: measure baseline before setting thresholds — always run test:coverage once without thresholds, then set 2-5pp below"
  - "Pattern 2: vitest globalSetup path must be relative to root, not config file location"

requirements-completed: [TEST-03]

# Metrics
duration: 22min
completed: 2026-03-30
---

# Phase 1 Plan 6: Coverage Thresholds Summary

**vitest.config.ts enforces lines>=37%, functions>=37%, branches>=24% coverage thresholds (4pp below measured baseline of 40.22%/41.05%/28.48%)**

## Performance

- **Duration:** 22 min
- **Started:** 2026-03-30T09:31:20Z
- **Completed:** 2026-03-30T09:53:00Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments

- Measured baseline coverage: lines=41.74%, functions=41.05%, branches=28.48%, statements=40.22% (190 tests passing)
- Added `coverage.thresholds` block to `apps/api/vitest.config.ts` with lines=37, functions=37, branches=24
- `pnpm --filter @clokr/api test:coverage` now exits 0 (all 190 tests pass, coverage above thresholds)
- Verified enforcement: thresholds=99 produces exit 1 with ERROR messages; correct thresholds produce exit 0
- Fixed 4 pre-existing blockers found during baseline measurement (see Deviations)

## Coverage Baseline (measured 2026-03-30)

| Metric     | Baseline | Threshold (baseline - 4pp) |
| ---------- | -------- | -------------------------- |
| Lines      | 41.74%   | 37%                        |
| Functions  | 41.05%   | 37%                        |
| Branches   | 28.48%   | 24%                        |
| Statements | 40.22%   | (not enforced separately)  |

## Task Commits

1. **Task 1: Measure baseline coverage and set thresholds** - `20224d2` (feat)

**Plan metadata:** (docs commit to follow)

## Files Created/Modified

- `apps/api/vitest.config.ts` - Added globalSetup path fix (../vitest.setup.ts) and coverage.thresholds block
- `apps/api/package.json` - Removed --skip-generate from pretest (Prisma 7.x compatibility)
- `apps/api/src/__tests__/employees.test.ts` - Updated test passwords to meet DEFAULT_PASSWORD_POLICY

## Decisions Made

- **Thresholds at 4pp below baseline** — Plan specified 2-5pp; chose 4pp as reasonable safety margin without being too aggressive. With 40% line coverage, a 4pp buffer means we'd catch a significant regression before hitting the threshold.
- **globalSetup path ../vitest.setup.ts** — Vitest resolves `globalSetup` paths relative to `root` (not the config file location). With `root: "./src"`, the path `./vitest.setup.ts` resolved to `src/vitest.setup.ts` which doesn't exist. Changed to `../vitest.setup.ts` to reach `apps/api/vitest.setup.ts`.
- **Remove --skip-generate from pretest** — Prisma 7.x removed the `--skip-generate` flag from `db push`. The flag was always optional (just skipped client regeneration); removing it is safe and fixes the pretest failure.
- **Test passwords Test@1234567!** — The DEFAULT_PASSWORD_POLICY (from Plan 01-01's work) requires min 12 chars, uppercase, lowercase, digit, and special char. The test passwords `test1234` fail all but the digit/lowercase requirement. Updated to `Test@1234567!` which satisfies all requirements.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed globalSetup path resolution with root: ./src**
- **Found during:** Task 1 (initial coverage run)
- **Issue:** vitest.config.ts had `globalSetup: ["./vitest.setup.ts"]` but with `root: "./src"`, vitest resolved it to `src/vitest.setup.ts` which doesn't exist. Error: `Failed to load url .../apps/api/src/vitest.setup.ts`
- **Fix:** Changed to `globalSetup: ["../vitest.setup.ts"]` — resolves correctly from `src/` to `apps/api/vitest.setup.ts`
- **Files modified:** apps/api/vitest.config.ts
- **Committed in:** 20224d2 (Task 1 commit)

**2. [Rule 3 - Blocking] Removed --skip-generate flag from pretest (Prisma 7.x)**
- **Found during:** Task 1 (pretest execution)
- **Issue:** `prisma db push --skip-generate` fails with `unknown or unexpected option: --skip-generate` in Prisma 7.x
- **Fix:** Changed pretest script to `prisma db push` (without flag) — functionally identical since we call `prisma generate` separately
- **Files modified:** apps/api/package.json
- **Committed in:** 20224d2 (Task 1 commit)

**3. [Rule 3 - Blocking] Regenerated Prisma client to v7.6.0**
- **Found during:** Task 1 (first test run after pretest fix)
- **Issue:** Generated Prisma client was v7.5.0 but schema included `failedLoginAttempts` field added after last generation. Prisma threw `Unknown argument failedLoginAttempts` causing auth tests to fail with 500 instead of 401.
- **Fix:** Ran `pnpm --filter @clokr/db exec prisma generate` — regenerated to v7.6.0 with full schema
- **Files modified:** packages/db/generated/client/ (regenerated, not committed — build artifact)
- **Committed in:** Not committed (Prisma generated client is not in git)

**4. [Rule 1 - Bug] Fixed employee test passwords to meet DEFAULT_PASSWORD_POLICY**
- **Found during:** Task 1 (second test run after Prisma regeneration)
- **Issue:** employees.test.ts used `password: "test1234"` (8 chars, no uppercase, no special) which fails DEFAULT_PASSWORD_POLICY requiring min 12 chars, uppercase, digit, and special character. The API returned 400 (validation error) instead of 201.
- **Fix:** Updated 3 test cases to use `"Test@1234567!"` which satisfies all policy requirements
- **Files modified:** apps/api/src/__tests__/employees.test.ts
- **Committed in:** 20224d2 (Task 1 commit)

---

**Total deviations:** 4 auto-fixed (3 blocking, 1 bug)
**Impact on plan:** All auto-fixes were necessary to achieve baseline measurement. No scope creep — all fixes directly enabled the plan's goal of measuring coverage.

## Known Stubs

None — this plan adds configuration only. No data flows or UI rendering involved.

## Issues Encountered

- The first coverage run produced 0% coverage due to the globalSetup path issue (vitest exited with no test files found). After fixing the path, tests ran but some failed, preventing coverage table output. Fixed systematically: path → pretest → Prisma client → test passwords.
- vitest stdout is heavily polluted by Fastify's pino JSON logger. The coverage table (text format) gets buried in the JSON output and is not visible in tail. Solution: run with `--coverage.reporter=json --coverage.reportsDirectory=./coverage` to generate a JSON file, then parse it separately.

## User Setup Required

None — no external service configuration required. The Prisma client regeneration happens automatically on first `pnpm --filter @clokr/db exec prisma generate` run.

## Next Phase Readiness

- Coverage thresholds enforced: any regression in test coverage below 37%/37%/24% will fail CI
- All 190 tests pass against the `?schema=test` test database
- Ready for Phase 2 (API coverage expansion) — the infrastructure is solid

---
*Phase: 01-test-infrastructure*
*Completed: 2026-03-30*

## Self-Check: PASSED

- SUMMARY.md: FOUND
- vitest.config.ts: FOUND
- Commit 20224d2: FOUND
- thresholds block in vitest.config.ts: 1 match (lines=37, functions=37, branches=24)
- pnpm test:coverage exit 0: VERIFIED (190 tests pass, coverage meets thresholds)
