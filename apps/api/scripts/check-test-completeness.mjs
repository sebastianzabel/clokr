#!/usr/bin/env node
/**
 * D-09 (Phase 106): hard floor on collected test files and tests.
 *
 * Parallelisation can silently collect fewer files than intended. Every collected test would still
 * pass, coverage would dip only slightly, and the 40% line threshold could still be cleared — so
 * R6 ("no .skip, no weakened assertion") would be violated in effect while CI stayed green. This
 * script turns that class of silent failure into a red build.
 *
 * The price, accepted deliberately in D-09: these two numbers must be raised when tests are added.
 * The failure message says exactly that, and exactly how.
 *
 * NOTE: the JSON reporter's own `numTotalTestSuites` field counts `describe` blocks across all
 * files, NOT files (see 106-MEASUREMENTS.md § "Suite size (D-09 floor inputs)" — a 197-file suite
 * reported numTotalTestSuites=800). The true file count is `testResults.length`, which matches
 * vitest's own terminal "Test Files N passed (N)" summary exactly. Do NOT read numTotalTestSuites
 * for MIN_FILES.
 */
import { readFileSync } from "node:fs";

// Re-measured 2026-09-16 on `chore/100b-fassade` @ 18468ed5, plan 100B-01 Task 1: MIN_FILES rises
// from 249 to 250 (one new file, scripts/__tests__/measure-foreign-context-access.test.ts) and
// MIN_TESTS rises from 2839 to 2869 — exactly the 30 new test cases that file adds (verified with
// `pnpm exec vitest run scripts/__tests__/measure-foreign-context-access.test.ts`, "30 tests" in
// its own output). No other test file changed in this plan. Every later 100b plan asserts equality
// against THIS number, not the pre-phase 2839.
//
// Plan 100B-02: no new test FILE (both edited files already existed) — MIN_FILES stays 250.
// MIN_TESTS rises from 2869 to 2874: +2 in shift-week-leave-absence-minutes.test.ts (cases E, F)
// and +3 in contexts/absence/__tests__/leave-check.test.ts (the LeaveRequest branch: tenant-name
// pre-change pin, CANCELLATION_REQUESTED status, branch ordering) — 2869 + 2 + 3 = 2874. Verified
// with `pnpm exec vitest run` on each file individually ("6 tests" in both cases, up from 4 and 3
// respectively) before the full-suite run.
//
// Plan 100B-03: one new test FILE (scripts/__tests__/lint-facade-signatures.test.ts) — MIN_FILES
// rises from 250 to 251. MIN_TESTS rises from 2874 to 2895: +21 test cases in that file (verified
// with `pnpm exec vitest run scripts/__tests__/lint-facade-signatures.test.ts`, "21 tests" in its
// own output) — 2874 + 21 = 2895. No other test file changed in this plan.
//
// Plan 100B-04: one new test FILE (scripts/__tests__/lint-tenant-scoping-facade.test.ts) —
// MIN_FILES rises from 251 to 252. MIN_TESTS rises from 2895 to 2911: +16 test cases in that file
// (verified with `pnpm exec vitest run scripts/__tests__/lint-tenant-scoping-facade.test.ts`, "16
// tests" in its own output) — 2895 + 16 = 2911. No other test file changed in this plan; confirmed
// against the full-suite run's own "Test Files 252 passed (252)" / "Tests 2908 passed | 3 skipped
// (2911)" summary.
//
// Plan 100B-05: one new test FILE
// (src/contexts/scheduling/__tests__/facade-shifts.test.ts) — MIN_FILES rises from 252 to 253.
// MIN_TESTS rises from 2911 to 2916: +5 test cases in that file (verified with `pnpm exec vitest
// run src/contexts/scheduling/__tests__/facade-shifts.test.ts`, "5 tests" in its own output) —
// 2911 + 5 = 2916. No other test file changed in this plan.
//
// Plan 100B-06: one new test FILE
// (src/contexts/working-time-account/__tests__/facade-overtime-account.test.ts) — MIN_FILES rises
// from 253 to 254. MIN_TESTS rises from 2916 to 2925: +9 test cases in that file (verified with
// `pnpm exec vitest run src/contexts/working-time-account/__tests__/facade-overtime-account.test.ts`,
// "9 tests" in its own output) — 2916 + 9 = 2925. No other test file changed in this plan.
//
// Issue #241: no new test FILE (src/__tests__/test-dates.test.ts already existed) — MIN_FILES
// stays 254. MIN_TESTS rises from 2925 to 2928: +3 test cases for the new
// `saldoSnapshotPeriodBounds` fixture helper (verified with `pnpm exec vitest run
// src/__tests__/test-dates.test.ts`, "18 tests" in its own output, up from 15) — 2925 + 3 = 2928.
// The three existing tests this issue fixed (vocational-school-endpoints.test.ts x2,
// shifts-conflicts.test.ts x1) only changed HOW their existing SaldoSnapshot fixtures are built,
// not the test count.
//
// Issue #241 (fourth site — vocational-school-generator.ts's own BERSCH-09 lock-skip, the
// same defect the three sites above already fixed): no new test FILE. MIN_FILES stays 254.
// MIN_TESTS rises from 2928 to 2929: +1 new test case ("BERSCH-09 (Issue #241, consequence 1) —
// a locked month at the window's OWN leading edge...") in
// src/__tests__/vocational-school.test.ts (verified with `pnpm exec vitest run
// src/__tests__/vocational-school.test.ts`, "26 tests" in its own output, up from 25) —
// 2928 + 1 = 2929. Three existing tests (vocational-school.test.ts x2,
// vocational-school-retroactive.test.ts x3) only changed HOW their SaldoSnapshot fixtures are
// built (naive Date.UTC -> saldoSnapshotPeriodBounds()), not the test count.
//
// Issue #241 (fifth site — shift-cleanup.ts's own locked-month guard, the same defect the four
// sites above already fixed — plus the gate itself, scripts/lint-saldo-lock-derivation.ts): one
// new test FILE (scripts/__tests__/lint-saldo-lock-derivation.test.ts) — MIN_FILES rises from
// 254 to 255. MIN_TESTS rises from 2929 to 2960: +31 test cases in that new file (verified with
// `pnpm exec vitest run scripts/__tests__/lint-saldo-lock-derivation.test.ts`, "31 tests" in its
// own output) — 2929 + 31 = 2960. The existing `src/__tests__/shift-cleanup.test.ts` T5 test only
// changed HOW its SaldoSnapshot fixture is built (naive Date.UTC -> saldoSnapshotPeriodBounds()),
// not the test count.
// Phase 100B Plan 07 (Wave 3, final) — one new test FILE
// (contexts/working-time-account/__tests__/facade-saldo-snapshot.test.ts) — MIN_FILES rises
// from 255 to 256. MIN_TESTS rises from 2960 to 2981: +21 test cases in that new file (verified
// with `pnpm exec vitest run .../facade-saldo-snapshot.test.ts`, "21 tests" in its own output) —
// 2960 + 21 = 2981. Plus the facade-parameter-resolution regression guard added to the EXISTING
// `scripts/__tests__/lint-saldo-lock-derivation.test.ts` (no new FILE — MIN_FILES unchanged at
// 256): +7 test cases (31 -> 38, verified the same way) — MIN_TESTS rises from 2981 to 2988.
//
// Phase 100B Plan 08 (Wave 4) — one new test FILE
// (contexts/time-tracking/__tests__/facade-time-entries.test.ts) — MIN_FILES rises from 256 to
// 257. MIN_TESTS rises from 2988 to 3004: +16 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-time-entries.test.ts`, "16 tests" in its own output) —
// 2988 + 16 = 3004. No other test file's test COUNT changed in this plan.
//
// Phase 100B Plan 09 (Wave 4, closing) — one new test FILE
// (contexts/time-tracking/__tests__/facade-presence-devices.test.ts) — MIN_FILES rises from 257
// to 258. MIN_TESTS rises from 3004 to 3012: +8 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-presence-devices.test.ts`, "8 tests" in its own output) —
// 3004 + 8 = 3012. `src/__tests__/me-wifi.test.ts`'s existing "employee cannot delete another
// employee's device" test case gained two extra assertions (404 not 403, device-still-there) but
// stayed ONE test case — its file's own test COUNT (17) is unchanged, so it adds nothing here.
//
// Phase 100B Plan 10 (Wave 5, opening) — one new test FILE
// (contexts/absence/__tests__/facade-entitlements.test.ts) — MIN_FILES rises from 258 to 259.
// MIN_TESTS rises from 3012 to 3035: +23 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-entitlements.test.ts`, "23 tests" in its own output) —
// 3012 + 23 = 3035. No other test file's test COUNT changed in this plan.
//
// Phase 100B Plan 11 (Wave 5) — one new test FILE
// (contexts/absence/__tests__/facade-vocational-school-patterns.test.ts) — MIN_FILES rises from
// 259 to 260. MIN_TESTS rises from 3035 to 3044: +9 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-vocational-school-patterns.test.ts`, "9 tests" in its own
// output) — 3035 + 9 = 3044. No other test file's test COUNT changed in this plan.
//
// Phase 100B Plan 12 (Wave 5, closing model) — one new test FILE
// (contexts/absence/__tests__/facade-absences.test.ts) — MIN_FILES rises from 260 to 261.
// MIN_TESTS rises from 3044 to 3057: +13 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-absences.test.ts`, "13 tests" in its own output) —
// 3044 + 13 = 3057. No other test file's test COUNT changed in this plan.
//
// Phase 100B Plan 13 (Wave 5, LAST conversion plan — workload reaches zero) — one new test FILE
// (contexts/absence/__tests__/facade-leave-requests.test.ts) — MIN_FILES rises from 261 to 262.
// MIN_TESTS rises from 3057 to 3076: +19 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-leave-requests.test.ts`, "19 tests" in its own output) —
// 3057 + 19 = 3076. No other test file's test COUNT changed in this plan.
const MIN_FILES = 262;
const MIN_TESTS = 3076;
const REPORT = process.argv[2] ?? "apps/api/vitest-report.json";

