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

// The Monatsexport card is the last card of the team area; the employee area follows it.
const EMPLOYEE_AREA_MARKER = "<!-- EMP-06";

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
    const cardEnd = PAGE.indexOf(EMPLOYEE_AREA_MARKER, start);
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

  it("the § 9 note sits inside the Monatsexport card and follows its own month and year", () => {
    const cardStart = PAGE.indexOf("<!-- Monatsexport Card (Issue #617) -->");
    const cardEnd = PAGE.indexOf(EMPLOYEE_AREA_MARKER, cardStart);
    expect(cardStart).toBeGreaterThan(-1);
    expect(cardEnd).toBeGreaterThan(cardStart);
    const card = PAGE.slice(cardStart, cardEnd);
    expect(card).toContain('data-testid="report-section9-note"');
    expect(card).toContain("{exportSection9Note}");
    // exactly one place renders the note
    expect(PAGE.split('data-testid="report-section9-note"').length - 1).toBe(1);
    // the loader reads the Monatsexport card's own period, and runs only for report readers
    expect(PAGE).toContain("`/reports/monthly?year=${exportYear}&month=${exportMonth}`");
    expect(PAGE).toMatch(/const _m = exportMonth;\s+const _y = exportYear;\s+if \(canReportRead\)/);
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
