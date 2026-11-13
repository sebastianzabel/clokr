// Issue #854 (plan 854-21) - the pure model of the contract form: the values of a stored schedule, the
// field messages and the body of PUT /settings/work/:employeeId per model.
import { describe, expect, it } from "vitest";
import {
  CONTRACT_KEYS,
  buildSchedulePayload,
  contractErrors,
  contractValuesOf,
  germanDay,
  overtimeLocked,
  plannedWeeklyHours,
  type ContractSchedule,
} from "$lib/employees/vertrag-form";

const FIXED: ContractSchedule = {
  id: "s1",
  type: "FIXED_SCHEDULE",
  weeklyHours: "40.00",
  monthlyHours: null,
  mondayHours: "8.00",
  tuesdayHours: "8.00",
  wednesdayHours: "8.00",
  thursdayHours: "8.00",
  fridayHours: "8.00",
  saturdayHours: "0.00",
  sundayHours: "0.00",
  overtimeThreshold: "60.00",
  allowOvertimePayout: false,
  validFrom: "2026-06-01T00:00:00.000Z",
  workDays: [1, 2, 3, 4, 5],
};

describe("contractValuesOf", () => {
  it("reads Decimal strings as numbers and defaults „Gültig ab“ to the given day, not the stored one", () => {
    const values = contractValuesOf(FIXED, "2026-12-01");
    expect(values.type).toBe("FIXED_SCHEDULE");
    expect(values.days).toEqual({ mon: 8, tue: 8, wed: 8, thu: 8, fri: 8, sat: 0, sun: 0 });
    expect(values.overtimeThreshold).toBe(60);
    expect(values.validFrom).toBe("2026-12-01");
    expect(values.monthlyWorkDays).toEqual([1, 2, 3, 4, 5]);
  });

  it("falls back to the form defaults without a stored schedule", () => {
    const values = contractValuesOf(null, "2026-12-01");
    expect(values).toMatchObject({
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      overtimeThreshold: 60,
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      workDays: [1, 2, 3, 4, 5],
      usualWorkDays: [],
    });
  });

  it("keeps the stored overtime mode, also TRACK_ONLY (the lock is display only)", () => {
    const values = contractValuesOf(
      { ...FIXED, type: "MONTHLY_HOURS", overtimeMode: "TRACK_ONLY", monthlyHours: "0" },
      "2026-12-01",
    );
    expect(values.overtimeMode).toBe("TRACK_ONLY");
    expect(overtimeLocked(values)).toBe(true);
  });

  it("sorts the stored übliche Arbeitstage", () => {
    const values = contractValuesOf(
      { ...FIXED, type: "SHIFT_BASED", usualWorkDays: [5, 1, 3], contractWorkDaysPerWeek: 3 },
      "2026-12-01",
    );
    expect(values.usualWorkDays).toEqual([1, 3, 5]);
    expect(values.contractWorkDays).toBe(3);
  });
});

describe("buildSchedulePayload", () => {
  it("FIXED_SCHEDULE sends the day hours and their sum as weeklyHours (#848), workDays and no count", () => {
    const body = buildSchedulePayload(contractValuesOf(FIXED, "2026-12-01"));
    expect(body).toMatchObject({
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      monthlyHours: null,
      mondayHours: 8,
      saturdayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      overtimeMode: "CARRY_FORWARD",
      validFrom: "2026-12-01",
    });
  });

  it("the weekly hours follow an edited day (sum of the days, hundredths)", () => {
    const values = contractValuesOf(FIXED, "2026-12-01");
    values.days.mon = 6.5;
    values.days.sat = 2;
    expect(buildSchedulePayload(values).weeklyHours).toBe(40.5);
  });

  it("SHIFT_BASED never sends workDays, sends the contract count and the sorted Angabe", () => {
    const values = contractValuesOf(
      { ...FIXED, type: "SHIFT_BASED", contractWorkDaysPerWeek: 4, weeklyHours: "32" },
      "2026-12-01",
    );
    values.usualWorkDays = [5, 1, 1, 3, 2];
    const body = buildSchedulePayload(values);
    expect(body).not.toHaveProperty("workDays");
    expect(body).toMatchObject({
      type: "SHIFT_BASED",
      weeklyHours: 32,
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [1, 2, 3, 5],
      overtimeMode: "CARRY_FORWARD",
    });
  });

  it("MONTHLY_HOURS sends 1/0 day flags, the stored mode and no weekly hours", () => {
    const values = contractValuesOf(
      { ...FIXED, type: "MONTHLY_HOURS", monthlyHours: "20", overtimeMode: "TRACK_ONLY" },
      "2026-12-01",
    );
    values.monthlyWorkDays = [2, 4];
    const body = buildSchedulePayload(values);
    expect(body).toMatchObject({
      type: "MONTHLY_HOURS",
      weeklyHours: null,
      monthlyHours: 20,
      mondayHours: 0,
      tuesdayHours: 1,
      thursdayHours: 1,
      sundayHours: 0,
      overtimeMode: "TRACK_ONLY",
    });
  });

  it("FLEXTIME sends the core time and days; a blank core time is null", () => {
    const values = contractValuesOf(
      { ...FIXED, type: "FLEXTIME", weeklyHours: "30" },
      "2026-12-01",
    );
    values.coreStart = "09:00";
    values.coreDays = [2, 3];
    expect(buildSchedulePayload(values)).toMatchObject({
      type: "FLEXTIME",
      weeklyHours: 30,
      coreStart: "09:00",
      coreEnd: null,
      coreDays: [2, 3],
    });
  });

  it("carries the pending-shift choice through", () => {
    const body = buildSchedulePayload(contractValuesOf(FIXED, "2026-12-01"), {
      cancelOrphanShifts: true,
    });
    expect(body).toMatchObject({ cancelOrphanShifts: true });
    expect(body).not.toHaveProperty("keepOrphanShifts");
  });
});

