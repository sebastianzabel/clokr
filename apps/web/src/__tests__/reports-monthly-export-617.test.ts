// Issue #617 (OD-617-1) - source-pin test for the Monatsexport card on `/reports`. Same source-read
// technique as reports-resturlaub-columns-451.test.ts (the page is not mountable: no `$app` alias in
// `apps/web/vitest.config.ts`).

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

describe("Issue #617 - /reports offers the Monatsexport to export holders only", () => {
  it("downloads from the Monatsexport route with year and month", () => {
    expect(PAGE).toContain("/reports/monthly-export/pdf?year=${exportYear}&month=${exportMonth}");
  });

  it("names the file Monatsexport_<year>_<month>.pdf", () => {
    expect(PAGE).toContain(
      '`Monatsexport_${exportYear}_${String(exportMonth).padStart(2, "0")}.pdf`',
    );
  });

  it("the card and its download button sit inside a canReportExport block", () => {
    const marker = "<!-- Monatsexport Card (Issue #617) -->";
    const start = PAGE.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const gate = PAGE.indexOf("{#if canReportExport}", start);
    const button = PAGE.indexOf("onclick={downloadMonthlyExport}", start);
    const cardEnd = PAGE.indexOf("<!-- Urlaubsbericht PDF Card", start);
    expect(gate).toBeGreaterThan(start);
    expect(button).toBeGreaterThan(gate);
    expect(cardEnd).toBeGreaterThan(button);
    // the block opened by the gate closes before the next card begins
    const closing = PAGE.indexOf("{/if}", button);
    expect(closing).toBeGreaterThan(button);
    expect(closing).toBeLessThan(cardEnd);
  });

  it("the page still derives its rights from reportRights(", () => {
    expect(PAGE).toContain("reportRights(");
  });

  it("the card text promises no day list and labels the unit-free summary", () => {
    expect(PAGE).toContain("ohne Tagesliste");
    expect(PAGE).toContain("Lesbare Fassung des DATEV-Exports");
  });
});
