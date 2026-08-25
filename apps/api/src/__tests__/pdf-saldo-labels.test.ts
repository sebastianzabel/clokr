/**
 * Phase 97 Plan 02 (SALDO-DISP-05) — DB-free regression cover for the exported monthly PDF's
 * Saldo column and Bestätigt/Prognose labelling. Extended by Phase 104 Plan 12 (D-30) to also
 * cover the § 9 BUrlG legend.
 *
 * No Fastify app, no Prisma, no fixtures — immune to the documented pre-existing
 * UTC-vs-tenant-timezone fixture window (00:00–02:00 CEST, see
 * .planning/phases/98-saldo-ketten-integritaetspruefung/deferred-items.md).
 *
 * streamCompanyMonthlyReportPdf is a synchronous void function that RECEIVES its PDFDocument
 * (caller owns the lifecycle), which is the seam this test uses: drive it with a hand-rolled
 * recording stub instead of a real PDFKit document. The stub implements the small slice of the
 * PDFKit surface the function (and the drawColoredHeader/drawSmallFooter helpers it calls)
 * touches explicitly — `text`, plus the `y` / `page.width` / `page.height` / `page.margins.top`
 * state. Every OTHER method (fontSize, font, fillColor, moveTo, lineTo, stroke, addPage, rect,
 * fill, ...) falls through the Proxy's generic handler and is a no-op that returns the stub for
 * chaining, matching PDFKit's fluent API without having to hand-list every method it happens to
 * call. Only `text` is observed — every string written to the page is pushed into `texts`, in
 * draw order.
 *
 * generateMonthlyReportPdf (single-employee) is NOT driven here — it constructs its own
 * PDFDocument internally and returns a compressed Buffer, so its wording is pinned via the
 * shared exported label constants instead of by parsing rendered output (see the last `it` below).
 */
import { describe, it, expect } from "vitest";
import {
  streamCompanyMonthlyReportPdf,
  drawSection9Legend,
  OVERTIME_LABEL_CONFIRMED,
  OVERTIME_LABEL_FORECAST,
  COMPANY_PROVISIONAL_LEGEND,
  SECTION9_LEGEND,
  type CompanyMonthlyReportData,
} from "../utils/pdf";

type CompanyRow = CompanyMonthlyReportData["rows"][number];

interface RecordingDoc {
  texts: string[];
  y: number;
  page: { width: number; height: number; margins: { top: number } };
}

/** Hand-rolled DB-free / PDFKit-free recording stub — see file header for the exact contract. */
function createRecordingDoc(): PDFKit.PDFDocument & RecordingDoc {
  const texts: string[] = [];
  const target: Record<string, unknown> = {
    texts,
    y: 100,
    page: { width: 595, height: 842, margins: { top: 50 } },
  };

  const proxy: PDFKit.PDFDocument & RecordingDoc = new Proxy(target, {
    get(obj, prop: string) {
      if (prop === "text") {
        return (str: unknown) => {
          texts.push(String(str));
          return proxy;
        };
      }
      // Phase 104 (D-30): drawSection9Legend calls heightOfString(...) and adds the result to
      // doc.y, so unlike the other no-ops this one must return a number, not the chainable proxy.
      if (prop === "heightOfString") {
        return () => 12;
      }
      if (prop in obj) return obj[prop];
      // Any other PDFKit method (fontSize, font, fillColor, moveTo, lineTo, stroke, addPage,
      // rect, fill, ...) — a chainable no-op, matching PDFKit's fluent API.
      return () => proxy;
    },
    set(obj, prop: string, value) {
      obj[prop] = value;
      return true;
    },
  }) as unknown as PDFKit.PDFDocument & RecordingDoc;

  return proxy;
}

function makeRow(overrides: Partial<CompanyRow>): CompanyRow {
  return {
    employeeName: "Test Employee",
    employeeNumber: "T-001",
    role: "EMPLOYEE",
    workedHours: 0,
    targetHours: 0,
    overtimeHours: 0,
    overtimeConfirmed: true,
    sickDaysWithAttest: 0,
    sickDaysWithoutAttest: 0,
    vacationDays: 0,
    totalAbsenceDays: 0,
    section9DaysThisMonth: 0,
    entries: [],
    ...overrides,
  };
}

function makeData(rows: CompanyRow[]): CompanyMonthlyReportData {
  return {
    tenantName: "Testfirma GmbH",
    month: "Januar 2026",
    year: 2026,
    monthNumber: 1,
    roleFilter: "all",
    rows,
  };
}

