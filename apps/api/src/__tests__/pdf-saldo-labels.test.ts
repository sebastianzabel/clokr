/**
 * Phase 97 Plan 02 (SALDO-DISP-05) - DB-free regression cover for the exported monthly PDF's
 * Saldo column and Bestätigt/Prognose labelling. Extended by Phase 104 Plan 12 (D-30) to also
 * cover the § 9 BUrlG legend.
 *
 * Issue #617: the subject is now the renderer of the Monatsexport, `drawMonthlyExport`, because the
 * company PDF these cases drove was replaced by it (same property, same oracle; figures are minutes
 * and print as H:MM through `composition/pdf-format.ts`). The single Stundennachweis keeps its label
 * constants (`OVERTIME_LABEL_*`, `BALANCE_ADJUSTMENT_*`, `SECTION9_LEGEND`), pinned in the cases below.
 *
 * No Fastify app, no Prisma, no fixtures - immune to the documented pre-existing
 * UTC-vs-tenant-timezone fixture window (00:00-02:00 CEST, see
 * .planning/phases/98-saldo-ketten-integritaetspruefung/deferred-items.md).
 *
 * `drawMonthlyExport` is a synchronous void function that RECEIVES its PDFDocument (the caller owns
 * the lifecycle), which is the seam this test uses: drive it with a hand-rolled recording stub
 * instead of a real PDFKit document. The stub implements the small slice of the PDFKit surface the
 * function (and the helpers it calls) touches explicitly - `text`, `heightOfString`, `widthOfString`
 * plus the `y` / `page` state. Every OTHER method (fontSize, font, fillColor, moveTo, lineTo, stroke,
 * addPage, rect, fill, ...) falls through the Proxy's generic handler and is a no-op that returns the
 * stub for chaining, matching PDFKit's fluent API without having to hand-list every method it happens
 * to call. Only `text` is observed - every string written to the page is pushed into `texts`, in draw
 * order.
 *
 * generateMonthlyReportPdf (single-employee) is NOT driven here - it constructs its own
 * PDFDocument internally and returns a compressed Buffer, so its wording is pinned via the
 * shared exported label constants instead of by parsing rendered output (see the label `it` blocks).
 */
import { describe, it, expect } from "vitest";
import {
  drawMonthlyExport,
  drawSection9Legend,
  OVERTIME_LABEL_CONFIRMED,
  OVERTIME_LABEL_FORECAST,
  MONTHLY_EXPORT_FORECAST_LEGEND,
  MONTHLY_EXPORT_UNLABELLED_LEGEND,
  MONTHLY_EXPORT_STATUS_LABEL,
  SECTION9_LEGEND,
  BALANCE_ADJUSTMENT_LABEL,
  BALANCE_ADJUSTMENT_LEGEND,
  type MonthlyExportData,
  type MonthlyExportRow,
} from "../composition/pdf";
import { fmtSignedHM } from "../composition/pdf-format";

interface RecordingDoc {
  texts: string[];
  y: number;
  page: {
    width: number;
    height: number;
    margins: { top: number; bottom: number; left: number; right: number };
  };
}

/** Hand-rolled DB-free / PDFKit-free recording stub - see file header for the exact contract. */
function createRecordingDoc(): PDFKit.PDFDocument & RecordingDoc {
  const texts: string[] = [];
  const target: Record<string, unknown> = {
    texts,
    y: 100,
    x: 36,
    page: { width: 842, height: 595, margins: { top: 36, bottom: 36, left: 36, right: 36 } },
  };

  const proxy: PDFKit.PDFDocument & RecordingDoc = new Proxy(target, {
    get(obj, prop: string) {
      if (prop === "text") {
        return (str: unknown) => {
          texts.push(String(str));
          return proxy;
        };
      }
      // The renderer measures text, so these two must return numbers, not the chainable proxy.
      if (prop === "heightOfString") return () => 12;
      // Width model of the stub: 3.6 pt per character, enough for the layout arithmetic.
      if (prop === "widthOfString") return (str: string) => String(str).length * 3.6;
      if (prop in obj) return obj[prop];
      // Any other PDFKit method (fontSize, font, fillColor, moveTo, lineTo, stroke, addPage,
      // rect, fill, ...) - a chainable no-op, matching PDFKit's fluent API.
      return () => proxy;
    },
    set(obj, prop: string, value) {
      obj[prop] = value;
      return true;
    },
  }) as unknown as PDFKit.PDFDocument & RecordingDoc;

  return proxy;
}