let raw;
try {
  raw = readFileSync(REPORT, "utf8");
} catch (err) {
  console.error(
    `check-test-completeness: could not read ${REPORT} (${err.code ?? err.message}).\n` +
      `The run must have produced this file — confirm \`reporters: ["default", "json"]\` and ` +
      `\`outputFile: { json: "./vitest-report.json" }\` are set in apps/api/vitest.config.ts, and ` +
      `that the test run completed (a crashed run never writes the report).`,
  );
  process.exit(1);
}

let report;
try {
  report = JSON.parse(raw);
} catch (err) {
  console.error(`check-test-completeness: ${REPORT} is not valid JSON (${err.message}).`);
  process.exit(1);
}

const files = report.testResults?.length;
const tests = report.numTotalTests;

if (typeof files !== "number" || typeof tests !== "number") {
  console.error(
    `check-test-completeness: ${REPORT} is missing testResults[] or numTotalTests — is this a ` +
      `genuine vitest JSON reporter output?`,
  );
  process.exit(1);
}

if (files < MIN_FILES || tests < MIN_TESTS) {
  console.error(
    `check-test-completeness: FAILED — collected ${files}/${MIN_FILES} files, ${tests}/${MIN_TESTS} tests.\n` +
      `If you deliberately removed tests, lower the floor in apps/api/scripts/check-test-completeness.mjs ` +
      `in the SAME commit and say why in the commit body. If you did not, the parallel run silently ` +
      `collected fewer files — investigate before doing anything else.`,
  );
  process.exit(1);
}

console.log(
  `check-test-completeness: ${files}/${MIN_FILES} files, ${tests}/${MIN_TESTS} tests — OK`,
);
process.exit(0);
