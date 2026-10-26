/**
 * Issue #587 (D-587-1) — `resolveDayStatus`, the one place a person's day status is resolved.
 *
 * Pure unit test: no database, no clock. Every case also asserts equality with the three presence
 * primitives called with the team-week argument recipe, so the kernel cannot drift from the
 * definition it wraps (`presence.ts`).
 */
import { describe, it, expect } from "vitest";
import {
  resolveDayStatus,
  resolvePresenceState,
  isObligatedWorkday,
  isDayDue,
  type DayStatusInput,
} from "..";

const WED = "2026-06-17";
const MON = "2026-06-15";
const FRI = "2026-06-19";

function input(overrides: Partial<DayStatusInput> = {}): DayStatusInput {
  return {
    dayStr: WED,
    todayStr: WED,
    nowHHMM: "12:00",
    employedOnDay: true,
    scheduleType: "FIXED_SCHEDULE",
    workDays: [1, 2, 3, 4, 5],
    dow: 3,
    expectedHours: 8,
    shift: null,
    entries: [],
    leave: null,
    absence: null,
    holidayName: null,
    entryOnlyRow: false,
    ...overrides,
  };
}

/** The team-week recipe, written out independently of the kernel under test. */
function recipe(i: DayStatusInput) {
  const hasShift = i.shift !== null;
  const isWorkday =
    i.employedOnDay &&
    isObligatedWorkday({
      scheduleType: i.scheduleType,
      workDays: i.workDays,
      dow: i.dow,
      expectedHours: i.expectedHours,
      hasShift,
    });
  const isDue = isDayDue({
    dayStr: i.dayStr,
    todayStr: i.todayStr,
    nowHHMM: i.nowHHMM,
    shiftStartTime: i.shift?.startTime ?? null,
  });
  const { status, reason } = resolvePresenceState({
    entries: i.entries,
    leave: i.leave,
    absence: i.absence,
    isWorkday,
    isFuture: !isDue,
    hasShift: i.entryOnlyRow ? hasShift && !isDue : hasShift,
    isHoliday: i.holidayName !== null,
    holidayName: i.holidayName,
  });
  return { status, reason, isWorkday, isDue };
}

const CLOSED = { endTime: new Date("2026-06-17T08:00:00Z"), isInvalid: false };
const OPEN = { endTime: null, isInvalid: false };
const INVALID_CLOSED = { endTime: new Date("2026-06-17T08:00:00Z"), isInvalid: true };

type Case = { name: string; input: DayStatusInput; expected: Partial<ReturnType<typeof recipe>> };

