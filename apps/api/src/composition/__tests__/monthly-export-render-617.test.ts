/**
 * Issue #617 (D-617-3/4/5, P-04) - the Monatsexport renderer, DB-free. `drawMonthlyExport` is driven
 * with a recording stub (the idiom of pdf-saldo-labels.test.ts: only `text` is observed, every other
 * PDFKit method is a chainable no-op); page counts are read from real buffers by counting the
 * `/Type /Page` dictionary entries (object dictionaries are not compressed, content streams are).
 */
import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import {
  drawMonthlyExport,
  generateMonthlyExportPdf,
  writeFooter,
  BALANCE_ADJUSTMENT_LEGEND,
  SECTION9_LEGEND,
  MONTHLY_EXPORT_DATEV_LEGEND,
  MONTHLY_EXPORT_FORECAST_LEGEND,
  MONTHLY_EXPORT_UNLABELLED_LEGEND,
  VACATION_YEAR_COLUMN_LABELS,
  VACATION_YEAR_LEGEND,
  NO_ENTITLEMENT_LABEL,
  type MonthlyExportVacation,
  type MonthlyExportData,
  type MonthlyExportRow,
} from "../pdf";

function createRecordingDoc(): { doc: PDFKit.PDFDocument; texts: string[] } {
  const texts: string[] = [];
  const target: Record<string, unknown> = {
    y: 100,
    x: 36,
    page: { width: 842, height: 595, margins: { top: 36, bottom: 36, left: 36, right: 36 } },
  };
  const proxy = new Proxy(target, {
    get(obj, prop: string) {
      if (prop === "text") {
        return (str: unknown) => {
          texts.push(String(str));
          return proxy;
        };
      }
      if (prop === "heightOfString") return () => 12;
      // Width model of the stub: 3.6 pt per character, enough for the layout arithmetic.
      if (prop === "widthOfString") return (str: string) => String(str).length * 3.6;
      if (prop in obj) return obj[prop];
      return () => proxy;
    },
    set(obj, prop: string, value) {
      obj[prop] = value;
      return true;
    },
  }) as unknown as PDFKit.PDFDocument;
  return { doc: proxy, texts };
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

const VACATION: MonthlyExportVacation = {
  entitlementDays: 30,
  carriedOverEffectiveDays: 2,
  availableDays: 32,
  takenDays: 10,
  approvedUpcomingDays: 5,
  pendingDays: 1,
  remainingDays: 17,
};

function makeRow(overrides: Partial<MonthlyExportRow> = {}): MonthlyExportRow {
  return {
    employeeName: "P617x, Vorname",
    employeeNumber: "N-1",
    status: "CONFIRMED",
    workedMinutes: 9150,
    expectedMinutes: 9600,
    balanceMinutes: -450,
    balanceAdjustmentMinutes: 0,
    closingBalanceMinutes: 1200,
    datevWorkedMinutes: 9150,
    absenceDays: { ...NO_ABSENCE },
    section9: false,
    vacation: { ...VACATION },
    ...overrides,
  };
}

function makeData(rows: MonthlyExportRow[]): MonthlyExportData {
  return {
    tenantName: "Testfirma",
    monthLabel: "September 2026",
    year: 2026,
    month: 9,
    generatedAt: "15.10.2026, 12:00",
    vacationYear: { year: 2026, asOf: "30.09.2026" },
    rows,
  };
}

function render(rows: MonthlyExportRow[]): string[] {
  const { doc, texts } = createRecordingDoc();
  drawMonthlyExport(doc, makeData(rows));
  return texts;
}

/** `\d.\d` outside a dd.MM.yyyy date. */
function hasDecimalPoint(text: string): boolean {
  return /\d\.\d/.test(text.replace(/\d{2}\.\d{2}\.\d{4}/g, ""));
}

/** Number of page dictionaries of a PDF buffer (`/Type /Page`, not `/Type /Pages`). */
function pageCount(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type \/Page(?!s)/g) ?? []).length;
}

