// Issue #568 (D-07) — pure German labels and formatters of the bulk-apply preview dialog.
import { describe, expect, it } from "vitest";
import {
  CATEGORY_LABELS,
  REASON_LABELS,
  formatContract,
  formatDateDe,
  formatWorkDays,
  initialSelection,
  summaryLine,
} from "../bulk-apply-format";
import type { BulkApplyPreview, ContractValues } from "$lib/api/bulk-apply";

function values(weeklyHours: number | null, workDays: number[]): ContractValues {
  return {
    weeklyHours,
    mondayHours: 0,
    tuesdayHours: 0,
    wednesdayHours: 0,
    thursdayHours: 0,
    fridayHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
    workDays,
    overtimeThreshold: 40,
    allowOvertimePayout: false,
  };
}

describe("formatWorkDays", () => {
  it("renders a Monday-first consecutive range with an en dash", () => {
    expect(formatWorkDays([1, 2, 3, 4])).toBe("Mo–Do");
    expect(formatWorkDays([1, 2, 3, 4, 5])).toBe("Mo–Fr");
  });
  it("lists separated days with commas", () => {
    expect(formatWorkDays([1, 3, 5])).toBe("Mo, Mi, Fr");
  });
  it("orders Sunday last", () => {
    expect(formatWorkDays([6, 0])).toBe("Sa–So");
    expect(formatWorkDays([0, 1])).toBe("Mo, So");
  });
  it("names the empty set", () => {
    expect(formatWorkDays([])).toBe("keine Arbeitstage");
  });
});

describe("formatContract", () => {
  it("combines weekly hours and weekdays", () => {
    expect(formatContract(values(16, [1, 2, 3, 4]))).toBe("16 h · Mo–Do");
  });
  it("uses the German decimal comma", () => {
    expect(formatContract(values(7.5, [1]))).toBe("7,5 h · Mo");
  });
  it("names a missing weekly hours value", () => {
    expect(formatContract(values(null, [1, 2]))).toBe("Wochenstunden fehlen · Mo–Di");
  });
  it("names a missing contract", () => {
    expect(formatContract(null)).toBe("kein Vertrag hinterlegt");
  });
});

describe("formatDateDe / summaryLine", () => {
  it("formats an ISO date", () => {
    expect(formatDateDe("2026-11-01")).toBe("01.11.2026");
  });
  it("pluralises the summary", () => {
    expect(summaryLine(1, "2026-11-01")).toBe("1 Vertrag wird ab 01.11.2026 geändert");
    expect(summaryLine(3, "2026-11-01")).toBe("3 Verträge werden ab 01.11.2026 geändert");
    expect(summaryLine(0, "2026-11-01")).toBe("Kein Vertrag ausgewählt");
  });
});

describe("labels", () => {
  it("labels every category", () => {
    expect(CATEGORY_LABELS).toEqual({
      MATCHES_DEFAULTS: "Entspricht bisherigen Vorgaben",
      INDIVIDUAL: "Individueller Vertrag",
      NO_CONTRACT: "Kein Vertrag hinterlegt",
    });
  });
  it("labels every non-candidate reason", () => {
    expect(REASON_LABELS).toEqual({
      FUTURE_CONTRACT: "Späterer Vertrag bereits angelegt",
      SAME_MONTH_MODEL_SWITCH: "Anderes Arbeitszeitmodell zum Stichtag",
      CONTRACT_AT_DATE_EXISTS: "Vertrag zum Stichtag bereits vorhanden",
      OTHER_SCHEDULE_TYPE: "Anderes Arbeitszeitmodell (z. B. Minijob, Schichtbetrieb)",
      ALREADY_MATCHES_NEW: "Entspricht bereits den neuen Vorgaben",
    });
  });
});

describe("initialSelection", () => {
  it("selects exactly the defaultSelected candidates", () => {
    const base = { name: "x", employeeNumber: "1", before: null, after: values(40, [1]) };
    const preview = {
      candidates: [
        { ...base, employeeId: "a", category: "MATCHES_DEFAULTS", defaultSelected: true },
        { ...base, employeeId: "b", category: "INDIVIDUAL", defaultSelected: false },
        { ...base, employeeId: "c", category: "NO_CONTRACT", defaultSelected: true },
      ],
    } as unknown as BulkApplyPreview;
    expect([...initialSelection(preview)].sort()).toEqual(["a", "c"]);
  });
});
