import { describe, it, expect } from "vitest";
import { periodReportPath, ymKey } from "../period-report";

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

  it("formats a year-month key", () => {
    expect(ymKey({ year: 2026, month: 3 })).toBe("2026-03");
  });
});
