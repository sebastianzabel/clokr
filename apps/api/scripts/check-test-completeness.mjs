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

const MIN_FILES = 241; // Phase 204: measured green run (241 files / 2780 total, 2777 passed + 3 skipped, 0 failed — `pnpm --filter @clokr/api exec vitest run --coverage` against apps/api/vitest-report.json). Up from 235 (Phase 98b): plans 01-04 of this phase added 4 test files (lint-tenant-scoping.test.ts, lint-tenant-scoping-verdict.test.ts's own fixture suite, plus the candidates/request-bindings test files from plans 01-02) — see 204-01..204-04 SUMMARYs. Raise when adding files.
const MIN_TESTS = 2780; // Phase 204: measured green run — the script compares numTotalTests, which was 2780 on that run (2777 passed, 3 skipped, 0 failed). Up from 2685 (Phase 98b) by this phase's new test files. Raise when adding tests.
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
