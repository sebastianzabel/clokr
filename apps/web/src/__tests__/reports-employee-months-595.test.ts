// Issue #595 (D-02/D-03), Plan 595-02 - source pin for the employee's "Monatsabschluesse" table on
// `/reports`. Same source-read technique as reports-resturlaub-columns-451.test.ts (the page is not
// mountable - no `$app` alias in `apps/web/vitest.config.ts`).

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

describe("Issue #595 Plan 02 - /reports employee month table comes from the server answer", () => {
  it("builds its rows with buildEmployeeMonthRows from the lib module", () => {
    expect(PAGE).toContain('from "$lib/reports/employee-months"');
    expect(PAGE).toContain("buildEmployeeMonthRows(");
  });

  it("no longer builds a Date from a snapshot's periodStart or reads browser-local month getters for it", () => {
    expect(PAGE).not.toMatch(/new Date\(\s*r\.periodStart\s*\)/);
    expect(PAGE).not.toMatch(/new Date\([^)]*periodStart[^)]*\)/);
    // The month-name table moved to the lib module with the server-named months.
    expect(PAGE).not.toContain("EMP_MONTH_NAMES");
  });

  it("no longer reads a snapshot field named isLocked (it does not exist on SaldoSnapshot)", () => {
    expect(PAGE).not.toMatch(/\br\.isLocked\b/);
    expect(PAGE).not.toMatch(/\brow\.isLocked\b/);
    expect(PAGE).not.toMatch(/isLocked:\s*boolean/);
  });

  it("chooses the chip text from the row status: Abgeschlossen for closed, Offen for open", () => {
    expect(PAGE).toMatch(/row\.status === "closed"/);
    expect(PAGE).toContain("Abgeschlossen");
    expect(PAGE).toContain("Offen");
    expect(PAGE).not.toContain("Gesperrt");
  });

  it("passes the row status to the lock badge of SaldoAnzeige", () => {
    expect(PAGE).toContain('isLocked={row.status === "closed"}');
  });

  it("requests the PDF with the row's year and month", () => {
    expect(PAGE).toContain("downloadEmployeeMonthlyPdf(row.year, row.month, row.label)");
  });
});