const NO_ABSENCE = {
  vacation: 0,
  sick: 0,
  sickChild: 0,
  overtimeComp: 0,
  special: 0,
  education: 0,
  unpaid: 0,
  maternity: 0,
  parental: 0,
};

let rowCounter = 0;

function makeRow(overrides: Partial<MonthlyExportRow>): MonthlyExportRow {
  rowCounter += 1;
  return {
    employeeName: `Test Employee ${rowCounter}`,
    employeeNumber: `T-${String(rowCounter).padStart(3, "0")}`,
    status: "CONFIRMED",
    workedMinutes: 0,
    expectedMinutes: 0,
    balanceMinutes: 0,
    // Issue #451 (D-03): default 0 - the vast majority of rows carry no reconciliation item.
    balanceAdjustmentMinutes: 0,
    closingBalanceMinutes: 0,
    datevWorkedMinutes: 0,
    absenceDays: { ...NO_ABSENCE },
    section9: false,
    vacation: null,
    ...overrides,
  };
}

function makeData(rows: MonthlyExportRow[]): MonthlyExportData {
  return {
    tenantName: "Testfirma GmbH",
    monthLabel: "Januar 2026",
    year: 2026,
    month: 1,
    generatedAt: "15.02.2026, 12:00",
    vacationYear: { year: 2026, asOf: "31.01.2026" },
    rows,
  };
}

function render(rows: MonthlyExportRow[]): string[] {
  const doc = createRecordingDoc();
  drawMonthlyExport(doc, makeData(rows));
  return doc.texts;
}

