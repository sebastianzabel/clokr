/**
 * Phase 71b Plan 02 Task 3 (issue #71), D-05/AC-8 — outside `contexts/platform/` no production code
 * calls the computed-holiday engine (`getHolidays`/`STATE_MAP`, `contexts/platform/holidays.ts`) or
 * touches the `publicHoliday` Prisma delegate directly.
 *
 * The engine half is ALSO enforced by TypeScript once `contexts/platform/index.ts` stops
 * re-exporting `getHolidays`/`STATE_MAP` (Phase 71b Plan 07) — an unresolved import fails the
 * build. The delegate half is enforced ONLY by this test: Prisma exposes every model on every
 * client, so no import-boundary lint can see a bare `db.publicHoliday.findMany(...)` call the way
 * it can see a module import.
 *
 * Named blind spots, stated so nobody over-trusts this guard:
 *   - `apps/api/scripts/**` is OUT OF SCOPE (operator tools) — the same carve-out the #69 day-lookup
 *     guard (`time-entry-day-lookup-guard.test.ts`) makes, for the same reason.
 *   - Bracket-notation property access (e.g. `db["publicHoliday"]`) is not detected — a token scan
 *     for the literal names below cannot see through that indirection.
 *   - Comments are DELIBERATELY NOT exempt — a rewired file must not even NAME the engine or the
 *     delegate in a leftover comment; that residue is exactly the kind of drift this guard exists
 *     to catch, not to tolerate.
 *
 * RED at the time this guard was written (Phase 71b Plan 02, 2026-09-25, HEAD after Plan 02's two
 * commits): exactly the 13 known offender files listed in `71b-CONTEXT.md` still call
 * `getHolidays`/`STATE_MAP` or `publicHoliday` directly. Phase 71b Plans 03-07 rewire them onto
 * `contexts/platform`'s `holidaysAtWorkLocation`/`holidaysForSalon`, turning this guard GREEN — Plan
 * 07 commits this exact file (byte-identical) at `apps/api/src/__tests__/holiday-resolution-boundary.test.ts`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { describe, it, expect } from "vitest";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCAN_ROOT = "apps/api/src";
const PLATFORM_ROOT = "apps/api/src/contexts/platform";

// Measured 2026-09-25 (Phase 71b Plan 02): 124 production .ts files under apps/api/src, outside
// __tests__ and outside contexts/platform/. A ~15% floor (105) tolerates ordinary churn without
// masking a scan-root regression (an emptied or renamed root would report far fewer).
const MIN_SCANNED_FILES = 105;

// A file this scan MUST see, as a positive control that the walk actually reached deep into the
// tree (not just its top level).
const KNOWN_FILE = "apps/api/src/contexts/working-time-account/close-employee-month.ts";

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function collectFiles(): string[] {
  const out: string[] = [];
  function walk(absDir: string) {
    for (const entry of readdirSync(absDir)) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      const abs = join(absDir, entry);
      const rel = repoRel(abs);
      if (rel === PLATFORM_ROOT || rel.startsWith(`${PLATFORM_ROOT}/`)) continue;
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

const PUBLIC_HOLIDAY_RE = /\.publicHoliday\b/;
const ENGINE_RE = /\b(getHolidays|STATE_MAP)\b/;

describe("Phase 71b Plan 02 (issue #71), D-05/AC-8 — the holiday engine and publicHoliday stay inside contexts/platform/", () => {
  it("scan sees the tree (a silently-empty or shallow walk would pass forever)", () => {
    const files = collectFiles();
    // The trivial, literal non-emptiness proof (mirrors time-entry-day-lookup-guard.test.ts's own
    // first assertion) — kept separate from the measured-floor check below, which uses a NAMED
    // constant and therefore is not itself a literal proof.
    expect(files.length, "no file scanned outside contexts/platform/ at all").toBeGreaterThan(0);
    expect(
      files.length,
      "fewer production files scanned outside contexts/platform/ than the measured floor — the scan root moved, emptied, or the platform exclusion widened",
    ).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    const knownAbs = join(REPO_ROOT, KNOWN_FILE);
    expect(
      files,
      `the known deep file ${KNOWN_FILE} was not reached — the walk is shallower than expected`,
    ).toContain(knownAbs);
  });

  it("no production file outside contexts/platform/ accesses the publicHoliday Prisma delegate", () => {
    const files = collectFiles();
    const offenders = files
      .filter((abs) => PUBLIC_HOLIDAY_RE.test(readFileSync(abs, "utf8")))
      .map(repoRel)
      .sort();
    expect(
      offenders,
      `publicHoliday accessed outside contexts/platform/ — route through holidaysForSalon/holidaysAtWorkLocation:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no production file outside contexts/platform/ names getHolidays or STATE_MAP", () => {
    const files = collectFiles();
    const offenders = files
      .filter((abs) => ENGINE_RE.test(readFileSync(abs, "utf8")))
      .map(repoRel)
      .sort();
    expect(
      offenders,
      `getHolidays/STATE_MAP referenced outside contexts/platform/ — route through holidaysForSalon/holidaysAtWorkLocation:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the owner module exists and exports the resolution surface", () => {
    const abs = join(REPO_ROOT, "apps/api/src/contexts/platform/facade/holiday-resolution.ts");
    const source = readFileSync(abs, "utf8");
    expect(source).toMatch(/export async function holidaysAtWorkLocation/);
  });
});
