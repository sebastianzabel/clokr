/**
 * Phase 95b Plan 02 — classification tests for the read-only WorkSchedule
 * workDays-vs-{day}Hours audit (audit-workdays-vs-day-hours.ts).
 *
 * Pure-function, DB-free: synthetic in-memory ScheduleRow fixtures only. The run-guard
 * (`import.meta.url === pathToFileURL(process.argv[1]).href`) in the script under test is
 * what makes this import side-effect-free — if that guard is ever removed this test will
 * hang or fail on a missing DATABASE_URL, which is intentional (mirrors
 * audit-bs-pattern-historisation.test.ts / audit-saldo-chain-integrity.test.ts).
 */
import { describe, it, expect } from "vitest";
import {
  classifyScheduleRow,
  deriveWorkDaysFromDayHours,
  renderReport,
  type ScheduleRow,
} from "../audit-workdays-vs-day-hours";

function mk(overrides: Partial<ScheduleRow> & { schedule_id: string }): ScheduleRow {
  return {
    schedule_id: overrides.schedule_id,
    employee_id: overrides.employee_id ?? "emp-1",
    employee_first_name: overrides.employee_first_name ?? "T",
    employee_last_name: overrides.employee_last_name ?? "Fixture",
    employee_number: overrides.employee_number ?? "T-0001",
    tenant_id: overrides.tenant_id ?? "tenant-1",
    tenant_name: overrides.tenant_name ?? "Test-Tenant",
    type: overrides.type ?? "FIXED_SCHEDULE",
    valid_from: overrides.valid_from ?? new Date("2026-01-01T00:00:00.000Z"),
    work_days: overrides.work_days ?? [],
    monday_hours: overrides.monday_hours ?? "0.00",
    tuesday_hours: overrides.tuesday_hours ?? "0.00",
    wednesday_hours: overrides.wednesday_hours ?? "0.00",
    thursday_hours: overrides.thursday_hours ?? "0.00",
    friday_hours: overrides.friday_hours ?? "0.00",
    saturday_hours: overrides.saturday_hours ?? "0.00",
    sunday_hours: overrides.sunday_hours ?? "0.00",
  };
}

