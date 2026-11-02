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
  dayCloseInstant,
  dayCloseLink,
  dayCloseReminderKey,
  decideDayClose,
  decideShiftEnd,
  decideShiftStart,
  exclusionFor,
  formatShiftTime,
  shiftDaysOf,
  shiftInstantKey,
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
    expect(i.endDay).toBe("2026-11-10");
    expect(shiftDaysOf(i)).toEqual(["2026-11-10"]);
  });

  it("lets an overnight shift end on the next calendar day", () => {
    const i = shiftInstants(shift("2026-11-10", "22:00", "06:00"), TZ);
    expect(iso(i.startUtc)).toBe("2026-11-10T21:00:00.000Z");
    expect(iso(i.endUtc)).toBe("2026-11-11T05:00:00.000Z");
    expect(i.endDay).toBe("2026-11-11");
    expect(shiftDaysOf(i)).toEqual(["2026-11-10", "2026-11-11"]);
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
  const base = { startUtc, shiftDays: ["2026-11-10"], offsetMinutes: 15, now };
  const entry = (
    start: Date,
    end: Date | null,
    isInvalid = false,
    day = "2026-11-10",
  ): ReminderEntry => ({
    startTime: start,
    endTime: end,
    isInvalid,
    day,
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

  describe("an open entry of an earlier day is a forgotten clock-out, not 'clocked in' (WR-03)", () => {
    it("does not silence the start reminder", () => {
      const stale = [entry(at("2026-11-09", "09:00"), null, false, "2026-11-09")];
      expect(decideShiftStart({ ...base, entries: stale })).toEqual({ send: true });
    });

    it("an open entry of the shift's own day still silences it", () => {
      const today = [entry(at("2026-11-10", "06:00"), null)];
      expect(decideShiftStart({ ...base, entries: today })).toEqual({
        send: false,
        reason: "CLOCKED_IN",
      });
    });

    it("an early clock-in across midnight (23:30 for a 00:30 shift) still counts", () => {
      const night = {
        startUtc: at("2026-11-10", "00:30"),
        shiftDays: ["2026-11-10"],
        offsetMinutes: 15,
        now: at("2026-11-10", "00:45"),
      };
      const early = [entry(at("2026-11-09", "23:30"), null, false, "2026-11-09")];
      expect(decideShiftStart({ ...night, entries: early })).toEqual({
        send: false,
        reason: "CLOCKED_IN",
      });
    });

    it("an overnight shift counts an open entry of its end day too", () => {
      const overnight = {
        startUtc: at("2026-11-10", "22:00"),
        shiftDays: ["2026-11-10", "2026-11-11"],
        offsetMinutes: 15,
        now: at("2026-11-10", "22:15"),
      };
      const open = [entry(at("2026-11-10", "21:55"), null, false, "2026-11-11")];
      expect(decideShiftStart({ ...overnight, entries: open }).send).toBe(false);
    });
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

describe("decideShiftEnd (AC-2, D-04, D-07, P-609-06)", () => {
  const entry = (
    start: Date,
    end: Date | null,
    isInvalid = false,
    day = "2026-11-10",
  ): ReminderEntry => ({
    startTime: start,
    endTime: end,
    isInvalid,
    day,
  });
  const endUtc = at("2026-11-10", "17:00");
  const N = 15;
  const base = {
    startUtc: at("2026-11-10", "09:00"),
    endUtc,
    shiftDays: ["2026-11-10"],
    offsetMinutes: N,
    now: at("2026-11-10", "17:15"),
  };
  const other = (start: string, end: string, day = "2026-11-10") => ({
    startUtc: at(day, start),
    endUtc: at(day, end),
  });

  it("sends for a valid open entry that started before the shift end", () => {
    const entries = [entry(at("2026-11-10", "08:58"), null)];
    expect(decideShiftEnd({ ...base, entries, otherShifts: [] })).toEqual({ send: true });
  });

  it("does not send outside the window (17:14 and 18:15)", () => {
    const entries = [entry(at("2026-11-10", "08:58"), null)];
    for (const hhmm of ["17:14", "18:15"]) {
      expect(
        decideShiftEnd({ ...base, now: at("2026-11-10", hhmm), entries, otherShifts: [] }),
      ).toEqual({ send: false, reason: "OUTSIDE_WINDOW" });
    }
  });

  it("is due until 18:14 inclusive", () => {
    const entries = [entry(at("2026-11-10", "08:58"), null)];
    const r = decideShiftEnd({ ...base, now: at("2026-11-10", "18:14"), entries, otherShifts: [] });
    expect(r).toEqual({ send: true });
  });

  it("does not send for an open entry opened after the shift end", () => {
    const entries = [entry(at("2026-11-10", "17:05"), null)];
    expect(decideShiftEnd({ ...base, entries, otherShifts: [] })).toEqual({
      send: false,
      reason: "NO_OPEN_ENTRY",
    });
  });

  describe("an open entry of an earlier day does not trigger the end reminder (WR-03)", () => {
    it("sends nothing for a forgotten entry of yesterday", () => {
      const stale = [entry(at("2026-11-09", "09:00"), null, false, "2026-11-09")];
      expect(decideShiftEnd({ ...base, entries: stale, otherShifts: [] })).toEqual({
        send: false,
        reason: "NO_OPEN_ENTRY",
      });
    });

    it("an open entry of the shift's own day still triggers it", () => {
      const today = [entry(at("2026-11-10", "09:02"), null)];
      expect(decideShiftEnd({ ...base, entries: today, otherShifts: [] })).toEqual({ send: true });
    });

    it("an early clock-in across midnight still triggers it", () => {
      const night = shiftInstants(shift("2026-11-10", "00:30", "08:00"), TZ);
      const input = {
        startUtc: night.startUtc,
        endUtc: night.endUtc,
        shiftDays: shiftDaysOf(night),
        offsetMinutes: N,
        now: at("2026-11-10", "08:15"),
        otherShifts: [],
      };
      const early = [entry(at("2026-11-09", "23:30"), null, false, "2026-11-09")];
      expect(decideShiftEnd({ ...input, entries: early })).toEqual({ send: true });
    });
  });

  it("does not send for closed entries only or without entries", () => {
    const closed = [entry(at("2026-11-10", "08:58"), at("2026-11-10", "17:02"))];
    expect(decideShiftEnd({ ...base, entries: closed, otherShifts: [] }).send).toBe(false);
    expect(decideShiftEnd({ ...base, entries: [], otherShifts: [] })).toEqual({
      send: false,
      reason: "NO_OPEN_ENTRY",
    });
  });

  it("ignores an invalid open entry", () => {
    const entries = [entry(at("2026-11-10", "08:58"), null, true)];
    expect(decideShiftEnd({ ...base, entries, otherShifts: [] })).toEqual({
      send: false,
      reason: "NO_OPEN_ENTRY",
    });
  });

  describe("an adjacent shift of the same person (D-07)", () => {
    const entries = [entry(at("2026-11-10", "08:58"), null)];
    it("starting exactly at end + N is adjacent", () => {
      const otherShifts = [other("17:15", "21:00")];
      expect(decideShiftEnd({ ...base, entries, otherShifts })).toEqual({
        send: false,
        reason: "NEXT_SHIFT_ADJACENT",
      });
    });
    it("starting one minute after end + N is not adjacent", () => {
      const otherShifts = [other("17:16", "21:00")];
      expect(decideShiftEnd({ ...base, entries, otherShifts })).toEqual({ send: true });
    });
    it("an overlapping shift (starts before the end, ends after) is adjacent", () => {
      const otherShifts = [other("16:00", "20:00")];
      expect(decideShiftEnd({ ...base, entries, otherShifts }).send).toBe(false);
    });
    it("a shift that ended before this one ended does not count", () => {
      const otherShifts = [other("08:00", "12:00"), other("13:00", "17:00")];
      expect(decideShiftEnd({ ...base, entries, otherShifts })).toEqual({ send: true });
    });
  });

  it("an overnight shift ends on the next calendar day and the DST day keeps the wall clock", () => {
    const night = shiftInstants(shift("2026-10-24", "22:00", "06:00"), TZ);
    const entries = [entry(at("2026-10-24", "21:58"), null, false, "2026-10-24")];
    const input = {
      startUtc: night.startUtc,
      endUtc: night.endUtc,
      shiftDays: shiftDaysOf(night),
      offsetMinutes: N,
      entries,
      otherShifts: [],
    };
    expect(decideShiftEnd({ ...input, now: at("2026-10-25", "06:15") })).toEqual({ send: true });
    // 05:15 local (04:15Z) lies before the shift end 06:00 local (05:00Z): not yet due
    expect(decideShiftEnd({ ...input, now: at("2026-10-25", "05:15") }).send).toBe(false);
  });
});

describe("decideDayClose (AC-3, D-04, D-13, D-15, P-609-07)", () => {
  const day = "2026-11-10";
  const closeUtc = dayCloseInstant(day, "20:00", TZ);
  const now = at(day, "20:00");
  const sh = (end: string, conflictsWithLeave = false) => ({
    endUtc: at(day, end),
    conflictsWithLeave,
  });
  const e = (
    start: Date,
    end: Date | null,
    options: { isInvalid?: boolean; day?: string } = {},
  ): ReminderEntry => ({
    startTime: start,
    endTime: end,
    isInvalid: options.isInvalid ?? false,
    day: options.day ?? day,
  });
  const base = { day, closeUtc, now };

  it("builds the instant of the evening time in the tenant time zone", () => {
    expect(closeUtc.toISOString()).toBe("2026-11-10T19:00:00.000Z");
    expect(dayCloseInstant(day, "garbage", TZ).toISOString()).toBe("2026-11-10T19:00:00.000Z");
  });

  it("sends for one shift that ended by the evening time and no entries", () => {
    expect(decideDayClose({ ...base, shifts: [sh("17:00")], entries: [] })).toEqual({ send: true });
  });

  it("counts a shift ending exactly at the evening time as ended", () => {
    expect(decideDayClose({ ...base, shifts: [sh("20:00")], entries: [] })).toEqual({ send: true });
  });

  it("gives no notice for a shift that ends after the evening time (D-15)", () => {
    expect(decideDayClose({ ...base, shifts: [sh("21:00")], entries: [] })).toEqual({
      send: false,
      reason: "NO_ELIGIBLE_SHIFT",
    });
  });

  it("sends for an early and a late shift when the early one ended by the evening time", () => {
    const shifts = [sh("12:00"), sh("22:00")];
    expect(decideDayClose({ ...base, shifts, entries: [] })).toEqual({ send: true });
  });

  it("does not send while a valid open entry exists (D-13)", () => {
    const entries = [e(at(day, "13:00"), null)];
    expect(decideDayClose({ ...base, shifts: [sh("17:00")], entries })).toEqual({
      send: false,
      reason: "OPEN_ENTRY_PRESENT",
    });
  });

  it("does not send when a closed entry of that day exists, valid or invalid", () => {
    for (const isInvalid of [false, true]) {
      const entries = [e(at(day, "09:00"), at(day, "12:00"), { isInvalid })];
      expect(decideDayClose({ ...base, shifts: [sh("17:00")], entries })).toEqual({
        send: false,
        reason: "HAS_CLOSED_ENTRY",
      });
    }
  });

  it("sends when the only closed entry belongs to the previous day", () => {
    const entries = [
      e(at("2026-11-09", "09:00"), at("2026-11-09", "17:00"), { day: "2026-11-09" }),
    ];
    expect(decideDayClose({ ...base, shifts: [sh("17:00")], entries })).toEqual({ send: true });
  });

  it("ignores an invalid open entry", () => {
    const entries = [e(at(day, "13:00"), null, { isInvalid: true })];
    expect(decideDayClose({ ...base, shifts: [sh("17:00")], entries })).toEqual({ send: true });
  });

  it("gives no notice for a day whose only shift is flagged as conflicting with leave", () => {
    expect(decideDayClose({ ...base, shifts: [sh("17:00", true)], entries: [] })).toEqual({
      send: false,
      reason: "NO_ELIGIBLE_SHIFT",
    });
  });

  it("is due in [evening, evening + 30 min) only", () => {
    const shifts = [sh("17:00")];
    const at2 = (hhmm: string) =>
      decideDayClose({ ...base, now: at(day, hhmm), shifts, entries: [] });
    expect(at2("19:59")).toEqual({ send: false, reason: "OUTSIDE_WINDOW" });
    expect(at2("20:25")).toEqual({ send: true });
    expect(at2("20:29")).toEqual({ send: true });
    expect(at2("20:30")).toEqual({ send: false, reason: "OUTSIDE_WINDOW" });
  });

  it("links to the list view of the day and keys the notice per person and day", () => {
    expect(dayCloseLink("2026-11-10")).toBe("/time-entries?view=list&date=2026-11-10");
    expect(dayCloseReminderKey("u1", "e1", "2026-11-10")).toBe(
      "u1|REMINDER_DAY_CLOSE|EmployeeDay|e1:2026-11-10",
    );
  });
});

describe("exclusionFor (AC-3, D-05, D-12, P-609-08)", () => {
  const day = "2026-11-10";
  const none = { leave: [], absences: [], holidayDays: [], flagged: false };

  it("returns null when nothing applies", () => {
    expect(exclusionFor(day, none)).toBeNull();
  });

  it("names a leave range that contains the day, bounds inclusive", () => {
    expect(exclusionFor(day, { ...none, leave: [{ startDay: day, endDay: day }] })).toBe("LEAVE");
    expect(
      exclusionFor(day, { ...none, leave: [{ startDay: "2026-11-03", endDay: "2026-11-10" }] }),
    ).toBe("LEAVE");
    expect(
      exclusionFor(day, { ...none, leave: [{ startDay: "2026-11-10", endDay: "2026-11-14" }] }),
    ).toBe("LEAVE");
  });

  it("ignores a leave range that ended the day before or starts the day after", () => {
    expect(
      exclusionFor(day, { ...none, leave: [{ startDay: "2026-11-02", endDay: "2026-11-09" }] }),
    ).toBeNull();
    expect(
      exclusionFor(day, { ...none, leave: [{ startDay: "2026-11-11", endDay: "2026-11-12" }] }),
    ).toBeNull();
  });

  it("names an absence, a holiday and a flagged shift", () => {
    expect(exclusionFor(day, { ...none, absences: [{ startDay: day, endDay: day }] })).toBe(
      "ABSENCE",
    );
    expect(exclusionFor(day, { ...none, holidayDays: [day] })).toBe("HOLIDAY");
    expect(exclusionFor(day, { ...none, holidayDays: ["2026-11-11"] })).toBeNull();
    expect(exclusionFor(day, { ...none, flagged: true })).toBe("FLAGGED");
  });
});

describe("the exclusion silences every decision (AC-3)", () => {
  const day = "2026-11-10";
  const N = 15;

  it("silences the start decision inside its window", () => {
    const input = {
      startUtc: at(day, "09:00"),
      shiftDays: [day],
      offsetMinutes: N,
      now: at(day, "09:15"),
      entries: [],
    };
    expect(decideShiftStart(input)).toEqual({ send: true });
    expect(decideShiftStart({ ...input, exclusion: "LEAVE" })).toEqual({
      send: false,
      reason: "LEAVE",
    });
  });

  it("silences the end decision inside its window", () => {
    const input = {
      startUtc: at(day, "09:00"),
      endUtc: at(day, "17:00"),
      shiftDays: [day],
      offsetMinutes: N,
      now: at(day, "17:15"),
      entries: [{ startTime: at(day, "09:00"), endTime: null, isInvalid: false, day }],
      otherShifts: [],
    };
    expect(decideShiftEnd(input)).toEqual({ send: true });
    expect(decideShiftEnd({ ...input, exclusion: "HOLIDAY" })).toEqual({
      send: false,
      reason: "HOLIDAY",
    });
  });

  it("silences the day-close decision, and a second unexcluded shift still sends", () => {
    const closeUtc = dayCloseInstant(day, "20:00", TZ);
    const base = { day, closeUtc, now: at(day, "20:00"), entries: [] };
    const excluded = {
      endUtc: at(day, "17:00"),
      conflictsWithLeave: false,
      exclusion: "ABSENCE" as const,
    };
    const free = { endUtc: at(day, "12:00"), conflictsWithLeave: false };
    expect(decideDayClose({ ...base, shifts: [excluded] })).toEqual({
      send: false,
      reason: "ABSENCE",
    });
    expect(decideDayClose({ ...base, shifts: [excluded, free] })).toEqual({ send: true });
  });

  it("keys a notice by person, occasion and instant", () => {
    expect(shiftInstantKey("u1", "REMINDER_SHIFT_START", at(day, "09:00"))).toBe(
      `u1|REMINDER_SHIFT_START|At|${at(day, "09:00").getTime()}`,
    );
    expect(shiftInstantKey("u1", "REMINDER_SHIFT_START", at(day, "09:00"))).not.toBe(
      shiftInstantKey("u1", "REMINDER_SHIFT_END", at(day, "09:00")),
    );
  });
});
