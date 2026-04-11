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
  | "none";

export interface PresenceEntry {
  endTime: Date | null;
  isInvalid: boolean;
}

export interface PresenceLeave {
  status: "APPROVED" | "CANCELLATION_REQUESTED";
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
};

/**
 * Resolves the presence status for a single employee on a single day.
 *
 * Priority order (D-08, D-09):
 * 1. Valid clocked_in entry (endTime null, isInvalid false)
 * 2. Valid completed entry (endTime not null, isInvalid false)
 * 3. CANCELLATION_REQUESTED leave → absent + "Urlaubsstornierung beantragt"
 * 4. APPROVED leave → absent + leaveTypeName
 * 5. Absence → absent + German label
 * 6. Public holiday (isHoliday) → holiday + holidayName
 * 7. Future workday/shift → scheduled
 * 8. Past workday/shift → missing
 * 9. Default → none
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
