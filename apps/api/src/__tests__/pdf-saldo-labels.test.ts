/**
 * Phase 97 Plan 02 (SALDO-DISP-05) — DB-free regression cover for the exported monthly PDF's
 * Saldo column and Bestätigt/Prognose labelling.
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
  OVERTIME_LABEL_CONFIRMED,
  OVERTIME_LABEL_FORECAST,
  COMPANY_PROVISIONAL_LEGEND,
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