const CASES: Case[] = [
  {
    name: "FIXED weekday today at 12:00 without a shift is not yet due: scheduled",
    input: input(),
    expected: { status: "scheduled", isWorkday: true, isDue: false },
  },
  {
    name: "FIXED weekday today with a shift that started at 09:00: missing",
    input: input({ shift: { startTime: "09:00" } }),
    expected: { status: "missing", isWorkday: true, isDue: true },
  },
  {
    name: "FIXED weekday today with a shift at 14:00 that has not started: scheduled",
    input: input({ shift: { startTime: "14:00" } }),
    expected: { status: "scheduled", isWorkday: true, isDue: false },
  },
  {
    name: "SHIFT_BASED without a shift: none, not a workday",
    input: input({ scheduleType: "SHIFT_BASED" }),
    expected: { status: "none", isWorkday: false },
  },
  {
    name: "SHIFT_BASED with a started shift: missing",
    input: input({ scheduleType: "SHIFT_BASED", shift: { startTime: "09:00" } }),
    expected: { status: "missing", isWorkday: true, isDue: true },
  },
  {
    name: "FLEXTIME without a shift: none",
    input: input({ scheduleType: "FLEXTIME" }),
    expected: { status: "none", isWorkday: false },
  },
  {
    name: "MONTHLY_HOURS without a shift: none",
    input: input({ scheduleType: "MONTHLY_HOURS" }),
    expected: { status: "none", isWorkday: false },
  },
  {
    name: "past FIXED weekday without entries: missing",
    input: input({ dayStr: MON, dow: 1 }),
    expected: { status: "missing", isWorkday: true, isDue: true },
  },
  {
    name: "future FIXED weekday: scheduled",
    input: input({ dayStr: FRI, dow: 5 }),
    expected: { status: "scheduled", isWorkday: true, isDue: false },
  },
  {
    name: "not employed on the day: never a workday, so never missing from the contract",
    input: input({ dayStr: MON, dow: 1, employedOnDay: false }),
    expected: { status: "none", isWorkday: false },
  },
  {
    name: "not employed on the day with a past shift: the shift alone keeps the pre-587 outcome",
    input: input({ dayStr: MON, dow: 1, employedOnDay: false, shift: { startTime: "09:00" } }),
    expected: { status: "missing", isWorkday: false },
  },
  {
    name: "entry-only row (no contract of its own) with a due shift is never missing",
    input: input({
      entryOnlyRow: true,
      scheduleType: null,
      workDays: [],
      expectedHours: 0,
      shift: { startTime: "09:00" },
    }),
    expected: { status: "none", isDue: true },
  },
  {
    name: "entry-only row with a shift that is not yet due reads scheduled",
    input: input({
      entryOnlyRow: true,
      scheduleType: null,
      workDays: [],
      expectedHours: 0,
      shift: { startTime: "14:00" },
    }),
    expected: { status: "scheduled", isDue: false },
  },
  {
    name: "PENDING leave: requested with the leave type in the reason",
    input: input({ leave: { status: "PENDING", leaveTypeName: "Urlaub" } }),
    expected: { status: "requested", reason: "Antrag: Urlaub" },
  },
  {
    name: "APPROVED leave: absent with the leave type name",
    input: input({ leave: { status: "APPROVED", leaveTypeName: "Urlaub" } }),
    expected: { status: "absent", reason: "Urlaub" },
  },
  {
    name: "holiday: holiday with its name",
    input: input({ holidayName: "Hausfeiertag" }),
    expected: { status: "holiday", reason: "Hausfeiertag" },
  },
  {
    name: "a valid open entry: clocked_in",
    input: input({ entries: [OPEN] }),
    expected: { status: "clocked_in" },
  },
  {
    name: "a valid closed entry: present",
    input: input({ entries: [CLOSED] }),
    expected: { status: "present" },
  },
  {
    name: "an invalid entry is ignored",
    input: input({ entries: [INVALID_CLOSED], dayStr: MON, dow: 1 }),
    expected: { status: "missing" },
  },
];

describe("resolveDayStatus (Issue #587)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const result = resolveDayStatus(c.input);
      expect(result).toMatchObject(c.expected);
      // Table-driven equivalence with the primitives called by the team-week recipe (the expected
      // start and lateness are additive values proven in their own table below).
      const { expectedStart: _start, lateMinutes: _late, ...state } = result;
      void _start;
      void _late;
      expect(state).toEqual(recipe(c.input));
    });
  }

  it("covers a non-empty case table", () => {
    expect(CASES.length).toBeGreaterThan(10);
  });
});

// ── Expected start and lateness (Issue #587, D-587-3, P-05) ─────────────────────────────────────
type TimeCase = {
  name: string;
  input: DayStatusInput;
  expected: { status: string; expectedStart: string | null; lateMinutes: number | null };
};

