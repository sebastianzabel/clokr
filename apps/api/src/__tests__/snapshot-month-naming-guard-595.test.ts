/**
 * Issue #595 (D-03) - the API names the month of a stored MONTHLY snapshot only through
 * `snapshotMonthOf` (`contexts/working-time-account/snapshot-period.ts`).
 *
 * The stored `periodStart` of a closed month has two conventions (the last day of the previous
 * month for a tenant-time-zone-converted row, the 1st for a legacy row), so a month taken from
 * the stored date by a date getter, a locale formatter or a seven-character ISO slice names every
 * converted row one month early - the bug the activity feed, the sparkline and the overtime trend
 * had. `snapshotMonthOf` is the exact inverse of the window the account reads a month under, so a
 * label and a lookup cannot disagree.
 *
 * The guard walks every non-test `.ts` file under `apps/api/src`, skips comment lines, and fails
 * on a statement that applies a month-or-year getter, `toLocaleDateString` or a seven-character
 * slice of the ISO string to a `periodStart` value. Allowed places: `snapshot-period.ts` (the one
 * place, including the YEARLY year) and the write path's `month-close-window.ts` (pinned equal to
 * `snapshotMonthOf` in `snapshot-period-595.test.ts`). The walked set is asserted non-empty
 * first. A hit anywhere else is a finding to report, not an allowance to add.
 *
 * Named blind spot: a value first copied into another variable is not seen; the guard is a
 * tripwire against the former shapes, not a proof of absence.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(__dirname, "..");

const ALLOWED = new Set([
  "contexts/working-time-account/snapshot-period.ts",
  "contexts/working-time-account/month-close-window.ts",
]);

/** A getter, locale formatter or short ISO slice applied to a periodStart value. */
const NAMING = [
  /periodStart[^;]*\.\s*(?:getUTCMonth|getMonth|getUTCFullYear|getFullYear)\s*\(/,
  /periodStart[^;]*\.\s*toLocaleDateString\s*\(/,
  /periodStart[^;]*\.\s*toISOString\s*\(\s*\)\s*\.\s*(?:slice|substring|substr)\s*\(\s*0\s*,\s*7\s*\)/,
];

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Statements (a line extended to the next `;`, at most four lines) that name a month from periodStart. */
export function monthNamingHits(file: string, source: string): string[] {
  const lines = source.split("\n");
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i]) || !lines[i].includes("periodStart")) continue;
    let statement = lines[i];
    for (let j = i + 1; j < Math.min(lines.length, i + 4) && !statement.includes(";"); j++) {
      if (isCommentLine(lines[j])) break;
      statement += lines[j].trim();
    }
    if (NAMING.some((re) => re.test(statement))) hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
  }
  return hits;
}

describe("snapshot months are named only through snapshotMonthOf (Issue #595, D-03)", () => {
  const files = walk(SRC_ROOT);

  it("walks a non-empty set of source files", () => {
    // Measured on 2026-10-17 with this walk: see the 595-03 SUMMARY.
    expect(files.length).toBeGreaterThan(200);
  });

  it("no file outside the two allowed ones derives a month from a periodStart value", () => {
    const hits = files.flatMap((f) => {
      const rel = relative(SRC_ROOT, f).replaceAll("\\", "/");
      return ALLOWED.has(rel) ? [] : monthNamingHits(rel, readFileSync(f, "utf8"));
    });
    expect(
      hits,
      "Issue #595 D-03 - name a stored snapshot's month with snapshotMonthOf() " +
        "(contexts/working-time-account), never from the stored date:\n" +
        hits.join("\n"),
    ).toEqual([]);
  });

  it("the allowed files exist (a renamed file must not leave a dead allowance)", () => {
    for (const rel of ALLOWED) expect(files.map((f) => relative(SRC_ROOT, f))).toContain(rel);
  });

  it("recognises the shapes it exists to catch", () => {
    expect(monthNamingHits("x.ts", "const m = s.periodStart.getUTCMonth() + 1;")).toHaveLength(1);
    expect(monthNamingHits("x.ts", "const y = s.periodStart.getFullYear();")).toHaveLength(1);
    expect(
      monthNamingHits("x.ts", 'const l = s.periodStart.toLocaleDateString("de-DE");'),
    ).toHaveLength(1);
    expect(
      monthNamingHits("x.ts", "const k = s.periodStart.toISOString().slice(0, 7);"),
    ).toHaveLength(1);
    // A prettier-wrapped chain is one statement.
    expect(
      monthNamingHits("x.ts", "const k = s.periodStart\n  .toISOString()\n  .slice(0, 7);"),
    ).toHaveLength(1);
    // Allowed shapes: the day slice, a comparison, a comment.
    expect(
      monthNamingHits("x.ts", "const d = s.periodStart.toISOString().slice(0, 10);"),
    ).toHaveLength(0);
    expect(monthNamingHits("x.ts", "// s.periodStart.getUTCMonth() is wrong here")).toHaveLength(0);
  });
});
