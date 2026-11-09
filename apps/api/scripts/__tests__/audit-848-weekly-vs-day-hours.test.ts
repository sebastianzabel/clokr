/**
 * Issue #848 — the read-only audit's pure classification (no database).
 */
import { describe, it, expect } from "vitest";
import { weeklyMismatches, type WeeklyRow } from "../audit-848-weekly-vs-day-hours";

describe("Issue #848 — read-only audit script", () => {
  const row = (weekly: string | null, mon: string): WeeklyRow => ({
    schedule_id: "s",
    employee_id: "e",
    tenant_id: "t",
    valid_from: new Date("2026-01-01T00:00:00Z"),
    weekly_hours: weekly,
    work_days: [1, 2, 3, 4, 5],
    monday_hours: mon,
    tuesday_hours: "8.00",
    wednesday_hours: "8.00",
    thursday_hours: "8.00",
    friday_hours: "8.00",
    saturday_hours: "0.00",
    sunday_hours: "0.00",
  });

  it("lists exactly the rows whose weeklyHours differs from the day sum", () => {
    const found = weeklyMismatches([row("40.00", "8.00"), row("32.00", "8.00"), row(null, "8.00")]);
    expect(found.map((r) => [r.weekly_hours, r.day_sum])).toEqual([
      ["32.00", 40],
      [null, 40],
    ]);
  });
});