describe("drawMonthlyExport - Saldo column + Bestätigt/Prognose labelling (DB-free, SALDO-DISP-05)", () => {
  it("Saldo cell reads row.balanceMinutes (not a locally recomputed worked-expected), labels the status of each row and leaves unlabelled rows without Soll, Saldo and Gesamtsaldo", () => {
    const texts = render([
      // Ist - Soll would naively be +20:00 h - deliberately differs in both magnitude AND sign
      // from balanceMinutes, so a "local recomputation" bug cannot pass this assertion.
      makeRow({
        employeeName: "Alpha Confirmed",
        status: "CONFIRMED",
        workedMinutes: 10800,
        expectedMinutes: 9600,
        balanceMinutes: -450,
        closingBalanceMinutes: 5000,
      }),
      makeRow({
        employeeName: "Beta Forecast",
        status: "FORECAST",
        workedMinutes: 3000,
        expectedMinutes: 2400,
        balanceMinutes: 195,
        closingBalanceMinutes: 7000,
      }),
      makeRow({
        employeeName: "Gamma NoTarget",
        status: "UNLABELLED",
        workedMinutes: 1200,
        expectedMinutes: 0,
        balanceMinutes: 0,
        closingBalanceMinutes: null,
      }),
    ]);

    // Exact Saldo text sourced from row.balanceMinutes, signed H:MM with an ASCII hyphen.
    expect(texts).toContain(fmtSignedHM(-450));
    expect(texts).toContain("-7:30 h");
    expect(texts).toContain("+3:15 h");
    // The naive recomputations (+20:00 h and +10:00 h) are not printed anywhere.
    expect(texts).not.toContain(fmtSignedHM(10800 - 9600));
    expect(texts).not.toContain(fmtSignedHM(3000 - 2400));
    // Gesamtsaldo is read from closingBalanceMinutes.
    expect(texts).toContain(fmtSignedHM(5000));
    expect(texts).toContain(fmtSignedHM(7000));

    // Status labels, one per row; the old asterisk marker is gone with the decimal point.
    expect(texts.filter((t) => t === "Bestätigt")).toHaveLength(1);
    expect(texts.filter((t) => t === "Prognose")).toHaveLength(1);
    expect(texts.filter((t) => t === "ohne Soll")).toHaveLength(1);
    expect(texts.some((t) => t.includes("*"))).toBe(false);

    // Unlabelled row: a dash instead of Soll, Saldo and Gesamtsaldo (never "-20:00 h").
    expect(texts.filter((t) => t === "—")).toHaveLength(3);
    // Legend appears exactly once - only "Beta Forecast" is a forecast.
    expect(texts.filter((t) => t === MONTHLY_EXPORT_FORECAST_LEGEND)).toHaveLength(1);
  });

  it("omits the status legend entirely when every row is confirmed", () => {
    const texts = render([
      makeRow({ employeeName: "Alpha", balanceMinutes: 60, status: "CONFIRMED" }),
      makeRow({ employeeName: "Beta", balanceMinutes: -120, status: "CONFIRMED" }),
    ]);

    expect(texts).not.toContain(MONTHLY_EXPORT_FORECAST_LEGEND);
    expect(texts).not.toContain(MONTHLY_EXPORT_UNLABELLED_LEGEND);
    expect(texts).not.toContain("Prognose");
  });

  it("omits the forecast legend AND any marker when every row is unlabelled - a MONTHLY_HOURS/no-budget population is never treated as 'provisional'", () => {
    const texts = render([
      makeRow({ employeeName: "Alpha", status: "UNLABELLED", closingBalanceMinutes: null }),
      makeRow({ employeeName: "Beta", status: "UNLABELLED", closingBalanceMinutes: null }),
    ]);

    expect(texts).not.toContain(MONTHLY_EXPORT_FORECAST_LEGEND);
    expect(texts).not.toContain("Prognose");
    expect(texts.some((t) => t.includes("*"))).toBe(false);
    // What an unlabelled row does carry: its own explanation, once, and three dashes per row.
    expect(texts.filter((t) => t === MONTHLY_EXPORT_UNLABELLED_LEGEND)).toHaveLength(1);
    expect(texts.filter((t) => t === "—")).toHaveLength(6);
  });

  it("the status labels are the three words the page and the legends use", () => {
    expect(MONTHLY_EXPORT_STATUS_LABEL).toEqual({
      CONFIRMED: "Bestätigt",
      FORECAST: "Prognose",
      UNLABELLED: "ohne Soll",
    });
  });

  it("OVERTIME_LABEL_CONFIRMED and OVERTIME_LABEL_FORECAST (single Stundennachweis) share the word Überstunden and differ from each other", () => {
    expect(OVERTIME_LABEL_CONFIRMED).toContain("Überstunden");
    expect(OVERTIME_LABEL_FORECAST).toContain("Überstunden");
    expect(OVERTIME_LABEL_CONFIRMED).not.toBe(OVERTIME_LABEL_FORECAST);
  });
});

