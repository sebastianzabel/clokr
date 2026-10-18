// Issue #451 (D-07, D-08), Plan 451-08 Task 3 — source-pin test for the two Resturlaub columns
// on `/reports` reading the 451-07/451-08 facade fields with a `??` fallback for an older cached
// response. Same source-read technique as `admin-employee-save-wiring.test.ts`.
//
// Issue #612 (pin ledger row 14): the Urlaubsübersicht and the Verfall-Warnungen table moved into
// one component, `VacationAbsenceTab.svelte` (Verfall is a column of the Urlaub table now). The
// properties stay: the Übertrag cell is the effective carry-over, the Verfall cell the at-risk days,
// each with a raw-days fallback for an older answer. The mounted proof of both is
// `VacationAbsenceTab.test.ts`; this file pins the source expressions.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../lib/components/reports/VacationAbsenceTab.svelte",
  "src/lib/components/reports/VacationAbsenceTab.svelte",
);

describe("Issue #451 Plan 08 (D-07, D-08) — /reports shows effective carry-over and at-risk days", () => {
  it("[vacuity gate] the vacation tab source is loaded", () => {
    expect(PAGE.length).toBeGreaterThan(2_000);
    expect(PAGE).toContain("Verfall");
  });

  it("the 'Übertrag' cell renders carriedOverEffectiveDays with a raw-days fallback", () => {
    expect(PAGE).toContain("row.carriedOverEffectiveDays ?? row.carriedOverDays ?? 0");
  });

  it("the Verfall cell renders the at-risk days with a raw-days fallback", () => {
    expect(PAGE).toContain("row.atRiskDays ?? row.carriedOverDays ?? 0");
  });

  it("the table has a Verfall column and no 'Gefährdet' or 'Anspruch (T.)' header", () => {
    expect(PAGE).toContain('<th scope="col">Verfall</th>');
    expect(PAGE).not.toContain("Gefährdet (T.)");
    expect(PAGE).not.toContain("Anspruch (T.)");
  });

  it("the answer's row type declares the optional effective carry-over and at-risk fields", () => {
    const types = readRouteFile(
      "../lib/reports/period-report.ts",
      "src/lib/reports/period-report.ts",
    );
    expect(types).toMatch(/carriedOverEffectiveDays:\s*number \| null/);
    expect(types).toMatch(/atRiskDays:\s*number \| null/);
  });
});
