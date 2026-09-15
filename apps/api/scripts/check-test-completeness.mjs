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

const MIN_FILES = 241; // Phase 113b (T22, characterization baseline before #99): measured green run (241 files / 2733 passed + 3 skipped = 2736 total), full suite completed uninterrupted. The branch point (708ffbfa, merge-base with main) already carried 236 files against the previously recorded floor of 235 — one file of pre-existing drift from unrelated main-branch work between Phase 98b and this phase, which this raise absorbs without investigation since it is a floor and 236 > 235 never failed the gate. This phase itself added exactly 5: apps/api/scripts/__tests__/context-area-map.test.ts (113B-01), measure-saldo-path-parity.test.ts (113B-02), measure-context-coverage.test.ts (113B-04), and src/routes/__tests__/shifts-characterization.test.ts + leave-characterization.test.ts (113B-05) — 236 + 5 = 241. Raise when adding files.
const MIN_TESTS = 2733; // Phase 113b: measured green run — the passed count; the script compares numTotalTests, which was 2736 on that run (3 pre-existing skips, unrelated to this phase). This phase's own 5 new files contribute 46 tests (17 + 12 + 11 + 3 + 3, one grep count per file above) against a delta of 48 over the previous 2685 — the remaining 2 are the same class of pre-existing drift MIN_FILES's comment names, not this phase's own tests. Raise when adding tests.
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
