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

const MIN_FILES = 235; // Phase 98b: measured green run (235 files / 2684 passed + 3 skipped). Coincidentally the same file count as the Phase 98 floor it replaces — 98b-04 deleted absence-type.test.ts and absence-type-mapping-guard.test.ts (233 files), and this plan added absence-vocabulary-guard.test.ts and leave-check.test.ts (back up to 235). Raise when adding files.
const MIN_TESTS = 2684; // Phase 98b: measured green run — the passed count; the script compares numTotalTests, which was 2687 on that run. LOWERED from 2705 because 98b-04 deleted absence-type.test.ts (14 tests) and absence-type-mapping-guard.test.ts (12 tests) — their subject (the agreement between two absence enums) no longer exists after the merge — and trimmed shift-availability.test.ts to one classifier; absence-vocabulary-guard.test.ts (9 tests) and leave-check.test.ts (3 tests), added by this plan, replace their remaining assertions. Raise when adding tests.
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

console.log(`check-test-completeness: ${files}/${MIN_FILES} files, ${tests}/${MIN_TESTS} tests — OK`);
process.exit(0);
