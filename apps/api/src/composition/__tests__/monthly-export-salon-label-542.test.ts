/**
 * Issue #542 (OD-2, P-07) - the Monatsexport renderer under a salon scope, DB-free. Only `text` of
 * the recording stub is observed (the idiom of monthly-export-render-617.test.ts). Under a filter the
 * document names the salon and says that the list is narrowed by Stammsalon and that every saldo is
 * the person's, not split by salon; without a filter neither label constant is written. The web
 * mirrors the two constants by a text test (542-04).
 */
import { describe, it, expect } from "vitest";
import {
  drawMonthlyExport,
  generateMonthlyExportPdf,
  EXPORT_SALON_PERSONS_LABEL,
  PERSON_SALDO_NOT_SPLIT_LABEL,
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

function makeRow(n: number): MonthlyExportRow {
  return {
    employeeName: `P542x${n}, Vorname`,
    employeeNumber: `N-${n}`,
    status: "CONFIRMED",
    workedMinutes: 9150,
    expectedMinutes: 9600,
    balanceMinutes: -450,
    balanceAdjustmentMinutes: 0,
    closingBalanceMinutes: 1200,
    datevWorkedMinutes: 9150,
    absenceDays: { ...NO_ABSENCE },
    section9: false,
    vacation: null,
  };
}

function makeData(rows: MonthlyExportRow[], salonName?: string): MonthlyExportData {
  return {
    tenantName: "Testfirma",
    monthLabel: "September 2026",
    year: 2026,
    month: 9,
    generatedAt: "15.10.2026, 12:00",
    vacationYear: { year: 2026, asOf: "30.09.2026" },
    rows,
    ...(salonName === undefined ? {} : { salonScope: { salonName } }),
  };
}

function render(data: MonthlyExportData): string[] {
  const { doc, texts } = createRecordingDoc();
  drawMonthlyExport(doc, data);
  return texts;
}

const pageCount = (buffer: Buffer): number =>
  (buffer.toString("latin1").match(/\/Type \/Page(?!s)/g) ?? []).length;

describe("Monatsexport renderer under a salon scope (Issue #542)", () => {
  const LABEL_LINE = (name: string) =>
    `Salon: ${name} · ${EXPORT_SALON_PERSONS_LABEL} · ${PERSON_SALDO_NOT_SPLIT_LABEL}`;

  it("keeps the label constants as decided", () => {
    expect(EXPORT_SALON_PERSONS_LABEL).toBe("Personen nach Stammsalon am Monatsende");
    expect(PERSON_SALDO_NOT_SPLIT_LABEL).toBe("Personensaldo, nicht nach Salon aufgeteilt");
  });

  it("writes the label line exactly once, right after the header and the Monat line, under a salon scope", () => {
    const texts = render(makeData([makeRow(1), makeRow(2)], "Salon Mitte"));
    const line = LABEL_LINE("Salon Mitte");
    expect(texts.filter((t) => t === line)).toHaveLength(1);
    const header = texts.indexOf("Monatsexport · September 2026");
    const month = texts.indexOf("Monat: September 2026");
    expect(header).toBeGreaterThanOrEqual(0);
    expect(month).toBe(header + 1);
    expect(texts.indexOf(line)).toBe(month + 1);
  });

  it("writes the label line also when the narrowed list is empty", () => {
    const texts = render(makeData([], "Salon Mitte"));
    expect(texts.filter((t) => t === LABEL_LINE("Salon Mitte"))).toHaveLength(1);
    expect(texts).toContain("Keine Personen in diesem Monat.");
  });

  it("writes no label line without a salon scope", () => {
    const texts = render(makeData([makeRow(1)]));
    for (const t of texts) {
      expect(t.includes(EXPORT_SALON_PERSONS_LABEL), t).toBe(false);
      expect(t.includes(PERSON_SALDO_NOT_SPLIT_LABEL), t).toBe(false);
      expect(t.startsWith("Salon:"), t).toBe(false);
    }
  });

  it("a real buffer has the same page count with and without a salon scope", async () => {
    const rows = Array.from({ length: 9 }, (_, i) => makeRow(i + 1));
    const plain = await generateMonthlyExportPdf(makeData(rows));
    const scoped = await generateMonthlyExportPdf(makeData(rows, "Salon Mitte"));
    expect(pageCount(plain)).toBeGreaterThan(0);
    expect(pageCount(scoped)).toBe(pageCount(plain));
  });
});