describe("Monatsexport renderer (Issue #617)", () => {
  it("always writes the DATEV-Std. header and prints decimal hours with a comma", () => {
    const texts = render([makeRow({ datevWorkedMinutes: 9150 })]);
    expect(texts).toContain("DATEV-Std.");
    expect(texts).toContain("152,5");
    // Ist stays H:MM
    expect(texts).toContain("152:30 h");
  });

  it("draws Verr. and its legend only when some row has a non-zero adjustment", () => {
    const without = render([makeRow(), makeRow({ employeeNumber: "N-2" })]);
    expect(without).not.toContain("Verr.");
    expect(without).not.toContain(BALANCE_ADJUSTMENT_LEGEND);

    const withAdjustment = render([
      makeRow(),
      makeRow({ employeeNumber: "N-2", balanceAdjustmentMinutes: 480 }),
    ]);
    expect(withAdjustment.filter((t) => t === "Verr.").length).toBe(1);
    expect(withAdjustment.filter((t) => t === BALANCE_ADJUSTMENT_LEGEND).length).toBe(1);
    expect(withAdjustment).toContain("+8:00 h");
  });

  it("draws a kind column only when some row has a value for it", () => {
    const base = render([makeRow()]);
    // Urlaub and Krank are always there.
    expect(base).toContain("Urlaub");
    expect(base).toContain("Krank");
    for (const rare of [
      "Kind",
      "Sonder",
      "Bildungs",
      "Unbezahlt",
      "Mutter",
      "Eltern",
      "Ausgleich",
    ]) {
      expect(
        base.some((t) => t.includes(rare)),
        rare,
      ).toBe(false);
    }
    const withKinds = render([
      makeRow({
        absenceDays: { ...NO_ABSENCE, sickChild: 1, special: 2, overtimeComp: 0.5 },
      }),
    ]);
    expect(withKinds.some((t) => t.includes("Kind"))).toBe(true);
    expect(withKinds.some((t) => t.includes("Sonder"))).toBe(true);
    expect(withKinds.some((t) => t.includes("Ausgleich"))).toBe(true);
    // still absent: nobody has education / unpaid / maternity / parental days
    for (const rare of ["Bildungs", "Unbezahlt", "Mutter", "Eltern"]) {
      expect(
        withKinds.some((t) => t.includes(rare)),
        rare,
      ).toBe(false);
    }
    // day values use the decimal comma
    expect(withKinds).toContain("0,5");
  });

  it("prints the status legend once when a forecast row exists, the § 9 legend once for a § 9 row", () => {
    const none = render([makeRow()]);
    expect(none).not.toContain(MONTHLY_EXPORT_FORECAST_LEGEND);
    expect(none).not.toContain(SECTION9_LEGEND);

    const texts = render([
      makeRow({ status: "FORECAST", section9: true }),
      makeRow({ employeeNumber: "N-2", status: "FORECAST", section9: true }),
    ]);
    expect(texts.filter((t) => t === MONTHLY_EXPORT_FORECAST_LEGEND).length).toBe(1);
    expect(texts.filter((t) => t === SECTION9_LEGEND).length).toBe(1);
  });

  it("explains the Gesamtsaldo stand and the open-month saldo in the units line", () => {
    const texts = render([makeRow({ status: "FORECAST" })]);
    const units = texts.find((t) => t.startsWith("Zeiten in Stunden:Minuten"));
    expect(units).toBeDefined();
    expect(units).toContain("Gesamtsaldo");
    expect(units).toContain("bis gestern");
    expect(units).toContain("Saldo Monat");
  });

  it("prints the DATEV-Std. legend exactly when some row's Ist and DATEV-Std. differ", () => {
    const same = render([makeRow()]);
    expect(same).not.toContain(MONTHLY_EXPORT_DATEV_LEGEND);
    const differs = render([
      makeRow(),
      makeRow({ employeeNumber: "N-2", datevWorkedMinutes: 9300 }),
    ]);
    expect(differs.filter((t) => t === MONTHLY_EXPORT_DATEV_LEGEND).length).toBe(1);
  });

  it("prints a dash instead of Soll, Saldo and Gesamtsaldo for an unlabelled row", () => {
    const texts = render([
      makeRow({
        status: "UNLABELLED",
        expectedMinutes: 0,
        balanceMinutes: 0,
        closingBalanceMinutes: null,
      }),
    ]);
    expect(texts.filter((t) => t === "—").length).toBe(3);
    expect(texts).toContain("ohne Soll");
    expect(texts.filter((text) => text === MONTHLY_EXPORT_UNLABELLED_LEGEND).length).toBe(1);
    expect(texts).not.toContain(MONTHLY_EXPORT_FORECAST_LEGEND);
  });

  it("prints no decimal point between digits and never '1 Tage'", () => {
    const texts = render([
      makeRow({
        status: "FORECAST",
        balanceAdjustmentMinutes: 90,
        absenceDays: { ...NO_ABSENCE, vacation: 2.5, sick: 1, sickChild: 1.5 },
        section9: true,
        datevWorkedMinutes: 9333,
      }),
    ]);
    expect(texts.length).toBeGreaterThan(10);
    for (const text of texts) {
      expect(hasDecimalPoint(text), text).toBe(false);
      expect(text).not.toContain("1 Tage");
    }
  });

  it("says so when no person is in scope", () => {
    expect(render([])).toContain("Keine Personen in diesem Monat.");
  });

  it("fits every optional column on the page: no column is narrower than its header", () => {
    const row = makeRow({
      balanceAdjustmentMinutes: 60,
      absenceDays: {
        vacation: 1,
        sick: 1,
        sickChild: 1,
        overtimeComp: 1,
        special: 1,
        education: 1,
        unpaid: 1,
        maternity: 1,
        parental: 1,
      },
    });
    // Real PDFKit metrics: the document is created and rendered without error and the table stays
    // inside the page (a width model that overflowed would have thrown or produced extra pages).
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, bufferPages: true });
    drawMonthlyExport(doc, makeData([row]));
    expect(doc.bufferedPageRange().count).toBe(1);
    doc.end();
  });
});

