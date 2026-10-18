import type { LeaveTypeCode } from "@clokr/db";
import { DISPLAY_NAME } from "../absence"; // Phase 101B (Issue #101, wave 7)

// ── Presence State Resolver ──────────────────────────────────────────────────
// Pure utility — no DB dependency. Operates on plain data objects.
// Designed for unit testability (D-06, D-07).

export type PresenceStatus =
  "present" | "absent" | "clocked_in" | "missing" | "holiday" | "scheduled" | "requested" | "none";

export interface PresenceEntry {
  endTime: Date | null;
  isInvalid: boolean;
}

export interface PresenceLeave {
  status: "APPROVED" | "CANCELLATION_REQUESTED" | "PENDING";
  leaveTypeName: string;
}

export interface PresenceAbsence {
  type: string;
}

export interface PresenceResult {
  status: PresenceStatus;
  reason: string | null;
}

/**
 * Whether a given weekday is an *obligated* workday for an employee — i.e. a day
 * on which absence-without-reason should surface as "Fehlt" (missing).
 *
 * Schedule-type aware (the day-granular, type-agnostic logic this replaces
 * produced false "missing" for flexible schedules and for SHIFT_BASED employees):
 *
 *   - SHIFT_BASED  → obligation exists ONLY when a shift is planned for the day
 *     (`hasShift`). The planned shift IS the obligation; default per-day
 *     `{day}Hours` are irrelevant for shift workers.
 *   - FLEXTIME / MONTHLY_HOURS → never a per-day obligation. These are
 *     weekly/monthly budgets with free daily distribution, so no single day can
 *     be "Fehlt".
 *   - FIXED_SCHEDULE / null / unknown → the explicit `workDays` array is the
 *     source of truth when populated; otherwise fall back to `expectedHours > 0`.
 */
export function isObligatedWorkday(params: {
  scheduleType: string | null;
  workDays: number[];
  dow: number;
  expectedHours: number;
  hasShift: boolean;
}): boolean {
  const { scheduleType, workDays, dow, expectedHours, hasShift } = params;

  if (scheduleType === "SHIFT_BASED") {
    return hasShift;
  }

  if (scheduleType === "FLEXTIME" || scheduleType === "MONTHLY_HOURS") {
    return false;
  }

  // FIXED_SCHEDULE / null / unknown
  return workDays.length > 0 ? workDays.includes(dow) : expectedHours > 0;
}

/**
 * Whether a day is "due" — i.e. late enough that an absence on it may count as
 * "Fehlt". Separates the *obligation* (isObligatedWorkday) from the *timing*.
 *
 *   - past day  (`dayStr < todayStr`) → true (the day is over, absence is final).
 *   - future day (`dayStr > todayStr`) → false (not yet reached).
 *   - today:
 *       - with a shift → due only once the shift start time has passed
 *         (`nowHHMM >= shiftStartTime`). Before the shift starts, a missing
 *         clock-in is expected, not a violation.
 *       - without a shift → false. FIXED_SCHEDULE has no known intra-day start
 *         time, so "today" is never yet "Fehlt"; only past days are.
 *
 * A day is eligible for "missing" only when it is BOTH an obligated workday AND
 * due. Issue #587: `resolveDayStatus()` (below in this file) is the one place that combines
 * the obligation, this due time and the presence state; callers do not combine them again.
 */
export function isDayDue(params: {
  dayStr: string;
  todayStr: string;
  nowHHMM: string;
  shiftStartTime: string | null;
}): boolean {
  const { dayStr, todayStr, nowHHMM, shiftStartTime } = params;

  if (dayStr < todayStr) return true;
  if (dayStr > todayStr) return false;

  // today
  if (shiftStartTime) {
    return nowHHMM >= shiftStartTime;
  }
  return false;
}

