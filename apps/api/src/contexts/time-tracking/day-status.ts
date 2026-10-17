import {
  isDayDue,
  isObligatedWorkday,
  resolvePresenceState,
  type PresenceAbsence,
  type PresenceEntry,
  type PresenceLeave,
  type PresenceStatus,
} from "./presence";

// ── Day status (Issue #587, D-587-1) ──────────────────────────────────────────
// The ONE place a person's status on one day is resolved. It combines the three presence
// primitives — the obligation (`isObligatedWorkday`), the timing (`isDayDue`) and the state
// (`resolvePresenceState`) — in the order and with the arguments the team week used before, so
// every reader that shows a person-day (the team week, the attendance list) reads the same
// answer for the same inputs.
//
// The definition of a workday is NOT changed here: it stays in `presence.ts`. This module is
// pure — no Prisma, no time-zone library, no clock read. The caller passes tenant-local strings
// (`dayStr`, `todayStr`, `nowHHMM`) and already-resolved facts: entries with stand-ins applied,
// the effective leave (after the Berufsschule displacement), the absence, the holiday name.
// Entry-only rows (Issue #548) and the employment flag (Issue #613, P-02) are inputs, not
// lookups.

export interface DayStatusInput {
  /** The day being resolved, tenant-local "YYYY-MM-DD". */
  dayStr: string;
  /** Today in the tenant time zone, "YYYY-MM-DD". */
  todayStr: string;
  /** The current wall-clock time in the tenant time zone, "HH:MM". */
  nowHHMM: string;
  /** Whether the person is employed on `dayStr` (Issue #613): outside employment a day is never owed. */
  employedOnDay: boolean;
  scheduleType: string | null;
  workDays: number[];
  /** Weekday index of `dayStr` in the tenant time zone (0 = Sunday). */
  dow: number;
  expectedHours: number;
  /** The day's first in-scope shift, or null. */
  shift: { startTime: string } | null;
  /** The presence entries of the day, hidden-time stand-ins already applied. */
  entries: PresenceEntry[];
  /** The effective leave of the day (after the Berufsschule displacement), or null. */
  leave: PresenceLeave | null;
  absence: PresenceAbsence | null;
  holidayName: string | null;
  /** A row listed only by an in-scope entry (Issue #548): never "missing". */
  entryOnlyRow: boolean;
}

export interface DayStatus {
  status: PresenceStatus;
  reason: string | null;
  /** Whether the day is an obligated workday of the person (employment included). */
  isWorkday: boolean;
  /** Whether the day is late enough that an absence on it counts as "missing". */
  isDue: boolean;
  /**
   * The start of the day's first in-scope shift (tenant-local "HH:MM"), or null. No start is
   * invented for a schedule without a shift (Issue #587, D-587-3).
   */
  expectedStart: string | null;
  /**
   * Whole minutes between the shift start and now (tenant-local wall clock), only for a "missing"
   * day that is TODAY and has a shift; null otherwise (a past day is missed, not late).
   */
  lateMinutes: number | null;
}

/** Minutes since midnight of a tenant-local "HH:MM" string. */
function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function resolveDayStatus(input: DayStatusInput): DayStatus {
  const hasShift = input.shift !== null;

  // Issue #613 (P-02): a day outside the employment is never a workday.
  const isWorkday =
    input.employedOnDay &&
    isObligatedWorkday({
      scheduleType: input.scheduleType,
      workDays: input.workDays,
      dow: input.dow,
      expectedHours: input.expectedHours,
      hasShift,
    });

  // "Due" = late enough that an absence counts as "missing": past days always; today only once
  // the shift start has passed (never for a day without a known start time).
  const isDue = isDayDue({
    dayStr: input.dayStr,
    todayStr: input.todayStr,
    nowHHMM: input.nowHHMM,
    shiftStartTime: input.shift?.startTime ?? null,
  });

  const { status, reason } = resolvePresenceState({
    entries: input.entries,
    leave: input.leave,
    absence: input.absence,
    isWorkday,
    isFuture: !isDue,
    // Issue #548: a row listed only by an in-scope entry reads "scheduled" for a shift that is
    // not yet due, and never "missing".
    hasShift: input.entryOnlyRow ? hasShift && !isDue : hasShift,
    isHoliday: input.holidayName !== null,
    holidayName: input.holidayName,
  });

  // Issue #587 (D-587-3, P-05): the expected start is the shift start and nothing else; lateness
  // exists only for a "missing" row of TODAY with a shift, where `isDayDue` guarantees now >= start.
  // The basis is the same wall-clock string comparison as `isDayDue`, so on a DST change night a
  // shift starting in the skipped or repeated hour is off by that hour (no shift starts then in
  // practice). A late clock-in is not evaluated (P-05).
  const expectedStart = input.shift?.startTime ?? null;
  const lateMinutes =
    status === "missing" && input.dayStr === input.todayStr && expectedStart !== null
      ? Math.max(0, minutesOfDay(input.nowHHMM) - minutesOfDay(expectedStart))
      : null;

  return { status, reason, isWorkday, isDue, expectedStart, lateMinutes };
}
