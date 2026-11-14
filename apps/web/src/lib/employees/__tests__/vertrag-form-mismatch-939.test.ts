// Issue #939 - a stored FIXED_SCHEDULE row whose weeklyHours / workDays contradict its day hours
// (pre-#848 data) is recognised and named, never corrected.
import { describe, expect, it } from "vitest";
import {
  storedContractMismatch,
  storedContractMismatchText,
  type ContractSchedule,
} from "$lib/employees/vertrag-form";

const BASE: ContractSchedule = {
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
  validFrom: "2026-11-01T00:00:00.000Z",
  workDays: [1, 2, 3, 4, 5],
};

describe("storedContractMismatch", () => {
  it("is null for a consistent row", () => {
    expect(storedContractMismatch(BASE)).toBeNull();
  });

  it("names both halves of the 32 h Di–Fr row whose day hours say Mo–Fr 8 h", () => {
    const m = storedContractMismatch({ ...BASE, weeklyHours: "32.00", workDays: [2, 3, 4, 5] });
    expect(m).toEqual({
      weeklyHours: 32,
      dayHoursSum: 40,
      workDays: [2, 3, 4, 5],
      dayHourDays: [1, 2, 3, 4, 5],
    });
    expect(storedContractMismatchText(m!)).toEqual({
      stored: "Gespeichert sind 32:00 h pro Woche an Di, Mi, Do, Fr.",
      dayHours: "Die Stunden je Tag ergeben 40:00 h pro Woche an Mo, Di, Mi, Do, Fr.",
    });
  });

  it("flags a workday set alone, and a weekly sum alone", () => {
    expect(storedContractMismatch({ ...BASE, workDays: [1, 2, 3, 4] })).not.toBeNull();
    expect(storedContractMismatch({ ...BASE, weeklyHours: "39.99" })).not.toBeNull();
  });

  it("compares in hundredths and reads the week Mo ... So", () => {
    expect(
      storedContractMismatch({
        ...BASE,
        weeklyHours: 32,
        mondayHours: 0,
        tuesdayHours: "10.66",
        wednesdayHours: "10.66",
        thursdayHours: "10.68",
        fridayHours: 0,
        workDays: [4, 2, 3],
      }),
    ).toBeNull();
    const m = storedContractMismatch({
      ...BASE,
      sundayHours: "4.00",
      workDays: [0, 1, 2, 3, 4, 5],
    });
    expect(m?.dayHourDays).toEqual([1, 2, 3, 4, 5, 0]);
    expect(m?.workDays).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it("ignores an empty stored workday set and every other model", () => {
    expect(storedContractMismatch({ ...BASE, workDays: [] })).toBeNull();
    expect(
      storedContractMismatch({
        ...BASE,
        type: "FLEXTIME",
        weeklyHours: "32",
        workDays: [2, 3, 4, 5],
      }),
    ).toBeNull();
    expect(storedContractMismatch(null)).toBeNull();
  });
});