const TIME_CASES: TimeCase[] = [
  {
    name: "missing today with a shift at 09:00, now 12:00: 180 minutes late",
    input: input({ shift: { startTime: "09:00" } }),
    expected: { status: "missing", expectedStart: "09:00", lateMinutes: 180 },
  },
  {
    name: "due exactly at the shift start: 0 minutes late",
    input: input({ shift: { startTime: "09:00" }, nowHHMM: "09:00" }),
    expected: { status: "missing", expectedStart: "09:00", lateMinutes: 0 },
  },
  {
    name: "minutes are whole minutes on the wall clock",
    input: input({ shift: { startTime: "08:30" }, nowHHMM: "09:05" }),
    expected: { status: "missing", expectedStart: "08:30", lateMinutes: 35 },
  },
  {
    name: "scheduled today with a shift at 14:00 names the start and is not late",
    input: input({ shift: { startTime: "14:00" } }),
    expected: { status: "scheduled", expectedStart: "14:00", lateMinutes: null },
  },
  {
    name: "missing on a past day with a shift: the start is named, a past day is missed not late",
    input: input({ dayStr: MON, dow: 1, shift: { startTime: "09:00" } }),
    expected: { status: "missing", expectedStart: "09:00", lateMinutes: null },
  },
  {
    name: "FIXED_SCHEDULE without a shift: no start invented",
    input: input(),
    expected: { status: "scheduled", expectedStart: null, lateMinutes: null },
  },
  {
    name: "FIXED_SCHEDULE without a shift on a past day: missing, no start, no lateness",
    input: input({ dayStr: MON, dow: 1 }),
    expected: { status: "missing", expectedStart: null, lateMinutes: null },
  },
  {
    name: "FLEXTIME without a shift: both null",
    input: input({ scheduleType: "FLEXTIME" }),
    expected: { status: "none", expectedStart: null, lateMinutes: null },
  },
  {
    name: "MONTHLY_HOURS without a shift: both null",
    input: input({ scheduleType: "MONTHLY_HOURS" }),
    expected: { status: "none", expectedStart: null, lateMinutes: null },
  },
  {
    name: "present with a shift: start named, never late",
    input: input({ shift: { startTime: "09:00" }, entries: [CLOSED] }),
    expected: { status: "present", expectedStart: "09:00", lateMinutes: null },
  },
  {
    name: "clocked in with a shift: start named, never late",
    input: input({ shift: { startTime: "09:00" }, entries: [OPEN] }),
    expected: { status: "clocked_in", expectedStart: "09:00", lateMinutes: null },
  },
  {
    name: "entry-only row with a due shift is never missing, so never late",
    input: input({
      entryOnlyRow: true,
      scheduleType: null,
      workDays: [],
      expectedHours: 0,
      shift: { startTime: "09:00" },
    }),
    expected: { status: "none", expectedStart: "09:00", lateMinutes: null },
  },
];

describe("resolveDayStatus expected start and lateness (Issue #587)", () => {
  for (const c of TIME_CASES) {
    it(c.name, () => {
      const result = resolveDayStatus(c.input);
      expect(result.status).toBe(c.expected.status);
      expect(result.expectedStart).toBe(c.expected.expectedStart);
      expect(result.lateMinutes).toBe(c.expected.lateMinutes);
    });
  }

  it("covers a non-empty case table", () => {
    expect(TIME_CASES.length).toBeGreaterThan(5);
  });
});

// ── Half-day leave (Issue #743) ─────────────────────────────────────────────────────────────────
describe("resolveDayStatus half-day leave (Issue #743)", () => {
  const half = (status: "APPROVED" | "CANCELLATION_REQUESTED" | "PENDING" = "APPROVED") => ({
    status,
    leaveTypeName: "Urlaub",
    halfDay: true,
  });
  const past = { dayStr: MON, dow: 1, todayStr: WED };

  it("past workday, no entry: missing, the leave type stays in the reason", () => {
    expect(resolveDayStatus(input({ ...past, leave: half() }))).toMatchObject({
      status: "missing",
      reason: "Urlaub",
    });
    expect(resolveDayStatus(input({ ...past, leave: half("CANCELLATION_REQUESTED") })).status).toBe(
      "missing",
    );
  });
  it("today (even with a started shift): still absent", () => {
    expect(resolveDayStatus(input({ leave: half() })).status).toBe("absent");
    expect(resolveDayStatus(input({ leave: half(), shift: { startTime: "09:00" } })).status).toBe(
      "absent",
    );
  });
  it("with a valid entry: present", () => {
    expect(resolveDayStatus(input({ ...past, leave: half(), entries: [CLOSED] })).status).toBe(
      "present",
    );
  });
  it("full day stays absent; pending stays requested; holiday and non-workday are not owed", () => {
    expect(
      resolveDayStatus(input({ ...past, leave: { status: "APPROVED", leaveTypeName: "Urlaub" } }))
        .status,
    ).toBe("absent");
    expect(resolveDayStatus(input({ ...past, leave: half("PENDING") })).status).toBe("requested");
    expect(resolveDayStatus(input({ ...past, leave: half(), holidayName: "X" })).status).toBe(
      "absent",
    );
    expect(
      resolveDayStatus(input({ ...past, leave: half(), scheduleType: "FLEXTIME" })).status,
    ).toBe("absent");
  });
});