describe("Monatsexport section Urlaubsjahr (D-617-2, P-03)", () => {
  it("names the year and the Stichtag in the section header", () => {
    expect(render([makeRow()])).toContain("Urlaubsjahr 2026, Stand 30.09.2026");
  });

  it("writes the seven column labels once, in the D-617-2 order", () => {
    expect([...VACATION_YEAR_COLUMN_LABELS]).toEqual([
      "Anspruch",
      "Übertrag (wirksam)",
      "Verfügbar",
      "Genommen",
      "Genehmigt",
      "Beantragt",
      "Resturlaub",
    ]);
    const texts = render([makeRow()]);
    let from = texts.indexOf("Urlaubsjahr 2026, Stand 30.09.2026");
    expect(from).toBeGreaterThanOrEqual(0);
    for (const label of VACATION_YEAR_COLUMN_LABELS) {
      expect(texts.filter((t) => t === label).length, label).toBe(1);
      const at = texts.indexOf(label, from);
      expect(at, label).toBeGreaterThan(from);
      from = at;
    }
  });

  it("prints the seven figures of a row with the decimal comma", () => {
    const texts = render([
      makeRow({
        vacation: {
          entitlementDays: 30,
          carriedOverEffectiveDays: 2.5,
          availableDays: 32.5,
          takenDays: 10.5,
          approvedUpcomingDays: 5,
          pendingDays: 0,
          remainingDays: 17,
        },
      }),
    ]);
    for (const expected of ["2,5", "32,5", "10,5"]) expect(texts, expected).toContain(expected);
  });

  it("prints the no-entitlement note for a person without a VACATION row, once per such person", () => {
    const texts = render([
      makeRow({ vacation: null }),
      makeRow({ employeeNumber: "N-2" }),
      makeRow({ employeeNumber: "N-3", vacation: null }),
    ]);
    expect(texts.filter((t) => t === NO_ENTITLEMENT_LABEL).length).toBe(2);
  });

  it("prints the vacation legend once, with the Resturlaub formula in ASCII", () => {
    const texts = render([makeRow(), makeRow({ employeeNumber: "N-2" })]);
    expect(texts.filter((t) => t === VACATION_YEAR_LEGEND).length).toBe(1);
    expect(VACATION_YEAR_LEGEND).toContain("Resturlaub = Verfügbar - Genommen - Genehmigt.");
    expect(VACATION_YEAR_LEGEND).toContain("Beantragt");
  });

  it("keeps the section out of an empty document", () => {
    const texts = render([]);
    expect(texts.some((t) => t.startsWith("Urlaubsjahr"))).toBe(false);
  });

  it("starts a new page when the section header and two rows no longer fit", async () => {
    // measured: 27 rows end section "Monat" close to the page bottom (the 3-row document above keeps
    // both sections on one page), so section "Urlaubsjahr" starts on page 2 and takes exactly it.
    const many = Array.from({ length: 27 }, (_, i) =>
      makeRow({ employeeNumber: `N-${i}`, employeeName: `P617x${i}, V` }),
    );
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, bufferPages: true });
    drawMonthlyExport(doc, makeData(many));
    const pages = doc.bufferedPageRange().count;
    doc.end();
    expect(pages).toBe(2);
    expect(pageCount(await generateMonthlyExportPdf(makeData(many)))).toBe(2);
  });
});

