import { describe, it, expect } from "vitest";
import { contractWorkDaysPerWeekFrom } from "../leave-days";

describe("contractWorkDaysPerWeekFrom (Issue #429, D-03)", () => {
  it("uses schedule.contractWorkDaysPerWeek when set, regardless of workDays or tenant default", () => {
    const schedule = { contractWorkDaysPerWeek: 4, workDays: [1, 2, 3, 4, 5, 6] };
    expect(contractWorkDaysPerWeekFrom(schedule, [1, 2, 3])).toBe(4);
  });

  it("falls back to workDays.length when contractWorkDaysPerWeek is null", () => {
    const schedule = { contractWorkDaysPerWeek: null, workDays: [1, 2, 3, 4, 5] };
    expect(contractWorkDaysPerWeekFrom(schedule, [1, 2, 3, 4])).toBe(5);
  });

  it("falls back to tenantDefaultWorkDays.length when contractWorkDaysPerWeek is null and workDays is empty", () => {
    const schedule = { contractWorkDaysPerWeek: null, workDays: [] };
    expect(contractWorkDaysPerWeekFrom(schedule, [1, 2, 3, 4])).toBe(4);
  });

  it("falls back to 5 when contractWorkDaysPerWeek, workDays and tenantDefaultWorkDays are all absent/empty", () => {
    const schedule = { contractWorkDaysPerWeek: null, workDays: [] };
    expect(contractWorkDaysPerWeekFrom(schedule, [])).toBe(5);
  });

  it("with schedule null, falls back to tenantDefaultWorkDays.length", () => {
    expect(contractWorkDaysPerWeekFrom(null, [1, 2, 3])).toBe(3);
  });

  it("with schedule null and no tenant default, falls back to 5", () => {
    expect(contractWorkDaysPerWeekFrom(null, null)).toBe(5);
    expect(contractWorkDaysPerWeekFrom(null, undefined)).toBe(5);
  });
});
