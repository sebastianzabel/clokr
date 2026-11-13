// Issue #613 (P-03, D-613-3) - the admin Monatsabschluss page shows "Austritt am ..." next to a
// person with an exit date. The route page is not mountable in the web test setup (no `$app`
// alias), so the wiring is pinned by source read; the formatting itself is unit-tested in
// `lib/month-close/__tests__/exit-label-613.test.ts`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    try {
      return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
    } catch {
      throw new Error(`route file missing: ${relativeFromCwd} (page moved or renamed?)`);
    }
  }
}

// #854 (plan 854-26): the page keeps the status shape; the persons list with the label moved into
// MonthStatusTable, the shapes into lib/month-close/types.ts. The pins read the files that own them.
const PAGE = readRouteFile(
  "../lib/components/admin/monatsabschluss/MonthStatusTable.svelte",
  "src/lib/components/admin/monatsabschluss/MonthStatusTable.svelte",
);
const TYPES = readRouteFile("../lib/month-close/types.ts", "src/lib/month-close/types.ts");

describe("/admin/month-close (MonthStatusTable) - exit date label (Issue #613)", () => {
  it("the page source is non-empty (the pins below are not vacuous)", () => {
    expect(PAGE.length).toBeGreaterThan(1000);
  });

  it("imports exitLabel from the lib module", () => {
    expect(PAGE).toMatch(
      /import \{[^}]*\bexitLabel\b[^}]*\} from "\$lib\/month-close\/exit-label"/,
    );
  });

  it("declares the additive exitDate on the status row", () => {
    expect(TYPES).toMatch(/exitDate\?: string \| null/);
  });

  it("renders the label of emp.exitDate in a neutral Chip, only when it is non-null", () => {
    expect(PAGE).toMatch(/\{#if exitLabel\(emp\.exitDate\)\}/);
    expect(PAGE).toMatch(/<Chip tone="neutral">\{exitLabel\(emp\.exitDate\)\}<\/Chip>/);
  });
});