describe("contractErrors", () => {
  it("is empty for a stored FIXED_SCHEDULE with a month-first start", () => {
    expect(contractErrors(contractValuesOf(FIXED, "2026-12-01"))).toEqual({});
  });

  it("names a start that is not a month-first and an empty start", () => {
    const values = contractValuesOf(FIXED, "2026-12-01");
    values.validFrom = "2026-12-15";
    expect(contractErrors(values).validFrom).toMatch(/Monatsersten/);
    values.validFrom = null;
    expect(contractErrors(values).validFrom).toMatch(/Wähle/);
  });

  it("flags an invalid day of a FIXED_SCHEDULE", () => {
    const values = contractValuesOf(FIXED, "2026-12-01");
    values.days.tue = 25;
    expect(contractErrors(values).days).toMatch(/0 bis 24/);
    values.days.tue = null;
    expect(contractErrors(values).days).toBeDefined();
  });

  it("requires the Angabe for SHIFT_BASED and enough days for the contract count (#481)", () => {
    const values = contractValuesOf(
      { ...FIXED, type: "SHIFT_BASED", weeklyHours: "32", contractWorkDaysPerWeek: 4 },
      "2026-12-01",
    );
    expect(contractErrors(values).usualWorkDays).toMatch(/Pflicht/);
    values.usualWorkDays = [1, 2];
    expect(contractErrors(values).usualWorkDays).toMatch(/mindestens 4 Tage/);
    values.usualWorkDays = [1, 2, 3, 4];
    expect(contractErrors(values).usualWorkDays).toBeUndefined();
  });

  it("bounds the hours like the API: weekly 0-60, monthly 0-999, threshold 0-500", () => {
    const flex = contractValuesOf({ ...FIXED, type: "FLEXTIME", weeklyHours: "61" }, "2026-12-01");
    expect(contractErrors(flex).weeklyHours).toBeDefined();
    const monthly = contractValuesOf(
      { ...FIXED, type: "MONTHLY_HOURS", monthlyHours: "1000" },
      "2026-12-01",
    );
    expect(contractErrors(monthly).monthlyHours).toBeDefined();
    const threshold = contractValuesOf(FIXED, "2026-12-01");
    threshold.overtimeThreshold = 501;
    expect(contractErrors(threshold).overtimeThreshold).toBeDefined();
  });

  it("empty monthly hours are fine (pure time tracking)", () => {
    const values = contractValuesOf({ ...FIXED, type: "MONTHLY_HOURS" }, "2026-12-01");
    values.monthlyHours = null;
    expect(contractErrors(values).monthlyHours).toBeUndefined();
  });
});

describe("helpers", () => {
  it("plannedWeeklyHours: the day sum for FIXED, the target otherwise, none for monthly hours", () => {
    expect(plannedWeeklyHours(contractValuesOf(FIXED, "2026-12-01"))).toBe(40);
    expect(
      plannedWeeklyHours(contractValuesOf({ ...FIXED, type: "FLEXTIME", weeklyHours: "20" }, null)),
    ).toBe(20);
    expect(
      plannedWeeklyHours(contractValuesOf({ ...FIXED, type: "MONTHLY_HOURS" }, null)),
    ).toBeNull();
  });

  it("germanDay words an ISO day and leaves anything else unchanged", () => {
    expect(germanDay("2026-12-01")).toBe("01.12.2026");
    expect(germanDay("2026-12-01T00:00:00.000Z")).toBe("01.12.2026");
    expect(germanDay(null)).toBe("");
  });

  it("CONTRACT_KEYS covers every field of the values (a new field must be counted)", () => {
    const keys = Object.keys(contractValuesOf(FIXED, "2026-12-01")).sort();
    expect([...CONTRACT_KEYS].sort()).toEqual(keys);
  });
});
