/**
 * Issue #609 (D-03, D-04, D-07; P-609-03 .. P-609-05) - the pure kernel of the shift reminders.
 *
 * No database, no clock: every instant is built from an explicit tenant-local date and time. The DST
 * days are Sunday 2026-10-25 (fall back) and Sunday 2027-03-28 (spring forward).
 */
import { describe, it, expect } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import {
  START_LOOKBACK_MINUTES,
  clampReminderOffset,
  decideShiftStart,
  formatShiftTime,
  parseDayCloseTime,
  shiftInstants,
  shiftReminderKey,
  windowContains,
  type ReminderEntry,
} from "../shift-reminders";

const TZ = "Europe/Berlin";
const at = (day: string, hhmm: string) => fromZonedTime(`${day}T${hhmm}:00`, TZ);
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);
const shift = (day: string, startTime: string, endTime: string) => ({
  date: dateOf(day),
  startTime,
  endTime,
});
const iso = (d: Date) => d.toISOString();

describe("shiftInstants (D-03, P-609-03)", () => {
  it("builds a plain day shift in the tenant time zone", () => {
    const i = shiftInstants(shift("2026-11-10", "09:00", "17:00"), TZ);
    expect(i.day).toBe("2026-11-10");
    expect(iso(i.startUtc)).toBe("2026-11-10T08:00:00.000Z");
    expect(iso(i.endUtc)).toBe("2026-11-10T16:00:00.000Z");
  });

  it("lets an overnight shift end on the next calendar day", () => {
    const i = shiftInstants(shift("2026-11-10", "22:00", "06:00"), TZ);
    expect(iso(i.startUtc)).toBe("2026-11-10T21:00:00.000Z");
    expect(iso(i.endUtc)).toBe("2026-11-11T05:00:00.000Z");
  });

  it("reads the wall clock after the spring-forward change (2027-03-28 09:00 is CEST)", () => {
    const i = shiftInstants(shift("2027-03-28", "09:00", "17:00"), TZ);
    expect(iso(i.startUtc)).toBe("2027-03-28T07:00:00.000Z");
  });

  it("an overnight shift across spring forward lasts seven hours", () => {
    const i = shiftInstants(shift("2027-03-27", "22:00", "06:00"), TZ);
    expect(iso(i.endUtc)).toBe("2027-03-28T04:00:00.000Z");
    expect((i.endUtc.getTime() - i.startUtc.getTime()) / 3_600_000).toBe(7);
  });

  it("reads the wall clock after the fall-back change (2026-10-25 09:00 is CET)", () => {
    const i = shiftInstants(shift("2026-10-25", "09:00", "17:00"), TZ);
    expect(iso(i.startUtc)).toBe("2026-10-25T08:00:00.000Z");
  });

  it("an overnight shift across fall back lasts nine hours", () => {
    const i = shiftInstants(shift("2026-10-24", "22:00", "06:00"), TZ);
    expect(iso(i.endUtc)).toBe("2026-10-25T05:00:00.000Z");
    expect((i.endUtc.getTime() - i.startUtc.getTime()) / 3_600_000).toBe(9);
  });

  it("yields a valid instant for a start inside the skipped hour of 2027-03-28 and does not throw", () => {
    const i = shiftInstants(shift("2027-03-28", "02:30", "10:00"), TZ);
    expect(Number.isNaN(i.startUtc.getTime())).toBe(false);
  });

  it("marks an unreadable time as an invalid instant instead of throwing", () => {
    const i = shiftInstants(shift("2026-11-10", "soon", "17:00"), TZ);
    expect(Number.isNaN(i.startUtc.getTime())).toBe(true);
  });
});

describe("clampReminderOffset and parseDayCloseTime (D-01)", () => {
  it.each([
    [4, 5],
    [5, 5],
    [15, 15],
    [120, 120],
    [121, 120],
    [-10, 5],
  ])("clamps %i minutes to %i", (input, expected) => {
    expect(clampReminderOffset(input)).toBe(expected);
  });

  it("falls back to 15 for a missing or non-finite offset", () => {
    expect(clampReminderOffset(null)).toBe(15);
    expect(clampReminderOffset(undefined)).toBe(15);
    expect(clampReminderOffset(Number.NaN)).toBe(15);
  });

  it.each(["20:00", "00:00", "23:59", "07:05"])("keeps the valid evening time %s", (value) => {
    expect(parseDayCloseTime(value)).toBe(value);
  });

  it.each(["24:00", "7:5", "", "20:60", "abc", null, undefined])(
    "falls back to 20:00 for %s",
    (value) => {
      expect(parseDayCloseTime(value as string | null | undefined)).toBe("20:00");
    },
  );
});

