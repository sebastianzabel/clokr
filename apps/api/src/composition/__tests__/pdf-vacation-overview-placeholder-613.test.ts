/**
 * Issue #613 (Phase 613, plan 02) - DB-free proof that a placeholder row of the vacation figures
 * prints „kein Anspruch hinterlegt“ and never `null`, `undefined` or `NaN`.
 *
 * Issue #617: the vacation overview PDFs this file used to drive were removed; the same property
 * now has its subject in section "Urlaubsjahr" of the Monatsexport, drawn by `drawMonthlyExport`.
 * The renderer receives its document, so the file drives it with a recording stub (the idiom of
 * `pdf-saldo-labels.test.ts`). Only `text` is observed, in draw order.
 */
import { describe, it, expect } from "vitest";
import {
  drawMonthlyExport,
  NO_ENTITLEMENT_LABEL,
  type MonthlyExportData,
  type MonthlyExportRow,
} from "../pdf";

function createRecordingDoc(): PDFKit.PDFDocument & { texts: string[] } {
  const texts: string[] = [];
  const target: Record<string, unknown> = {
    texts,
    y: 100,
    x: 36,
    page: { width: 842, height: 595, margins: { top: 36, bottom: 36, left: 36, right: 36 } },
  };
  const proxy: PDFKit.PDFDocument & { texts: string[] } = new Proxy(target, {
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
  }) as unknown as PDFKit.PDFDocument & { texts: string[] };
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

function makeRow(overrides: Partial<MonthlyExportRow>): MonthlyExportRow {
  return {
    employeeName: "Pop P613",
    employeeNumber: "P613",
    status: "CONFIRMED",
    workedMinutes: 0,
    expectedMinutes: 0,
    balanceMinutes: 0,
    balanceAdjustmentMinutes: 0,
    closingBalanceMinutes: 0,
    datevWorkedMinutes: 0,
    absenceDays: { ...NO_ABSENCE },
    section9: false,
    vacation: null,
    ...overrides,
  };
}

const data: MonthlyExportData = {
  tenantName: "Testfirma",
  monthLabel: "September 2026",
  year: 2026,
  month: 9,
  generatedAt: "05.10.2026, 12:00",
  vacationYear: { year: 2026, asOf: "30.09.2026" },
  rows: [
    makeRow({
      employeeName: "Pop P613real",
      employeeNumber: "P613-REAL",
      vacation: {
        entitlementDays: 28,
        carriedOverEffectiveDays: 3,
        availableDays: 31,
        takenDays: 5,
        approvedUpcomingDays: 0,
        pendingDays: 0,
        remainingDays: 26,
      },
    }),
    makeRow({ employeeName: "Pop P613none", employeeNumber: "P613-NONE", vacation: null }),
  ],
};

describe("vacation figures placeholder row (Issue #613, Monatsexport since #617)", () => {
  it("the label is the web overview's wording", () => {
    expect(NO_ENTITLEMENT_LABEL).toBe("kein Anspruch hinterlegt");
  });

  it("drawMonthlyExport prints the label once across the figure columns for a null row", () => {
    const doc = createRecordingDoc();
    drawMonthlyExport(doc, data);
    const texts = doc.texts;
    expect(texts.filter((t) => t === NO_ENTITLEMENT_LABEL)).toHaveLength(1);
    // the real row still prints its figures
    expect(texts).toEqual(expect.arrayContaining(["28", "3", "31", "5", "26"]));
  });

  it("never prints null, undefined or NaN anywhere in the document", () => {
    const doc = createRecordingDoc();
    drawMonthlyExport(doc, data);
    for (const t of doc.texts) {
      expect(t).not.toMatch(/null|undefined|NaN/);
    }
  });
});
