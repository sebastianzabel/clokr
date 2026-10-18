import { describe, it, expect } from "vitest";
import { periodCsvPath, periodReportPath, ymKey, type PeriodAbsence } from "../period-report";

describe("period-report contract (Issue #612)", () => {
  it("builds the request path with zero-padded months", () => {
    expect(periodReportPath({ year: 2026, month: 7 }, { year: 2026, month: 9 }, null)).toBe(
      "/reports/period?from=2026-07&to=2026-09",
    );
  });

  it("keeps two-digit months as they are", () => {
    expect(periodReportPath({ year: 2025, month: 11 }, { year: 2026, month: 10 }, null)).toBe(
      "/reports/period?from=2025-11&to=2026-10",
    );
  });

  it("appends an encoded salon id", () => {
    expect(periodReportPath({ year: 2026, month: 1 }, { year: 2026, month: 1 }, "a b&c")).toBe(
      "/reports/period?from=2026-01&to=2026-01&salonId=a%20b%26c",
    );
  });

  it("builds the CSV download path with the same query as the JSON answer", () => {
    const from = { year: 2026, month: 7 };
    const to = { year: 2026, month: 10 };
    expect(periodCsvPath(from, to, null)).toBe("/reports/period/csv?from=2026-07&to=2026-10");
    expect(periodCsvPath(from, to, "a b&c")).toBe(
      "/reports/period/csv?from=2026-07&to=2026-10&salonId=a%20b%26c",
    );
    // the file and the page ask the same question: only the route differs
    expect(periodCsvPath(from, to, "s1").replace("/period/csv", "/period")).toBe(
      periodReportPath(from, to, "s1"),
    );
  });

  it("formats a year-month key", () => {
    expect(ymKey({ year: 2026, month: 3 })).toBe("2026-03");
  });

  it("keys the absence statistics by leave-type code, sickness in calendar days", () => {
    const sick = {
      code: "SICK",
      unit: "CALENDAR_DAYS",
      personCount: 2,
      totalDays: 5,
    } satisfies PeriodAbsence;
    const vacation = {
      code: "VACATION",
      unit: "WORKDAYS",
      personCount: 1,
      totalDays: 3,
    } satisfies PeriodAbsence;
    expect([sick.code, vacation.code]).toEqual(["SICK", "VACATION"]);
  });
});