describe("windowContains (D-04)", () => {
  const from = at("2026-11-10", "09:15");

  it("is inclusive at the start and exclusive at the end", () => {
    expect(windowContains(from, 60, at("2026-11-10", "09:14"))).toBe(false);
    expect(windowContains(from, 60, at("2026-11-10", "09:15"))).toBe(true);
    expect(windowContains(from, 60, at("2026-11-10", "10:14"))).toBe(true);
    expect(windowContains(from, 60, at("2026-11-10", "10:15"))).toBe(false);
  });

  it("is false for an invalid instant", () => {
    expect(windowContains(new Date(Number.NaN), 60, from)).toBe(false);
  });
});

describe("formatShiftTime and shiftReminderKey", () => {
  it.each([
    ["09:00", "9:00"],
    ["13:30", "13:30"],
    ["00:05", "0:05"],
    ["9:00", "9:00"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatShiftTime(input)).toBe(expected);
  });

  it("keys a notice by person, type and shift", () => {
    expect(shiftReminderKey("u1", "REMINDER_SHIFT_START", "s1")).toBe(
      "u1|REMINDER_SHIFT_START|Shift|s1",
    );
  });
});

describe("decideShiftStart (AC-1, D-04, D-07)", () => {
  const startUtc = at("2026-11-10", "09:00");
  const now = at("2026-11-10", "09:15");
  const base = { startUtc, offsetMinutes: 15, now };
  const entry = (start: Date, end: Date | null, isInvalid = false): ReminderEntry => ({
    startTime: start,
    endTime: end,
    isInvalid,
  });
  const minutesBefore = (m: number) => new Date(startUtc.getTime() - m * 60_000);

  it("sends when the person has no entry", () => {
    expect(decideShiftStart({ ...base, entries: [] })).toEqual({ send: true });
  });

  it("does not send before the offset has passed or after the window", () => {
    const early = decideShiftStart({ ...base, now: at("2026-11-10", "09:14"), entries: [] });
    const late = decideShiftStart({ ...base, now: at("2026-11-10", "10:15"), entries: [] });
    expect(early).toEqual({ send: false, reason: "OUTSIDE_WINDOW" });
    expect(late).toEqual({ send: false, reason: "OUTSIDE_WINDOW" });
  });

  it("does not send while a valid open entry exists", () => {
    const entries = [entry(at("2026-11-10", "08:58"), null)];
    expect(decideShiftStart({ ...base, entries })).toEqual({ send: false, reason: "CLOCKED_IN" });
  });

  it("an open entry of an earlier shift also suppresses the start of an adjacent shift (D-07)", () => {
    const entries = [entry(at("2026-11-10", "05:00"), null)];
    expect(decideShiftStart({ ...base, entries })).toEqual({ send: false, reason: "CLOCKED_IN" });
  });

  it("ignores an invalid open entry", () => {
    const entries = [entry(at("2026-11-10", "08:58"), null, true)];
    expect(decideShiftStart({ ...base, entries })).toEqual({ send: true });
  });

  it("does not send when a valid entry started within the two hours before the shift", () => {
    const entries = [entry(minutesBefore(90), minutesBefore(60))];
    expect(decideShiftStart({ ...base, entries })).toEqual({
      send: false,
      reason: "ENTRY_STARTED",
    });
  });

  it("counts the exact look-back bound as started", () => {
    const entries = [entry(minutesBefore(START_LOOKBACK_MINUTES), minutesBefore(100))];
    expect(decideShiftStart({ ...base, entries }).send).toBe(false);
  });

  it("sends when the only entry started more than two hours before the shift", () => {
    const entries = [entry(minutesBefore(121), minutesBefore(100))];
    expect(decideShiftStart({ ...base, entries })).toEqual({ send: true });
  });

  it("sends when the only entry starts after now (not yet happened)", () => {
    const entries = [entry(at("2026-11-10", "09:30"), at("2026-11-10", "10:00"))];
    expect(decideShiftStart({ ...base, entries })).toEqual({ send: true });
  });

  it("ignores an invalid closed entry that would otherwise count as started", () => {
    const entries = [entry(minutesBefore(30), minutesBefore(10), true)];
    expect(decideShiftStart({ ...base, entries })).toEqual({ send: true });
  });
});
