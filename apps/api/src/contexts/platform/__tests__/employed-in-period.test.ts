import { describe, it, expect } from "vitest";
import { NOT_ANONYMIZED_EMPLOYEE_WHERE } from "../employee-anonymization-filter";
import {
  employedInPeriodWhere,
  reportPopulationWhere,
  isEmployedInPeriod,
} from "../employed-in-period";

const START = new Date("2026-09-30T22:00:00.000Z");
const END = new Date("2026-10-31T22:59:59.999Z");

describe("employedInPeriodWhere (Issue #613)", () => {
  it("is the #256 predicate: hired by the end, not exited before the start", () => {
    expect(employedInPeriodWhere(START, END)).toEqual({
      hireDate: { lte: END },
      OR: [{ exitDate: null }, { exitDate: { gte: START } }],
    });
  });

  it("never reads a login state", () => {
    const json = JSON.stringify(employedInPeriodWhere(START, END));
    expect(json).not.toContain("isActive");
    expect(json).not.toContain("user");
  });
});

describe("reportPopulationWhere (Issue #613)", () => {
  it("is the employment core AND the anonymisation sentinel, as one single-key AND object", () => {
    expect(reportPopulationWhere(START, END)).toEqual({
      AND: [employedInPeriodWhere(START, END), NOT_ANONYMIZED_EMPLOYEE_WHERE],
    });
  });

  it("never reads a login state", () => {
    const json = JSON.stringify(reportPopulationWhere(START, END));
    expect(json).not.toContain("isActive");
    expect(json).not.toContain('"user"');
  });
});

describe("isEmployedInPeriod (Issue #613)", () => {
  const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

  it("includes a hire on the end instant and excludes one a millisecond later", () => {
    expect(isEmployedInPeriod({ hireDate: END, exitDate: null }, START, END)).toBe(true);
    expect(isEmployedInPeriod({ hireDate: ms(END, 1), exitDate: null }, START, END)).toBe(false);
  });

  it("includes an exit on the start instant and excludes one a millisecond earlier", () => {
    const hireDate = new Date("2025-01-01T00:00:00.000Z");
    expect(isEmployedInPeriod({ hireDate, exitDate: START }, START, END)).toBe(true);
    expect(isEmployedInPeriod({ hireDate, exitDate: ms(START, -1) }, START, END)).toBe(false);
  });

  it("treats a missing exit date as still employed", () => {
    const hireDate = new Date("2025-01-01T00:00:00.000Z");
    expect(isEmployedInPeriod({ hireDate, exitDate: null }, START, END)).toBe(true);
  });
});
