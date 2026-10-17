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
      // Table-driven equivalence with the primitives called by the team-week recipe.
      expect(result).toEqual(recipe(c.input));
    });
  }

  it("covers a non-empty case table", () => {
    expect(CASES.length).toBeGreaterThan(10);
  });
});