/**
 * Resolves the presence status for a single employee on a single day.
 *
 * Priority order (D-08, D-09):
 * 1. Valid clocked_in entry (endTime null, isInvalid false)
 * 2. Valid completed entry (endTime not null, isInvalid false)
 * 3. PENDING leave → requested + "Antrag offen" (Phase 95 SHIFT-01)
 * 4. CANCELLATION_REQUESTED leave → absent + "Urlaubsstornierung beantragt"
 * 5. APPROVED leave → absent + leaveTypeName
 * 6. Absence → absent + German label
 * 7. Public holiday (isHoliday) → holiday + holidayName
 * 8. Future workday/shift → scheduled
 * 9. Past workday/shift → missing
 * 10. Default → none
 *
 * isInvalid:true entries are ignored entirely (D-08).
 */
export function resolvePresenceState(params: {
  entries: PresenceEntry[];
  leave: PresenceLeave | null;
  absence: PresenceAbsence | null;
  isWorkday: boolean;
  isFuture: boolean;
  hasShift: boolean;
  isHoliday: boolean;
  holidayName: string | null;
}): PresenceResult {
  const { entries, leave, absence, isWorkday, isFuture, hasShift, isHoliday, holidayName } = params;

  // Filter out invalid entries (D-08: isInvalid:true does not count as present/clocked_in)
  const validEntries = entries.filter((e) => !e.isInvalid);

  const isClockedIn = validEntries.some((e) => e.endTime === null);
  const isPresent = validEntries.some((e) => e.endTime !== null);

  if (isClockedIn) {
    return { status: "clocked_in", reason: null };
  }

  if (isPresent) {
    // Actual presence takes priority over leave (employee came in despite approved leave)
    return { status: "present", reason: null };
  }

  if (leave) {
    if (leave.status === "PENDING") {
      // Phase 95 SHIFT-01: a not-yet-APPROVED leave request. The leave is not yet
      // legally active (not "absent") but the day must not collapse to "none"/"missing".
      // Surface a distinct status; Plan 03 renders the German "beantragt" badge.
      // LO-02: mirror the my-week tooltip ("Antrag: {leaveType}"), falling back to
      // the generic "Antrag offen" when no leave type is available.
      return {
        status: "requested",
        reason: leave.leaveTypeName ? `Antrag: ${leave.leaveTypeName}` : "Antrag offen",
      };
    }
    if (leave.status === "CANCELLATION_REQUESTED") {
      // D-09: leave legally active until cancellation approved → employee is absent
      return { status: "absent", reason: "Urlaubsstornierung beantragt" };
    }
    // leave.status === "APPROVED"
    return { status: "absent", reason: leave.leaveTypeName };
  }

  if (absence) {
    return {
      status: "absent",
      // DISPLAY_NAME covers all eleven codes. The `??` fallback stays: PresenceAbsence.type is
      // declared `string`, so a value the compiled table has never seen can still arrive at
      // runtime (a $queryRaw row, a rolling deploy). Falling back to the raw code is the
      // pre-Phase-98b behaviour and is deliberately kept.
      reason: DISPLAY_NAME[absence.type as LeaveTypeCode] ?? absence.type,
    };
  }

  if (isHoliday) {
    return { status: "holiday", reason: holidayName };
  }

  if (isFuture && (hasShift || isWorkday)) {
    return { status: "scheduled", reason: null };
  }

  if (!isFuture && (hasShift || isWorkday)) {
    return { status: "missing", reason: null };
  }

  return { status: "none", reason: null };
}

// ── Day status (Issue #587, D-587-1) ──────────────────────────────────────────
// The ONE place a person's status on one day is resolved. It combines the three presence
// primitives — the obligation (`isObligatedWorkday`), the timing (`isDayDue`) and the state
// (`resolvePresenceState`) — in the order and with the arguments the team week used before, so
// every reader that shows a person-day (the team week, the attendance list) reads the same
// answer for the same inputs.
//
// The definition of a workday is NOT changed here: it stays above in this file. The function
// lives in `presence.ts` and not in a module of its own because a separate module would join the
// measured import cycle through `../absence` (gate `measure-context-boundary-imports --cycles`).
// This section is pure — no Prisma, no time-zone library, no clock read. The caller passes tenant-local strings
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