describe("§ 9 BUrlG legend (Phase 104, D-30)", () => {
  it("Test 1: drawMonthlyExport writes SECTION9_LEGEND exactly once when at least one row has a § 9 credit", () => {
    const texts = render([
      makeRow({ employeeName: "Alpha", section9: false }),
      makeRow({ employeeName: "Beta", section9: true }),
      makeRow({ employeeName: "Gamma", section9: true }),
    ]);

    expect(texts.filter((t) => t === SECTION9_LEGEND)).toHaveLength(1);
  });

  it("Test 2: with every row without a § 9 credit, SECTION9_LEGEND is never written", () => {
    const texts = render([
      makeRow({ employeeName: "Alpha", section9: false }),
      makeRow({ employeeName: "Beta", section9: false }),
    ]);

    expect(texts).not.toContain(SECTION9_LEGEND);
  });

  it("Test 3: the § 9 legend and the status legend can appear together, each exactly once, status legend first", () => {
    const texts = render([
      makeRow({ employeeName: "Alpha Forecast", status: "FORECAST", section9: false }),
      makeRow({ employeeName: "Beta Section9", status: "CONFIRMED", section9: true }),
    ]);

    expect(texts.filter((t) => t === MONTHLY_EXPORT_FORECAST_LEGEND)).toHaveLength(1);
    expect(texts.filter((t) => t === SECTION9_LEGEND)).toHaveLength(1);
    const statusIdx = texts.indexOf(MONTHLY_EXPORT_FORECAST_LEGEND);
    const section9Idx = texts.indexOf(SECTION9_LEGEND);
    expect(statusIdx).toBeLessThan(section9Idx);
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

describe("Verrechnung column + legend (Issue #451, D-03)", () => {
  it("writes a 'Verr.' header between 'Ist' and 'Saldo', '-8:00 h' for the non-zero row, and the legend exactly once after the table", () => {
    const texts = render([
      // Worked/expected deliberately non-trivial so the Verrechnung value cannot be confused with
      // another column; Ist - Soll + Verr. = Saldo: 5520 - 6000 - 480 = -960.
      makeRow({
        employeeName: "Alpha NonZero",
        workedMinutes: 5520,
        expectedMinutes: 6000,
        balanceAdjustmentMinutes: -480,
        balanceMinutes: -960,
        closingBalanceMinutes: 3000,
      }),
      makeRow({
        employeeName: "Beta Zero",
        workedMinutes: 6060,
        expectedMinutes: 6000,
        balanceAdjustmentMinutes: 0,
        balanceMinutes: 60,
        closingBalanceMinutes: 4000,
      }),
    ]);

    const istIdx = texts.indexOf("Ist");
    const verrIdx = texts.indexOf("Verr.");
    const saldoIdx = texts.indexOf("Saldo");
    expect(istIdx).toBeGreaterThanOrEqual(0);
    expect(verrIdx).toBeGreaterThan(istIdx);
    expect(saldoIdx).toBeGreaterThan(verrIdx);

    // The non-zero Verrechnung is printed once, signed, in minutes-based H:MM.
    expect(texts.filter((t) => t === "-8:00 h")).toHaveLength(1);
    // Issue #617 (orchestrator amendment 10): the column is hidden when every row is zero; in a
    // visible column a zero row prints an EMPTY cell, never "0:00 h" (no other cell of this fixture
    // is zero, so the unit zero appears nowhere).
    expect(texts.filter((t) => t === "0:00 h")).toHaveLength(0);

    expect(texts.filter((t) => t === BALANCE_ADJUSTMENT_LEGEND)).toHaveLength(1);
  });

  it("never writes the column or the legend when every row's balanceAdjustmentMinutes is 0", () => {
    const texts = render([
      makeRow({ employeeName: "Alpha", balanceAdjustmentMinutes: 0 }),
      makeRow({ employeeName: "Beta", balanceAdjustmentMinutes: 0 }),
    ]);

    expect(texts).not.toContain("Verr.");
    expect(texts).not.toContain(BALANCE_ADJUSTMENT_LEGEND);
  });

  it("an unlabelled row with balanceAdjustmentMinutes 0 prints no Verr. column and no asterisk - existing contract kept", () => {
    const texts = render([
      makeRow({
        employeeName: "Gamma Unlabelled",
        status: "UNLABELLED",
        balanceMinutes: 0,
        closingBalanceMinutes: null,
        balanceAdjustmentMinutes: 0,
      }),
    ]);

    expect(texts.some((t) => t.includes("*"))).toBe(false);
    expect(texts).not.toContain("Verr.");
    expect(texts).not.toContain(BALANCE_ADJUSTMENT_LEGEND);
  });

  it("BALANCE_ADJUSTMENT_LABEL equals 'Verrechnung'; the legend states the closing identity with an ASCII hyphen (WinAnsi has no U+2212)", () => {
    expect(BALANCE_ADJUSTMENT_LABEL).toBe("Verrechnung");
    expect(BALANCE_ADJUSTMENT_LEGEND).toContain("Ist - Soll + Verrechnung = Überstunden");
    expect(BALANCE_ADJUSTMENT_LEGEND).not.toContain("−");
  });
});
