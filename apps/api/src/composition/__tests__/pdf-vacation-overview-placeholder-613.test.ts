/**
 * Issue #613 (Phase 613, plan 02) — DB-free proof that a placeholder row of the vacation overview
 * prints „kein Anspruch hinterlegt“ and never `null`, `undefined` or `NaN`.
 *
 * Two renderers share the row drawing: `streamVacationOverviewPdf` receives its document (driven
 * here with a recording stub, the idiom of `pdf-saldo-labels.test.ts`), and
 * `generateVacationOverviewPdf` builds its own PDFKit document, so `pdfkit` is replaced by the same
 * kind of recording stub for that case. Only `text` is observed, in draw order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recorded: { texts: string[] } = vi.hoisted(() => ({ texts: [] }));

vi.mock("pdfkit", () => {
  class RecordingPdfDocument {
    y = 100;
    page = { width: 842, height: 595, margins: { top: 50 } };
    private handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    constructor() {
      const proxy: object = new Proxy(this, {
        get: (target, prop: string) => {
          if (prop === "text") {
            return (str: unknown) => {
              recorded.texts.push(String(str));
              return proxy;
            };
          }
          if (prop === "on") {
            return (event: string, cb: (arg?: unknown) => void) => {
              (target.handlers[event] ??= []).push(cb);
              return proxy;
            };
          }
          if (prop === "end") {
            return () => {
              for (const cb of target.handlers["data"] ?? []) cb(Buffer.from("pdf"));
              for (const cb of target.handlers["end"] ?? []) cb();
            };
          }
          if (prop in target) return (target as unknown as Record<string, unknown>)[prop];
          return () => proxy;
        },
      });
      return proxy as this;
    }
  }
  return { default: RecordingPdfDocument };
});

import PDFDocument from "pdfkit";
import {
  generateVacationOverviewPdf,
  streamVacationOverviewPdf,
  NO_ENTITLEMENT_LABEL,
  type VacationOverviewPdfRow,
} from "../pdf";

const employees: VacationOverviewPdfRow[] = [
  {
    name: "Pop P613real",
    employeeNumber: "P613-REAL",
    totalDays: 28,
    carriedOver: 3,
    usedDays: 5,
    remainingDays: 26,
  },
  { name: "Pop P613none", employeeNumber: "P613-NONE", missingEntitlement: true },
];

function expectCleanTexts(texts: string[]) {
  expect(texts).toContain(NO_ENTITLEMENT_LABEL);
  expect(texts.filter((t) => t === NO_ENTITLEMENT_LABEL)).toHaveLength(1);
  for (const t of texts) {
    expect(t).not.toMatch(/null|undefined|NaN/);
  }
  // the real row still prints its figures
  expect(texts).toEqual(expect.arrayContaining(["28", "3", "5", "26"]));
}

describe("vacation overview placeholder row (Issue #613)", () => {
  beforeEach(() => {
    recorded.texts.length = 0;
  });

  it("the label is the web overview's wording", () => {
    expect(NO_ENTITLEMENT_LABEL).toBe("kein Anspruch hinterlegt");
  });

  it("streamVacationOverviewPdf prints the label for a placeholder row", () => {
    streamVacationOverviewPdf(new PDFDocument(), {
      tenantName: "Testfirma",
      year: 2026,
      employees,
    });
    expectCleanTexts(recorded.texts);
  });

  it("generateVacationOverviewPdf prints the label for a placeholder row", async () => {
    const buffer = await generateVacationOverviewPdf({
      tenantName: "Testfirma",
      year: 2026,
      employees,
    });
    expect(buffer.length).toBeGreaterThan(0);
    expectCleanTexts(recorded.texts);
  });
});
