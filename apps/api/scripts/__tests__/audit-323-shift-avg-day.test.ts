import { describe, it, expect } from "vitest";
import { auditLineFor, isDivergent } from "../audit-323-shift-avg-day";

const TZ = "Europe/Berlin";

describe("audit-323-shift-avg-day", () => {
  it("audit helper reports old vs new open-month Soll for a divergent row only", () => {
    const row = {
      schedule_id: "s",
      employee_id: "e",
      tenant_id: "t",
      timezone: TZ,
      weekly_hours: "40.00",
      contract_work_days_per_week: 4,
      work_days: [1, 2, 3, 4, 5],
    };
    expect(isDivergent(row)).toBe(true);
    expect(isDivergent({ ...row, contract_work_days_per_week: 5 })).toBe(false);
    const line = auditLineFor(row, new Date("2026-06-15T10:00:00Z"));
    expect(line.oldSollMinutes).toBeGreaterThan(0);
    expect(line.newSollMinutes).toBeGreaterThan(0);
    expect(line.deltaMinutes).toBe(line.newSollMinutes - line.oldSollMinutes);
  });
});
