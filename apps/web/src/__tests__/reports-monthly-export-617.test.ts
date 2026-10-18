// Issue #617 (OD-617-1) - source-pin test for the Monatsexport on `/reports`. Same source-read
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

// Issue #612 (pin ledger row 13): the DATEV and Monatsexport cards are one "Exportieren" dialog now
// (`ExportDialog.svelte`, opened from the period bar). What is pinned stays: only export holders get
// the Monatsexport, the route and file name, the card text (no day list), the § 9 note inside the
// Monatsexport block following its own month, and the removed routes. The mounted proof of the dialog
// is `lib/components/reports/__tests__/ExportDialog.test.ts`.
const DIALOG = readRouteFile(
  "../lib/components/reports/ExportDialog.svelte",
  "src/lib/components/reports/ExportDialog.svelte",
);

describe("Issue #617 - /reports offers the Monatsexport to export holders only", () => {
  it("[vacuity gate] the page and the dialog are loaded", () => {
    expect(PAGE.length).toBeGreaterThan(1_000);
    expect(DIALOG.length).toBeGreaterThan(2_000);
  });

  it("downloads from the Monatsexport route with year and month", () => {
    expect(PAGE).toContain("/reports/monthly-export/pdf?year=${year}&month=${month}");
  });

  it("names the file Monatsexport_<year>_<month>.pdf", () => {
    expect(PAGE).toContain('`Monatsexport_${year}_${String(month).padStart(2, "0")}.pdf`');
  });

  it("the dialog and the bar's button exist for report:export holders only", () => {
    const gate = PAGE.indexOf("{#if canReportExport}\n    <ExportDialog");
    const dialog = PAGE.indexOf("<ExportDialog", gate);
    const closing = PAGE.indexOf("{/if}", dialog);
    const next = PAGE.indexOf("<PersonDrilldown", dialog);
    expect(gate).toBeGreaterThan(-1);
    expect(dialog).toBeGreaterThan(gate);
    // the block opened by the gate closes before the next component begins
    expect(closing).toBeGreaterThan(dialog);
    expect(closing).toBeLessThan(next);
    expect(PAGE).toContain("canExport={canReportExport}");
    expect(PAGE).toContain("onMonthlyExport={downloadMonthlyExport}");
  });

  it("the page still derives its rights from reportRights(", () => {
    expect(PAGE).toContain("reportRights(");
  });

  it("the dialog text promises no day list and labels the unit-free summary", () => {
    expect(DIALOG).toContain("ohne Tagesliste");
    expect(DIALOG).toContain("Lesbare Fassung des DATEV-Exports");
  });

  it("the § 9 note sits inside the Monatsexport block and follows its own month", () => {
    const blockStart = DIALOG.indexOf('data-export-block="monthly"');
    const blockEnd = DIALOG.indexOf('data-export-block="datev"');
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = DIALOG.slice(blockStart, blockEnd);
    expect(block).toContain('data-testid="report-section9-note"');
    expect(block).toContain("{note}");
    // exactly one place renders the note
    expect(DIALOG.split('data-testid="report-section9-note"').length - 1).toBe(1);
    // the dialog reads the note of the chosen month; the page's loader asks the route for it, and
    // only for report readers (the route needs report:read)
    expect(DIALOG).toContain("readNote(year, month)");
    expect(DIALOG).toContain("const { year, month } = selected;");
    expect(PAGE).toContain("`/reports/monthly?year=${year}&month=${month}`");
    expect(PAGE).toMatch(
      /if \(!canReportRead\) return null;\s+try \{\s+const res = await api\.get/,
    );
  });

  // Issue #617 (OD-617-4): the company card, its role select and its download are gone; the § 9 note
  // moved onto the Monatsexport card.
  it("no longer references the removed company PDF route, its card or its role select", () => {
    expect(PAGE.length).toBeGreaterThan(1000);
    expect(PAGE).not.toContain("/reports/monthly/pdf/all");
    expect(PAGE).not.toContain("companyPdf");
    expect(PAGE).not.toContain("company-pdf");
    expect(PAGE).not.toContain("Firmenweiter Monatsbericht");
    expect(PAGE).not.toContain("Nur Manager");
    expect(PAGE).not.toContain("&role=");
  });

  // Issue #617 (OD-617-4): the vacation list, vacation and overview PDFs and their card are gone.
  it("references none of the removed vacation-PDF routes and has no Urlaubsbericht card", () => {
    expect(PAGE.length).toBeGreaterThan(1000);
    expect(PAGE).not.toContain("/reports/leave-list/pdf");
    expect(PAGE).not.toContain("/reports/vacation/pdf");
    expect(PAGE).not.toContain("/reports/leave-overview/pdf");
    expect(PAGE).not.toContain("downloadVacationPdf");
    expect(PAGE).not.toContain("Urlaubsbericht");
    expect(PAGE).not.toContain("Urlaubslisten");
    // Issue #612: the in-app overview is part of the period answer; the page names no vacation route.
    expect(PAGE).not.toContain("/reports/leave-overview");
  });

  // Issue #612 (copy deck): the team subtitle describes the period report; the Monatsexport is
  // named by its own card (until the export dialog of 612-06) and by "Exportieren" afterwards.
  it("the team area subtitle names what the page now answers: one period of up to 12 months", () => {
    expect(PAGE).toContain("Zeiten, Konten und Urlaub für einen Zeitraum – bis zu 12 Monate.");
    expect(PAGE).not.toContain("Monatsexport, Stundennachweise und DATEV-Export erstellen");
  });
});
