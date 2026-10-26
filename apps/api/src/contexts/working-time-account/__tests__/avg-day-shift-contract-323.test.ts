import { describe, it, expect } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { calcExpectedMinutesTz, calcLeaveAbsenceMinutesTz } from "../timezone";
import { contractWorkDaysPerWeekFrom } from "../../absence";

/**
 * Issue #323: the SHIFT_BASED Ø-day divisor comes from `contractWorkDaysPerWeek`, not from workDays.
 * Week 2026-06-01 (Mon) .. 2026-06-07 (Sun), Europe/Berlin.
 */
const TZ = "Europe/Berlin";
const start = (ymd: string) => fromZonedTime(new Date(`${ymd}T00:00:00`), TZ);
const end = (ymd: string) => fromZonedTime(new Date(`${ymd}T23:59:59.999`), TZ);

// 40 h, workDays names Mon-Fri (5) while the contract says 4 days.
const four: Record<string, unknown> = {
  type: "SHIFT_BASED",
  weeklyHours: 40,
  workDays: [1, 2, 3, 4, 5],
  contractWorkDaysPerWeek: 4,
};

describe("avgWorkMinutesCore SHIFT_BASED divisor (#323)", () => {
  it("one Ø-day is weeklyHours / contractWorkDaysPerWeek (600 min, not 480)", () => {
    // Red on old code: 480 (40h / workDays.length 5).
    expect(calcLeaveAbsenceMinutesTz(four, start("2026-06-02"), end("2026-06-02"), TZ)).toBe(600);
  });

  it("a full week still sums to weeklyHours", () => {
    expect(calcExpectedMinutesTz(four, start("2026-06-01"), end("2026-06-07"), TZ)).toBe(2400);
  });

  it("workDays naming fewer days than the contract does not shrink the Ø-day or the week", () => {
    const three = { ...four, workDays: [1, 2, 3], contractWorkDaysPerWeek: 4 };
    expect(calcLeaveAbsenceMinutesTz(three, start("2026-06-02"), end("2026-06-02"), TZ)).toBe(600);
    expect(calcExpectedMinutesTz(three, start("2026-06-01"), end("2026-06-07"), TZ)).toBe(2400);
  });

  it("agreeing count and workDays stay on the legacy path", () => {
    const same = { ...four, contractWorkDaysPerWeek: 5 };
    expect(calcLeaveAbsenceMinutesTz(same, start("2026-06-02"), end("2026-06-02"), TZ)).toBe(480);
    expect(calcExpectedMinutesTz(same, start("2026-06-01"), end("2026-06-07"), TZ)).toBe(2400);
  });

  it("a null count keeps the legacy workDays divisor", () => {
    const legacy = { ...four, contractWorkDaysPerWeek: null };
    expect(calcLeaveAbsenceMinutesTz(legacy, start("2026-06-02"), end("2026-06-02"), TZ)).toBe(480);
  });

  it("the stored count equals what the one chain function resolves", () => {
    expect(
      contractWorkDaysPerWeekFrom({ contractWorkDaysPerWeek: 4, workDays: [1, 2, 3, 4, 5] }),
    ).toBe(4);
  });

  it("FLEXTIME ignores the column", () => {
    const flex = { ...four, type: "FLEXTIME" };
    expect(calcLeaveAbsenceMinutesTz(flex, start("2026-06-02"), end("2026-06-02"), TZ)).toBe(480);
  });
});
