/**
 * Phase 67b Plan 01 Task 2 (issue #67) — DB-free unit tests for
 * `contexts/platform/salon-assignment-rules.ts`. No `getTestApp()`, no Prisma — this module has
 * no database dependency by construction.
 */
import { describe, it, expect } from "vitest";
import {
  addDays,
  dayToDate,
  dateToDay,
  tenantLocalDay,
  mondayBasedWeekday,
  isVoided,
  isEffectiveOn,
  periodsOverlap,
  toAssignmentDto,
  FAR_FUTURE_DAY,
  type AssignmentRow,
} from "../contexts/platform/salon-assignment-rules";

describe("addDays", () => {
  it("adds and subtracts plain days", () => {
    expect(addDays("2026-06-15", 1)).toBe("2026-06-16");
    expect(addDays("2026-06-15", -1)).toBe("2026-06-14");
  });

  it("crosses a month end", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("crosses a year end", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("handles the 2028-02-29 leap day correctly", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addDays("2029-02-28", 1)).toBe("2029-03-01"); // 2029 is not a leap year
  });
});

describe("dayToDate / dateToDay round-trip", () => {
  it("round-trips a calendar day through a @db.Date-shaped UTC-midnight Date", () => {
    const day = "2026-07-04";
    expect(dateToDay(dayToDate(day))).toBe(day);
  });
});

describe("tenantLocalDay", () => {
  it("converts an instant to the tenant-local calendar day", () => {
    // 2026-09-26T22:30:00Z is a Saturday in UTC but already Sunday in Europe/Berlin (UTC+2 in
    // September, DST).
    expect(tenantLocalDay(new Date("2026-09-26T22:30:00Z"), "Europe/Berlin")).toBe("2026-09-27");
    expect(tenantLocalDay(new Date("2026-09-26T22:30:00Z"), "UTC")).toBe("2026-09-26");
  });
});

describe("mondayBasedWeekday", () => {
  it("maps seven consecutive UTC days to 0..6 (0 = Monday … 6 = Sunday)", () => {
    // 2026-09-21 is a Monday (ISO), so the next seven days cover Mon..Sun exactly once.
    const days = [
      "2026-09-21T12:00:00Z", // Monday
      "2026-09-22T12:00:00Z", // Tuesday
      "2026-09-23T12:00:00Z", // Wednesday
      "2026-09-24T12:00:00Z", // Thursday
      "2026-09-25T12:00:00Z", // Friday
      "2026-09-26T12:00:00Z", // Saturday
      "2026-09-27T12:00:00Z", // Sunday
    ];
    const weekdays = days.map((d) => mondayBasedWeekday(new Date(d), "UTC"));
    expect(weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("uses the TENANT-local weekday, not the UTC weekday (D-16 Sunday proof)", () => {
    // 2026-09-26T22:30:00Z: Saturday in UTC (weekday 5), Sunday in Europe/Berlin (weekday 6).
    expect(mondayBasedWeekday(new Date("2026-09-26T22:30:00Z"), "UTC")).toBe(5);
    expect(mondayBasedWeekday(new Date("2026-09-26T22:30:00Z"), "Europe/Berlin")).toBe(6);
  });
});

describe("isVoided / isEffectiveOn / periodsOverlap (D-03)", () => {
  const open = (validFrom: string) => ({ validFrom: dayToDate(validFrom), validUntil: null });
  const closed = (validFrom: string, validUntil: string) => ({
    validFrom: dayToDate(validFrom),
    validUntil: dayToDate(validUntil),
  });

  it("a row with validUntil < validFrom is voided", () => {
    expect(isVoided(closed("2026-06-15", "2026-06-14"))).toBe(true);
    expect(isVoided(closed("2026-06-15", "2026-06-15"))).toBe(false); // same-day is NOT voided
    expect(isVoided(open("2026-06-15"))).toBe(false);
  });

  it("isEffectiveOn: open-ended row is effective on and after validFrom, never before", () => {
    const row = open("2026-06-15");
    expect(isEffectiveOn(row, "2026-06-14")).toBe(false);
    expect(isEffectiveOn(row, "2026-06-15")).toBe(true);
    expect(isEffectiveOn(row, "2027-01-01")).toBe(true);
  });

  it("isEffectiveOn: closed row is effective only within [validFrom, validUntil] inclusive", () => {
    const row = closed("2026-06-15", "2026-06-20");
    expect(isEffectiveOn(row, "2026-06-14")).toBe(false);
    expect(isEffectiveOn(row, "2026-06-15")).toBe(true);
    expect(isEffectiveOn(row, "2026-06-20")).toBe(true);
    expect(isEffectiveOn(row, "2026-06-21")).toBe(false);
  });

  it("isEffectiveOn: a voided row (validUntil < validFrom) is effective on no day at all", () => {
    const row = closed("2026-06-15", "2026-06-14");
    expect(isEffectiveOn(row, "2026-06-13")).toBe(false);
    expect(isEffectiveOn(row, "2026-06-14")).toBe(false);
    expect(isEffectiveOn(row, "2026-06-15")).toBe(false);
    expect(isEffectiveOn(row, "2026-06-16")).toBe(false);
  });

  it("periodsOverlap: two closed periods sharing at least one day overlap", () => {
    expect(
      periodsOverlap(closed("2026-01-01", "2026-01-10"), closed("2026-01-10", "2026-01-20")),
    ).toBe(true); // same-day boundary counts as overlap
    expect(
      periodsOverlap(closed("2026-01-01", "2026-01-10"), closed("2026-01-11", "2026-01-20")),
    ).toBe(false); // adjacent, no shared day
  });

  it("periodsOverlap: an open period overlaps anything starting before it never ends", () => {
    expect(periodsOverlap(open("2026-01-01"), closed("2027-01-01", "2027-01-02"))).toBe(true);
    expect(periodsOverlap(open("2026-01-01"), closed("2025-01-01", "2025-12-31"))).toBe(false);
  });

  it("periodsOverlap: a voided period (either side) overlaps nothing", () => {
    const voided = closed("2026-06-15", "2026-06-14");
    expect(periodsOverlap(voided, open("2020-01-01"))).toBe(false);
    expect(periodsOverlap(open("2020-01-01"), voided)).toBe(false);
    expect(periodsOverlap(voided, voided)).toBe(false);
  });
});

describe("toAssignmentDto", () => {
  it("converts a Prisma-shaped row to the API DTO with YYYY-MM-DD date strings", () => {
    const row: AssignmentRow = {
      id: "a1",
      employeeId: "e1",
      salonId: "s1",
      kind: "HOME",
      validFrom: dayToDate("2024-01-01"),
      validUntil: null,
      weekdays: [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    expect(toAssignmentDto(row)).toEqual({
      id: "a1",
      employeeId: "e1",
      salonId: "s1",
      kind: "HOME",
      validFrom: "2024-01-01",
      validUntil: null,
      weekdays: [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  it("converts a non-null validUntil to a YYYY-MM-DD string too", () => {
    const row: AssignmentRow = {
      id: "a2",
      employeeId: "e1",
      salonId: "s2",
      kind: "DEPLOYMENT",
      validFrom: dayToDate("2026-09-01"),
      validUntil: dayToDate("2026-10-31"),
      weekdays: [3, 4],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    expect(toAssignmentDto(row).validUntil).toBe("2026-10-31");
  });
});

describe("FAR_FUTURE_DAY", () => {
  it("is a sentinel far in the future, never a real assignment date", () => {
    expect(FAR_FUTURE_DAY).toBe("9999-12-31");
  });
});
