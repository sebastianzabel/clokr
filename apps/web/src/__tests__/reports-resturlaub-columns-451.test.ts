// Issue #451 (D-07, D-08), Plan 451-08 Task 3 — source-pin test for the two Resturlaub columns
// on `/reports` reading the 451-07/451-08 facade fields with a `??` fallback for an older cached
// response. Same source-read technique as `admin-employee-save-wiring.test.ts` (this page isn't
// mountable either — no `$app` alias in `apps/web/vitest.config.ts`).

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
  "../routes/(app)/reports/+page.svelte",
  "src/routes/(app)/reports/+page.svelte",
);

describe("Issue #451 Plan 08 (D-07, D-08) — /reports shows effective carry-over and at-risk days", () => {
  it("the Urlaubsuebersicht 'Uebertrag' cell renders carriedOverEffectiveDays with a raw-days fallback", () => {
    expect(PAGE).toContain("formatDays(row.carriedOverEffectiveDays ?? row.carriedOverDays)");
  });

  it("the Verfall-Warnungen table header reads 'Gefährdet (T.)', not 'Anspruch (T.)'", () => {
    expect(PAGE).toContain('<th class="numeric">Gefährdet (T.)</th>');
    expect(PAGE).not.toContain('<th class="numeric">Anspruch (T.)</th>');
  });

  it("the Verfall-Warnungen first numeric cell renders atRiskDays with a raw-days fallback", () => {
    expect(PAGE).toContain("formatDays(row.atRiskDays ?? row.carriedOverDays)");
  });

  it("LeaveOverviewRealRow declares an optional carriedOverEffectiveDays field", () => {
    expect(PAGE).toMatch(/carriedOverEffectiveDays\?:\s*number/);
  });

  it("the at-risk row type declares an optional atRiskDays field", () => {
    expect(PAGE).toMatch(/atRiskDays\?:\s*number/);
  });
});