describe("streamCompanyMonthlyReportPdf — Saldo column + Bestätigt/Prognose labelling (DB-free, SALDO-DISP-05)", () => {
  it("Saldo cell reads row.overtimeHours (not a locally recomputed workedHours-targetHours), marks provisional rows with an asterisk, and leaves unlabelled rows unmarked", () => {
    const doc = createRecordingDoc();

    streamCompanyMonthlyReportPdf(
      doc,
      makeData([
        // Ist − Soll would naively be +20.00 h — deliberately differs in both magnitude AND sign
        // from overtimeHours, so the pre-fix "local recomputation" bug cannot pass this assertion.
        makeRow({
          employeeName: "Alpha Confirmed",
          workedHours: 180,
          targetHours: 160,
          overtimeHours: -7.5,
          overtimeConfirmed: true,
        }),
        makeRow({
          employeeName: "Beta Forecast",
          workedHours: 50,
          targetHours: 40,
          overtimeHours: 3.25,
          overtimeConfirmed: false,
        }),
        makeRow({
          employeeName: "Gamma NoTarget",
          workedHours: 20,
          targetHours: 0,
          overtimeHours: 0,
          overtimeConfirmed: null,
        }),
      ]),
    );

    // Confirmed row: exact Saldo text sourced from row.overtimeHours, no asterisk.
    expect(doc.texts).toContain("-7.50");
    expect(doc.texts).not.toContain("-7.50 *");
    // Provisional row: Saldo text carries the asterisk marker.
    expect(doc.texts).toContain("+3.25 *");
    expect(doc.texts).not.toContain("+3.25");
    // Unlabelled row (MONTHLY_HOURS / no budget, overtimeConfirmed: null): no marker either way.
    expect(doc.texts).toContain("+0.00");
    expect(doc.texts).not.toContain("+0.00 *");
    // Legend appears exactly once — only "Beta Forecast" is provisional.
    expect(doc.texts.filter((t) => t === COMPANY_PROVISIONAL_LEGEND)).toHaveLength(1);
  });

  it("omits the legend entirely when every row is confirmed", () => {
    const doc = createRecordingDoc();

    streamCompanyMonthlyReportPdf(
      doc,
      makeData([
        makeRow({ employeeName: "Alpha", overtimeHours: 1, overtimeConfirmed: true }),
        makeRow({ employeeName: "Beta", overtimeHours: -2, overtimeConfirmed: true }),
      ]),
    );

    expect(doc.texts).not.toContain(COMPANY_PROVISIONAL_LEGEND);
  });

  it("omits the legend AND the asterisk when every row is unlabelled (null) — a MONTHLY_HOURS/no-budget population is never treated as 'provisional'", () => {
    const doc = createRecordingDoc();

    streamCompanyMonthlyReportPdf(
      doc,
      makeData([
        makeRow({ employeeName: "Alpha", overtimeHours: 0, overtimeConfirmed: null }),
        makeRow({ employeeName: "Beta", overtimeHours: 0, overtimeConfirmed: null }),
      ]),
    );

    expect(doc.texts).not.toContain(COMPANY_PROVISIONAL_LEGEND);
    expect(doc.texts.some((t) => t.includes("*"))).toBe(false);
  });

  it("OVERTIME_LABEL_CONFIRMED and OVERTIME_LABEL_FORECAST share the word Überstunden and differ from each other", () => {
    expect(OVERTIME_LABEL_CONFIRMED).toContain("Überstunden");
    expect(OVERTIME_LABEL_FORECAST).toContain("Überstunden");
    expect(OVERTIME_LABEL_CONFIRMED).not.toBe(OVERTIME_LABEL_FORECAST);
  });
});

describe("§ 9 BUrlG legend (Phase 104, D-30)", () => {
  it("Test 1: streamCompanyMonthlyReportPdf writes SECTION9_LEGEND exactly once when at least one row has section9DaysThisMonth > 0", () => {
    const doc = createRecordingDoc();

    streamCompanyMonthlyReportPdf(
      doc,
      makeData([
        makeRow({ employeeName: "Alpha", section9DaysThisMonth: 0 }),
        makeRow({ employeeName: "Beta", section9DaysThisMonth: 2 }),
      ]),
    );

    expect(doc.texts.filter((t) => t === SECTION9_LEGEND)).toHaveLength(1);
  });

  it("Test 2: with every row at section9DaysThisMonth 0, SECTION9_LEGEND is never written", () => {
    const doc = createRecordingDoc();

    streamCompanyMonthlyReportPdf(
      doc,
      makeData([
        makeRow({ employeeName: "Alpha", section9DaysThisMonth: 0 }),
        makeRow({ employeeName: "Beta", section9DaysThisMonth: 0 }),
      ]),
    );

    expect(doc.texts).not.toContain(SECTION9_LEGEND);
  });

  it("Test 3: the § 9 legend and the pre-existing COMPANY_PROVISIONAL_LEGEND can appear together, each exactly once, provisional legend first", () => {
    const doc = createRecordingDoc();

    streamCompanyMonthlyReportPdf(
      doc,
      makeData([
        makeRow({
          employeeName: "Alpha Forecast",
          overtimeConfirmed: false,
          section9DaysThisMonth: 0,
        }),
        makeRow({
          employeeName: "Beta Section9",
          overtimeConfirmed: true,
          section9DaysThisMonth: 3,
        }),
      ]),
    );

    expect(doc.texts.filter((t) => t === COMPANY_PROVISIONAL_LEGEND)).toHaveLength(1);
    expect(doc.texts.filter((t) => t === SECTION9_LEGEND)).toHaveLength(1);
    const provisionalIdx = doc.texts.indexOf(COMPANY_PROVISIONAL_LEGEND);
    const section9Idx = doc.texts.indexOf(SECTION9_LEGEND);
    expect(provisionalIdx).toBeLessThan(section9Idx);
  });

  it("Test 4: drawSection9Legend(doc, 0) writes nothing; drawSection9Legend(doc, 2) writes exactly SECTION9_LEGEND", () => {
    const docZero = createRecordingDoc();
    drawSection9Legend(docZero, 0);
    expect(docZero.texts).toHaveLength(0);

    const docTwo = createRecordingDoc();
    drawSection9Legend(docTwo, 2);
    expect(docTwo.texts).toEqual([SECTION9_LEGEND]);
  });

  it("Test 5: SECTION9_LEGEND equals the literal string already asserted by reports-sick-days.test.ts", () => {
    expect(SECTION9_LEGEND).toBe(
      "Tage mit bestätigter AU während genehmigten Urlaubs werden als Kranktage geführt und nicht auf den Jahresurlaub angerechnet (§ 9 BUrlG).",
    );
  });
});
