/**
 * Issue #617 (D-617-3/4, AC-617-3, AC-617-4) - the Stundennachweis renderer, DB-free.
 * `drawMonthlyReport` is driven with a recording stub (only `text` is observed, every other PDFKit
 * method is a chainable no-op, the idiom of monthly-export-render-617.test.ts); page counts are read
 * from real buffers by counting the `/Type /Page` dictionary entries (object dictionaries are not
 * compressed, content streams are - never search text in the bytes).
 */
import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import {
  drawMonthlyReport,
  generateMonthlyReportPdf,
  writeFooter,
  pageFooterText,
  OVERTIME_LABEL_CONFIRMED,
  OVERTIME_LABEL_FORECAST,
  OVERTIME_FORECAST_FOOTNOTE,
  BALANCE_ADJUSTMENT_LABEL,
  BALANCE_ADJUSTMENT_LEGEND,
  SECTION9_LEGEND,
  type MonthlyReportData,
} from "../pdf";

function createRecordingDoc(): { doc: PDFKit.PDFDocument; texts: string[] } {
  const texts: string[] = [];
  const target: Record<string, unknown> = {
    y: 100,
    x: 50,
    page: { width: 595, height: 842, margins: { top: 50, bottom: 50, left: 50, right: 50 } },
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
      if (prop === "widthOfString") return (str: string) => String(str).length * 4;
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

function makeEntries(count: number): MonthlyReportData["entries"] {
  return Array.from({ length: count }, (_, i) => ({
    date: `${String((i % 28) + 1).padStart(2, "0")}.09.2026`,
    start: "08:00",
    end: "16:30",
    breakMin: 30,
    netMinutes: 480,
    note: i === 0 ? "Notiz" : undefined,
  }));
}

function makeData(overrides: Partial<MonthlyReportData> = {}): MonthlyReportData {
  return {
    tenantName: "Testfirma",
    employeeName: "Vorname Nachname",
    employeeNumber: "N-1",
    month: "September 2026",
    generatedAt: "15.10.2026, 12:00",
    workedMinutes: 9225,
    targetMinutes: 9600,
    overtimeMinutes: -375,
    overtimeConfirmed: true,
    balanceAdjustmentMinutes: 0,
    sickDays: 1,
    sickDaysWithAttest: 0,
    vacationDays: 0.5,
    otherAbsenceDays: 0,
    section9Days: 0,
    entries: makeEntries(2),
    dayRows: [],
    ...overrides,
  };
}

function render(data: MonthlyReportData): string[] {
  const { doc, texts } = createRecordingDoc();
  drawMonthlyReport(doc, data);
  return texts;
}

/** `\d.\d` outside a dd.MM.yyyy date and outside the dd.MM. dates of a period label. */
function hasDecimalPoint(text: string): boolean {
  return /\d\.\d/.test(text.replace(/\d{2}\.\d{2}\.(\d{4})?/g, ""));
}

/** Number of page dictionaries of a PDF buffer (`/Type /Page`, not `/Type /Pages`). */
function pageCount(buffer: Buffer): number {
  return (buffer.toString("latin1").match(/\/Type \/Page(?!s)/g) ?? []).length;
}

/**
 * Draws the report on a real document and finishes it with the given footer writer, exactly like
 * `generateMonthlyReportPdf` does with `writeFooter`. The plain variant is the pre-617 behaviour: a
 * text call below `page.height - margins.bottom`, which makes PDFKit add a page.
 */
function renderWithFooter(
  data: MonthlyReportData,
  footer: (doc: PDFKit.PDFDocument, text: string) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawMonthlyReport(doc, data);
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        footer(doc, pageFooterText(data.generatedAt, i + 1, range.count));
      }
      doc.flushPages();
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

const plainFooter = (doc: PDFKit.PDFDocument, text: string): void => {
  doc.fontSize(7).text(text, 50, doc.page.height - 40, { align: "center", width: 495 });
};

describe("Stundennachweis renderer (Issue #617)", () => {
  describe("page count (AC-617-4)", () => {
    // "19 entries" is the issue's own case: it must fit one page with nothing after it.
    it.each([
      [0, 1],
      [19, 1],
      [45, 2],
    ])("%i entries -> %i page(s) through generateMonthlyReportPdf", async (count, pages) => {
      const buffer = await generateMonthlyReportPdf(
        makeData({
          entries: makeEntries(count),
          section9Days: 1,
          overtimeConfirmed: false,
          balanceAdjustmentMinutes: 0,
        }),
      );
      expect(pageCount(buffer)).toBe(pages);
    });

    it("with 45 entries page 2 carries table rows (it is not a blank page)", () => {
      const texts = render(makeData({ entries: makeEntries(45) }));
      // Every entry prints its Netto cell exactly once; none is lost to a page break.
      expect(texts.filter((t) => t === "8:00 h")).toHaveLength(45);
    });

    it("control: a plain-text footer instead of writeFooter adds a blank page to the same 19 entries", async () => {
      const data = makeData({ entries: makeEntries(19), overtimeConfirmed: false });
      const withHelper = await renderWithFooter(data, writeFooter);
      const withPlain = await renderWithFooter(data, plainFooter);
      expect(pageCount(withHelper)).toBe(1);
      expect(pageCount(withPlain)).toBeGreaterThan(1);
    });
  });

  describe("summary text", () => {
    it("prints Soll, Ist and Überstunden as H:MM from minutes with the label constants unchanged", () => {
      const texts = render(makeData());
      expect(texts).toContain("Soll: 160:00 h");
      expect(texts).toContain("Ist: 153:45 h");
      expect(texts).toContain(`${OVERTIME_LABEL_CONFIRMED}: -6:15 h`);
    });

    it("labels an open month as Prognose and prints the footnote once; an unlabelled row prints the plain label", () => {
      const forecast = render(makeData({ overtimeConfirmed: false, overtimeMinutes: 90 }));
      expect(forecast).toContain(`${OVERTIME_LABEL_FORECAST}: +1:30 h`);
      expect(forecast.filter((t) => t === OVERTIME_FORECAST_FOOTNOTE)).toHaveLength(1);

      const unlabelled = render(makeData({ overtimeConfirmed: null, overtimeMinutes: 0 }));
      expect(unlabelled).toContain("Überstunden: 0:00 h");
      expect(unlabelled.some((t) => t.includes("Bestätigt") || t.includes("Prognose"))).toBe(false);
    });

    it("names the unit of every count and uses the right number word", () => {
      const one = render(
        makeData({ sickDays: 1, sickDaysWithAttest: 1, vacationDays: 0.5, otherAbsenceDays: 2 }),
      );
      expect(one).toContain("Krankheitstage (Kalendertage): 1 Tag");
      expect(one).toContain("davon mit Attest: 1 Tag");
      expect(one).toContain("Urlaub (Arbeitstage): 0,5 Tage");
      expect(one).toContain("Sonstige Abwesenheit (Arbeitstage): 2 Tage");

      const many = render(makeData({ sickDays: 2.5, sickDaysWithAttest: 0, vacationDays: 0 }));
      expect(many).toContain("Krankheitstage (Kalendertage): 2,5 Tage");
      expect(many).toContain("davon mit Attest: 0 Tage");
      expect(many).toContain("Urlaub (Arbeitstage): 0 Tage");
    });

    it("prints the Verrechnung line and its legend only when the item is non-zero", () => {
      const without = render(makeData({ balanceAdjustmentMinutes: 0 }));
      expect(without.some((t) => t.startsWith(`${BALANCE_ADJUSTMENT_LABEL}:`))).toBe(false);
      expect(without).not.toContain(BALANCE_ADJUSTMENT_LEGEND);

      const withItem = render(makeData({ balanceAdjustmentMinutes: -480 }));
      expect(withItem).toContain(`${BALANCE_ADJUSTMENT_LABEL}: -8:00 h`);
      expect(withItem.filter((t) => t === BALANCE_ADJUSTMENT_LEGEND)).toHaveLength(1);
    });

    it("prints the § 9 legend only for a month with credited days", () => {
      expect(render(makeData({ section9Days: 0 }))).not.toContain(SECTION9_LEGEND);
      expect(render(makeData({ section9Days: 1 }))).toContain(SECTION9_LEGEND);
    });
  });

  describe("table", () => {
    it("prints Netto as H:MM and the Pause in whole minutes", () => {
      const texts = render(
        makeData({
          entries: [
            { date: "01.09.2026", start: "08:00", end: "16:45", breakMin: 30, netMinutes: 495 },
          ],
        }),
      );
      expect(texts).toContain("8:15 h");
      expect(texts).toContain("30 min");
    });

    it("an open entry prints a dash instead of an end time", () => {
      const texts = render(
        makeData({
          entries: [{ date: "01.09.2026", start: "08:00", end: "", breakMin: 0, netMinutes: 0 }],
        }),
      );
      expect(texts).toContain("—");
    });
  });

  describe("day rows (D-617-5, P-06)", () => {
    const DAY_ROWS = [
      { from: "2026-09-07", to: "2026-09-09", label: "Urlaub" },
      { from: "2026-09-10", to: "2026-09-10", label: "Berufsschule" },
      { from: "2026-09-01", to: "2026-09-01", label: "Feiertag: Testtag" },
    ];
    const entryAt = (date: string, start: string) => ({
      date,
      start,
      end: "17:00",
      breakMin: 0,
      netMinutes: 480,
    });

    it("merges the rows chronologically with the entries: a day row comes before the entries of its day", () => {
      const texts = render(
        makeData({
          dayRows: DAY_ROWS,
          entries: [
            entryAt("01.09.2026", "08:00"),
            entryAt("02.09.2026", "07:00"),
            entryAt("02.09.2026", "13:00"),
            entryAt("10.09.2026", "09:00"),
          ],
        }),
      );
      const marks = texts.filter((t) =>
        [
          "Feiertag: Testtag",
          "Urlaub",
          "Berufsschule",
          "07:00",
          "13:00",
          "08:00",
          "09:00",
        ].includes(t),
      );
      expect(marks).toEqual([
        "Feiertag: Testtag", // 01.09. holiday, before that day's entry
        "08:00", // 01.09.
        "07:00", // 02.09. morning block
        "13:00", // 02.09. afternoon block
        "Urlaub", // 07.-09.
        "Berufsschule", // 10.09., before that day's entry
        "09:00",
      ]);
    });

    it("prints a period as TT.MM.-TT.MM. and a single day as TT.MM.JJJJ", () => {
      const texts = render(makeData({ dayRows: DAY_ROWS, entries: [] }));
      expect(texts).toContain("07.09.\u201309.09.");
      expect(texts).toContain("10.09.2026");
      expect(texts).toContain("01.09.2026");
    });

    it("draws the table for day rows alone, and no table for neither entries nor rows", () => {
      expect(render(makeData({ dayRows: DAY_ROWS, entries: [] }))).toContain("Zeiteinträge");
      expect(render(makeData({ dayRows: [], entries: [] }))).not.toContain("Zeiteinträge");
    });

    it("a half-day label is printed as given and the text has no decimal point", () => {
      const texts = render(
        makeData({
          dayRows: [{ from: "2026-09-17", to: "2026-09-17", label: "Urlaub (halber Tag)" }],
        }),
      );
      expect(texts).toContain("Urlaub (halber Tag)");
      for (const t of texts) expect(hasDecimalPoint(t), t).toBe(false);
    });

    it("day rows are counted against the page: 19 entries and 6 day rows still make one page", async () => {
      const rows = Array.from({ length: 6 }, (_, i) => ({
        from: `2026-09-${String(i + 1).padStart(2, "0")}`,
        to: `2026-09-${String(i + 1).padStart(2, "0")}`,
        label: "Feiertag: Testtag",
      }));
      const buffer = await generateMonthlyReportPdf(
        makeData({ entries: makeEntries(19), dayRows: rows, overtimeConfirmed: false }),
      );
      expect(pageCount(buffer)).toBe(1);
    });
  });

  describe("German numbers everywhere (AC-617-3)", () => {
    it("no printed text has a decimal point between digits outside a date, and none says '1 Tage'", () => {
      const texts = render(
        makeData({
          sickDays: 1,
          sickDaysWithAttest: 1,
          vacationDays: 2.5,
          otherAbsenceDays: 0.5,
          balanceAdjustmentMinutes: 125,
          section9Days: 1,
          overtimeConfirmed: false,
          entries: makeEntries(5),
        }),
      );
      for (const t of texts) {
        expect(hasDecimalPoint(t), t).toBe(false);
        expect(t.includes("1 Tage"), t).toBe(false);
      }
    });
  });

  describe("footer", () => {
    it("reads 'Erstellt am <generatedAt>  ·  Seite X von Y  ·  Clokr' with the time of the payload", async () => {
      expect(pageFooterText("01.01.2027, 00:05", 2, 3)).toBe(
        "Erstellt am 01.01.2027, 00:05  ·  Seite 2 von 3  ·  Clokr",
      );
      const calls: string[] = [];
      await renderWithFooter(makeData({ generatedAt: "01.01.2027, 00:05" }), (_doc, text) =>
        calls.push(text),
      );
      expect(calls).toEqual(["Erstellt am 01.01.2027, 00:05  ·  Seite 1 von 1  ·  Clokr"]);
    });
  });
});
