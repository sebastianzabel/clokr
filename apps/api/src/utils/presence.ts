// ── Presence State Resolver ──────────────────────────────────────────────────
// Pure utility — no DB dependency. Operates on plain data objects.
// Designed for unit testability (D-06, D-07).

export type PresenceStatus =
  | "present"
  | "absent"
  | "clocked_in"
  | "missing"
  | "holiday"
  | "scheduled"
  | "requested"
  | "none";

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

// German labels for absence types
const ABSENCE_LABELS: Record<string, string> = {
  SICK: "Krankmeldung",
  SICK_CHILD: "Kinderkrank",
  MATERNITY: "Mutterschutz",
  PARENTAL: "Elternzeit",
  VOCATIONAL_SCHOOL: "Berufsschule",
};

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
 * due. Callers pass `isFuture: !(isObligatedWorkday && isDayDue)` into
 * `resolvePresenceState`, whose scheduled/missing branches key off `isFuture`.
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
      reason: ABSENCE_LABELS[absence.type] ?? absence.type,
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
