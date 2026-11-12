// Issue #854 (D-854-08) - the Minijob hint: one table keyed by year, a hint (never a block) when the
// planned hours of a MINIJOB person lie above what the monthly limit allows at the minimum wage.
import { describe, expect, it } from "vitest";

import { MINIJOB_LIMITS, minijobHint, minijobLimitFor } from "../minijob";

const base = {
  classification: "MINIJOB",
  scheduleType: "FIXED_SCHEDULE",
  weeklyHours: 10,
  monthlyHours: null,
  validFrom: "2026-03-01",
} as const;

describe("MINIJOB_LIMITS", () => {
  it("holds the verified 2026 row and nothing else", () => {
    expect(Object.keys(MINIJOB_LIMITS)).toEqual(["2026"]);
    expect(MINIJOB_LIMITS[2026]).toEqual({ monthlyEuro: 603, minimumWageEuro: 13.9 });
  });

  it("uses the latest row for a later year and the earliest row for an earlier one", () => {
    expect(minijobLimitFor("2027-01-01")).toBe(MINIJOB_LIMITS[2026]);
    expect(minijobLimitFor("2031-06-15")).toBe(MINIJOB_LIMITS[2026]);
    expect(minijobLimitFor("2025-07-01")).toBe(MINIJOB_LIMITS[2026]);
    expect(minijobLimitFor(null)).toBe(MINIJOB_LIMITS[2026]);
    expect(minijobLimitFor("not-a-date")).toBe(MINIJOB_LIMITS[2026]);
  });
});

describe("minijobHint - weekly hours", () => {
  it("warns at 11 weekly hours (47.7 h a month are above 603 EUR at 13.90 EUR)", () => {
    expect(minijobHint({ ...base, weeklyHours: 11 })).toEqual({
      plannedMonthlyHours: 47.7,
      limitHours: 43.4,
      limitEuro: 603,
      minimumWageEuro: 13.9,
    });
  });

  it("is silent at 10 weekly hours (43.3 h a month are within the limit)", () => {
    expect(minijobHint({ ...base, weeklyHours: 10 })).toBeNull();
  });

  it("applies to flexible time and the roster as well, which also carry weekly hours", () => {
    expect(minijobHint({ ...base, scheduleType: "FLEXTIME", weeklyHours: 12 })).not.toBeNull();
    expect(minijobHint({ ...base, scheduleType: "SHIFT_BASED", weeklyHours: 12 })).not.toBeNull();
  });

  it("is silent without a usable number", () => {
    expect(minijobHint({ ...base, weeklyHours: null })).toBeNull();
    expect(minijobHint({ ...base, weeklyHours: 0 })).toBeNull();
    expect(minijobHint({ ...base, weeklyHours: Number.NaN })).toBeNull();
  });
});

describe("minijobHint - monthly hours", () => {
  const monthly = { ...base, scheduleType: "MONTHLY_HOURS", weeklyHours: null } as const;

  it("warns at 44 monthly hours and is silent at 43", () => {
    expect(minijobHint({ ...monthly, monthlyHours: 44 })).toMatchObject({
      plannedMonthlyHours: 44,
      limitHours: 43.4,
    });
    expect(minijobHint({ ...monthly, monthlyHours: 43 })).toBeNull();
  });

  it("ignores the weekly hours of a monthly-hours contract", () => {
    expect(minijobHint({ ...monthly, weeklyHours: 40, monthlyHours: 20 })).toBeNull();
  });

  it("is silent while the monthly hours are empty (pure time tracking)", () => {
    expect(minijobHint({ ...monthly, monthlyHours: null })).toBeNull();
    expect(minijobHint({ ...monthly, monthlyHours: 0 })).toBeNull();
  });
});

describe("minijobHint - who it applies to", () => {
  it("never fires for another classification", () => {
    for (const classification of ["VOLLZEIT", "TEILZEIT", "AZUBI", "AUSHILFE", "WERKSTUDENT"]) {
      expect(minijobHint({ ...base, classification, weeklyHours: 40 })).toBeNull();
    }
  });

  it("uses the 2026 row for a contract starting in 2027", () => {
    expect(minijobHint({ ...base, weeklyHours: 11, validFrom: "2027-01-01" })).toMatchObject({
      limitEuro: 603,
    });
    expect(minijobHint({ ...base, weeklyHours: 10, validFrom: "2027-01-01" })).toBeNull();
  });
});
