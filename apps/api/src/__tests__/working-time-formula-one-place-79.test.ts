/**
 * Phase 79 (Issue #79), D-03/D-04 — the working-time subtraction (presence minus the recorded
 * break) lives only in `contexts/time-tracking/entry-durations.ts`. Every reader of working time —
 * Arbeitszeitkonto, the composition layer, the ArbZG checks, the per-entry API fields — goes
 * through `entryDurations()` / `addWorkingMinutes()`.
 *
 * The detector finds a minus sign followed by a dotted receiver ending in `.breakMinutes`
 * (optionally wrapped in `Number(` and/or a parenthesis). Twelve inline copies of that subtraction
 * existed before Phase 79; the frozen fixture of plan 79-01 holds all of them verbatim and serves
 * as the positive control that this detector would have caught every one.
 *
 * One class-C exception is allowed, by COUNT and not by line number (a line pin goes stale on any
 * foreign edit): `contexts/time-tracking/api/retro-entry-requests.ts` `correctedNetWorkMin` — the
 * JArbSchG pre-write plan value on PROPOSED correction fields, presence rounded first and clamped at
 * 0. That is a different calculation, not the stored entry's working time.
 *
 * Named blind spots, stated so nobody over-trusts this guard:
 *   - `apps/api/scripts/**` (operator tools) and `apps/web/**` (UI, Block D #82-#86) are OUT OF
 *     SCOPE.
 *   - A break held in a local variable without a `.breakMinutes` access is not seen
 *     (`const b = x.breakMinutes; … - b`): the access itself is not preceded by a minus.
 *   - Bracket-notation access (`e["breakMinutes"]`) is not seen.
 *   - Comments are DELIBERATELY NOT exempt: a rewired file must not quote the old formula either.
 *
 * RED at the time this guard was written (Phase 79 Plan 05, 2026-10-05): the offender list named
 * exactly `apps/api/src/contexts/time-tracking/arbzg.ts` (S10-S12, migrated in the same plan).
 * Measured scan size on that day: 197 production files under apps/api/src outside `__tests__`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCAN_ROOT = "apps/api/src";

// Measured 2026-10-05 (Phase 79 Plan 05): 197 production .ts files under apps/api/src, outside
// __tests__ and node_modules (196 on f1fbb71f plus the kernel). A ~85 % floor tolerates ordinary
// churn without masking a scan-root regression (an emptied or renamed root reports far fewer).
const MIN_SCANNED_FILES = 167;

// A file this scan MUST see, as a positive control that the walk reached deep into the tree.
const KNOWN_FILE = "apps/api/src/contexts/working-time-account/close-employee-month.ts";

// The frozen pre-79 copies (plan 79-01) — the detector's positive control.
const FIXTURE_FILE =
  "apps/api/src/contexts/time-tracking/__tests__/fixtures/legacy-working-minutes-pre79.ts";

const KERNEL_FILE = "apps/api/src/contexts/time-tracking/entry-durations.ts";
const CLASS_C_FILE = "apps/api/src/contexts/time-tracking/api/retro-entry-requests.ts";

// Allowlist by count, never by line: the kernel states the rule (at least once), the class-C file
// holds exactly one different calculation.
const ALLOWED_COUNTS: Record<string, "atLeastOne" | number> = {
  [KERNEL_FILE]: "atLeastOne",
  [CLASS_C_FILE]: 1,
};

const DETECTOR_SOURCE = String.raw`-\s*(?:Number\(\s*)?\(?\s*[\w.]+\.breakMinutes\b`;

function countMatches(source: string): number {
  return (source.match(new RegExp(DETECTOR_SOURCE, "g")) ?? []).length;
}

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function collectFiles(): string[] {
  const out: string[] = [];
  function walk(absDir: string) {
    for (const entry of readdirSync(absDir)) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      const abs = join(absDir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs);
      } else if (extname(entry) === ".ts" && !entry.endsWith(".test.ts")) {
        out.push(abs);
      }
    }
  }
  walk(join(REPO_ROOT, SCAN_ROOT));
  return out;
}

describe("Phase 79 Plan 05 (issue #79), D-03/D-04 — the working-time subtraction lives in one production file", () => {
  it("scan sees the tree (a silently-empty or shallow walk would pass forever)", () => {
    const files = collectFiles();
    expect(files.length, "no production file scanned under apps/api/src at all").toBeGreaterThan(0);
    expect(
      files.length,
      "fewer production files scanned than the measured floor — the scan root moved or emptied",
    ).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    expect(
      files,
      `the known deep file ${KNOWN_FILE} was not reached — the walk is shallower than expected`,
    ).toContain(join(REPO_ROOT, KNOWN_FILE));
  });

  it("positive control: the detector catches every pre-79 copy in the frozen fixture", () => {
    const hits = countMatches(readFileSync(join(REPO_ROOT, FIXTURE_FILE), "utf8"));
    expect(
      hits,
      "the detector no longer recognises the twelve frozen pre-79 subtractions — it went blind",
    ).toBeGreaterThanOrEqual(12);
  });

  it("no production file outside the allowlist subtracts a recorded break inline", () => {
    const offenders = collectFiles()
      .map((abs) => ({ rel: repoRel(abs), hits: countMatches(readFileSync(abs, "utf8")) }))
      .filter(({ rel, hits }) => hits > 0 && !(rel in ALLOWED_COUNTS))
      .map(({ rel }) => rel)
      .sort();
    expect(
      offenders,
      `working time computed inline — route through entryDurations/addWorkingMinutes:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the allowlist holds by count: the kernel states the rule, the class-C file has exactly one", () => {
    const kernelHits = countMatches(readFileSync(join(REPO_ROOT, KERNEL_FILE), "utf8"));
    expect(kernelHits, "the kernel no longer states the subtraction").toBeGreaterThanOrEqual(1);
    const classCHits = countMatches(readFileSync(join(REPO_ROOT, CLASS_C_FILE), "utf8"));
    expect(
      classCHits,
      "retro-entry-requests.ts changed its number of inline break subtractions — a second copy, or the class-C site moved",
    ).toBe(ALLOWED_COUNTS[CLASS_C_FILE]);
  });
});