describe("audit-workdays-vs-day-hours classifyScheduleRow / deriveWorkDaysFromDayHours (pure, DB-free)", () => {
  it("GT-95b-01 (D-07): MONTHLY_HOURS with workDays=Mo-Fr but all-zero hours is NOT divergent", () => {
    const row = mk({
      schedule_id: "sched-monthly",
      type: "MONTHLY_HOURS",
      work_days: [1, 2, 3, 4, 5],
      monday_hours: "0.00",
      tuesday_hours: "0.00",
      wednesday_hours: "0.00",
      thursday_hours: "0.00",
      friday_hours: "0.00",
      saturday_hours: "0.00",
      sunday_hours: "0.00",
    });
    const result = classifyScheduleRow(row);
    expect(result.divergent).toBe(false);
    expect(result.derived).toEqual([]);
  });

  it("GT-95b-02: FLEXTIME with uniform 1.00 placeholder hours is divergent, not expected", () => {
    const row = mk({
      schedule_id: "sched-flex",
      type: "FLEXTIME",
      work_days: [2, 3, 4, 5],
      monday_hours: "1.00",
      tuesday_hours: "1.00",
      wednesday_hours: "1.00",
      thursday_hours: "1.00",
      friday_hours: "1.00",
      saturday_hours: "1.00",
      sunday_hours: "1.00",
    });
    const result = classifyScheduleRow(row);
    expect(result.divergent).toBe(true);
    expect(result.expected).toBe(false);
    expect(result.derived).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("GT-95b-03: FIXED_SCHEDULE with real Mo-Fr hours matching workDays is NOT divergent", () => {
    const row = mk({
      schedule_id: "sched-fixed-ok",
      type: "FIXED_SCHEDULE",
      work_days: [1, 2, 3, 4, 5],
      monday_hours: "8.00",
      tuesday_hours: "8.00",
      wednesday_hours: "8.00",
      thursday_hours: "8.00",
      friday_hours: "8.00",
      saturday_hours: "0.00",
      sunday_hours: "0.00",
    });
    const result = classifyScheduleRow(row);
    expect(result.divergent).toBe(false);
  });

  it("GT-95b-04: SHIFT_BASED with placeholder 8.00 hours is divergent AND expected", () => {
    const row = mk({
      schedule_id: "sched-shift",
      type: "SHIFT_BASED",
      work_days: [1, 2, 3],
      monday_hours: "8.00",
      tuesday_hours: "8.00",
      wednesday_hours: "8.00",
      thursday_hours: "8.00",
      friday_hours: "8.00",
      saturday_hours: "8.00",
      sunday_hours: "8.00",
    });
    const result = classifyScheduleRow(row);
    expect(result.divergent).toBe(true);
    expect(result.expected).toBe(true);
  });

  it("GT-95b-05: FIXED_SCHEDULE original Phase 61 incident shape (mondayHours=0) is divergent, not expected", () => {
    const row = mk({
      schedule_id: "sched-fixed-incident",
      type: "FIXED_SCHEDULE",
      work_days: [1, 2, 3, 4, 5],
      monday_hours: "0.00",
      tuesday_hours: "8.00",
      wednesday_hours: "8.00",
      thursday_hours: "8.00",
      friday_hours: "8.00",
      saturday_hours: "0.00",
      sunday_hours: "0.00",
    });
    const result = classifyScheduleRow(row);
    expect(result.divergent).toBe(true);
    expect(result.expected).toBe(false);
  });

  it("GT-95b-06: deriveWorkDaysFromDayHours is order-independent and treats 0.00/1.00 as zero/non-zero", () => {
    const onlySunday = mk({
      schedule_id: "sched-sun",
      sunday_hours: "1.00",
      monday_hours: "0.00",
      tuesday_hours: "0.00",
      wednesday_hours: "0.00",
      thursday_hours: "0.00",
      friday_hours: "0.00",
      saturday_hours: "0.00",
    });
    expect(deriveWorkDaysFromDayHours(onlySunday)).toEqual([0]);

    const allZero = mk({ schedule_id: "sched-allzero" });
    expect(deriveWorkDaysFromDayHours(allZero)).toEqual([]);

    const onlySaturday = mk({
      schedule_id: "sched-sat",
      saturday_hours: "1.00",
    });
    expect(deriveWorkDaysFromDayHours(onlySaturday)).toEqual([6]);
  });
});

describe("audit-workdays-vs-day-hours renderReport (pure, DB-free)", () => {
  const shiftBasedDivergent = mk({
    schedule_id: "sched-shift-divergent",
    type: "SHIFT_BASED",
    work_days: [1, 2, 3],
    monday_hours: "8.00",
    tuesday_hours: "8.00",
    wednesday_hours: "8.00",
    thursday_hours: "8.00",
    friday_hours: "8.00",
    saturday_hours: "8.00",
    sunday_hours: "8.00",
  });

  const monthlyHoursPlaceholder = mk({
    schedule_id: "sched-monthly-placeholder",
    type: "MONTHLY_HOURS",
    work_days: [1, 2, 3, 4, 5],
    monday_hours: "0.00",
    tuesday_hours: "0.00",
    wednesday_hours: "0.00",
    thursday_hours: "0.00",
    friday_hours: "0.00",
    saturday_hours: "0.00",
    sunday_hours: "0.00",
  });

  const flextimeDivergent = mk({
    schedule_id: "sched-flex-divergent",
    type: "FLEXTIME",
    work_days: [2, 3, 4, 5],
    monday_hours: "1.00",
    tuesday_hours: "1.00",
    wednesday_hours: "1.00",
    thursday_hours: "1.00",
    friday_hours: "1.00",
    saturday_hours: "1.00",
    sunday_hours: "1.00",
  });

  it("GT-95b-07 (D-04): SHIFT_BASED hit is labelled [EXPECTED]; the MONTHLY_HOURS non-finding never appears", () => {
    const output = renderReport([shiftBasedDivergent, monthlyHoursPlaceholder]);
    expect(output).toContain("[EXPECTED]");
    expect(output).not.toContain("sched-monthly-placeholder");
  });

  it("GT-95b-08 (D-03): output states the one-directional semantics and the MONTHLY_HOURS reason", () => {
    const output = renderReport([shiftBasedDivergent, monthlyHoursPlaceholder]);
    expect(output).toContain("ONE-DIRECTIONAL");
    expect(output).toContain("MONTHLY_HOURS");
  });

  it("GT-95b-09: a clean run (nothing divergent) still prints the asymmetry note", () => {
    const output = renderReport([monthlyHoursPlaceholder]);
    expect(output).toContain("No WorkSchedule rows");
    expect(output).toContain("ONE-DIRECTIONAL");
  });

  it("GT-95b-10: a divergent FLEXTIME row renders with [REVIEW], not [EXPECTED]", () => {
    const output = renderReport([flextimeDivergent]);
    expect(output).toContain("[REVIEW]");
    expect(output).not.toContain("[EXPECTED]");
  });
});