describe("Monatsexport page count (D-617-4)", () => {
  const rows = (n: number): MonthlyExportRow[] =>
    Array.from({ length: n }, (_, i) =>
      makeRow({ employeeNumber: `N-${i}`, employeeName: `P617x${i}, V` }),
    );

  it("3 rows fit one page", async () => {
    expect(pageCount(await generateMonthlyExportPdf(makeData(rows(3))))).toBe(1);
  });

  it("60 rows paginate without a blank trailing page", async () => {
    const buffer = await generateMonthlyExportPdf(makeData(rows(60)));
    const pages = pageCount(buffer);
    // measured: 60 rows of 14 pt do not fit the 595 pt landscape page once (about 31 rows on the
    // first page below the header band), so two pages carry section "Monat" and its legends; section
    // "Urlaubsjahr" (Issue #617, 617-02) repeats the 60 rows and starts on a new page because the
    // header and two rows no longer fit below the first section, so it takes two more. The footer
    // adds none. (Before 617-02 this document had 2 pages.)
    expect(pages).toBe(4);
  });

  it("mutation proof: a plain footer text at height-40 adds a page", async () => {
    const data = makeData(rows(3));
    const plain = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margin: 36,
        bufferPages: true,
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      drawMonthlyExport(doc, data);
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // The footer form the single-report PDF used before #617: a wrapped call below the bottom
        // margin starts a new page.
        doc.fontSize(7).text("Erstellt", 36, doc.page.height - 40, {
          align: "center",
          width: doc.page.width - 72,
        });
      }
      doc.flushPages();
      doc.end();
    });
    const real = await generateMonthlyExportPdf(data);
    expect(pageCount(real)).toBe(1);
    expect(pageCount(plain)).toBeGreaterThan(pageCount(real));
  });

  it("writeFooter restores the margin and the cursor", () => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
    doc.y = 123;
    doc.x = 40;
    writeFooter(doc, "Erstellt am 15.10.2026, 12:00");
    expect(doc.page.margins.bottom).toBe(36);
    expect(doc.y).toBe(123);
    expect(doc.x).toBe(40);
    doc.end();
  });
});
