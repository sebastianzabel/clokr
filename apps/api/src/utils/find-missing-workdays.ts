/**
 * find-missing-workdays.ts
 *
 * Pure, schedule-model-aware gap detector for the Monatsabschluss pipeline.
 *
 * Returns the set of expected workdays that have no time entry — the single source
 * of truth consumed by both the gap-warning surface (76.28) and the saldo writer
 * (close-employee-month.ts). By returning the SAME coveredDates set used to derive
 * gaps, the warning list and the saldo computation can never drift (fixes pitfall A1).
 *
 * Purity contract: NO Prisma import, NO DB/network calls, NO async. Caller pre-fetches
 * all data and passes it in via MissingWorkdaysInput.
 *
 * Schedule-model dispatch (CLOSE-02):
 *   FIXED_WEEKLY / FIXED_SCHEDULE: expected days = days in span where getDayHoursFromSchedule > 0.
 *   SHIFT_BASED: expected days = rosterDates (pre-fetched Shift.date set). MUST NOT call
 *     getDayHoursFromSchedule in this branch (pitfall A4 fix).
 *   MONTHLY_HOURS / FLEXTIME: return gaps=[] immediately (D-01 — no daily gap rule).
 *
 * Half-day handling (D-02, pitfall A2):
 *   A half-day leave date is added to coveredDates (same as full-day leave).
 *   Additionally, it is tracked in halfDayDates.
 *   - If the employee has NO entry on a half-day date: flagged as { date, partial: true }.
 *   - If the employee HAS an entry on a half-day date: not a gap.
 *
 * Span bounds (CLOSE-04, pitfall A5):
 *   Expected days are only enumerated within [effectiveStart, effectiveEnd].
 *   effectiveEnd = min(exitDate, monthLastDay) — exitDate is INCLUSIVE (D-03).
 */

import { getDayHoursFromSchedule, getDayOfWeekInTz, dateStrInTz } from "./timezone";

// ── Public types ──────────────────────────────────────────────────────────────

export type WorkdayGap = {
  date: string; // "YYYY-MM-DD" in tenant TZ
  partial: boolean; // true if a half-day-leave covers this date (A2 / D-02)
};

export type MissingWorkdaysResult = {
  gaps: WorkdayGap[]; // empty = no gaps
  coveredDates: Set<string>; // dates excused by leave/absence/holiday
  entryDates: Set<string>; // dates with time entries (passed through from input)
};

export type MissingWorkdaysInput = {
  schedule: Record<string, unknown>; // WorkSchedule row
  effectiveStart: Date; // max(hireDate, monthFirstDay)
  effectiveEnd: Date; // min(exitDate, monthLastDay) — CLOSE-04
  tz: string;
  entryDates: Set<string>; // pre-computed from TimeEntry query
  approvedLeave: Array<{
    startDate: Date;
    endDate: Date;
    halfDay: boolean;
  }>;
  absences: Array<{ startDate: Date; endDate: Date }>;
  holidayDateStrings: Set<string>; // YYYY-MM-DD in tenant TZ
  rosterDates?: Set<string>; // SHIFT_BASED only: Shift.date strings
};

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Pure gap detector — no DB calls, no async.
 *
 * @see MissingWorkdaysInput for parameter documentation.
 * @returns { gaps, coveredDates, entryDates } — the same coveredDates must be
 *   passed into the saldo core so warning list and saldo can never drift (A1).
 */
export function findMissingWorkdays(input: MissingWorkdaysInput): MissingWorkdaysResult {
  const { schedule, effectiveStart, effectiveEnd, tz, entryDates } = input;

  const type = String(schedule.type ?? "");

  // ── Step 1: Build coveredDates and halfDayDates ───────────────────────────
  //
  // coveredDates = union of:
  //   - Every date in each approvedLeave range (ALL types incl. halfDay)
  //   - Every date in each absence range (ALL types incl. VOCATIONAL_SCHOOL — A3)
  //   - Every date in holidayDateStrings
  //
  // Only dates within [effectiveStart, effectiveEnd] are added; a leave/absence
  // range extending past exitDate should not cover post-exit days.
  //
  // halfDayDates = subset of coveredDates covered by a halfDay:true leave.

  const coveredDates = new Set<string>();
  const halfDayDates = new Set<string>();

  const spanStart = dateStrInTz(effectiveStart, tz);
  const spanEnd = dateStrInTz(effectiveEnd, tz);

  for (const lr of input.approvedLeave) {
    iterateDateRange(lr.startDate, lr.endDate, tz, (ds) => {
      if (ds >= spanStart && ds <= spanEnd) {
        coveredDates.add(ds);
        if (lr.halfDay) {
          halfDayDates.add(ds);
        }
      }
    });
  }

  for (const ab of input.absences) {
    // ALL absence types go into coveredDates — do NOT filter VOCATIONAL_SCHOOL (A3).
    iterateDateRange(ab.startDate, ab.endDate, tz, (ds) => {
      if (ds >= spanStart && ds <= spanEnd) {
        coveredDates.add(ds);
      }
    });
  }

  for (const ds of input.holidayDateStrings) {
    // Holidays are already YYYY-MM-DD strings; apply span guard.
    if (ds >= spanStart && ds <= spanEnd) {
      coveredDates.add(ds);
    }
  }

  // ── Step 2: Short-circuit for MONTHLY_HOURS and FLEXTIME (D-01) ─────────
  //
  // These schedule types have no daily gap rule. Return gaps=[] immediately.
  // coveredDates is still returned so the caller has the shared set.

  if (type === "MONTHLY_HOURS" || type === "FLEXTIME") {
    return { gaps: [], coveredDates, entryDates };
  }

  // ── Step 3: Enumerate expected days ──────────────────────────────────────
  //
  // SHIFT_BASED: expected = rosterDates (pre-fetched Shift.date set).
  //   DO NOT use getDayHoursFromSchedule here — pitfall A4 fix.
  //
  // FIXED_WEEKLY / FIXED_SCHEDULE / unknown: iterate every day in span;
  //   expected if getDayHoursFromSchedule(schedule, dow) > 0.

  let expectedDates: Set<string>;

  if (type === "SHIFT_BASED") {
    // Use rosterDates only — keys off Shift.date, NOT {day}Hours (pitfall A4).
    // If rosterDates is not provided, treat as empty set → no gaps.
    expectedDates = input.rosterDates ?? new Set<string>();
  } else {
    // FIXED_WEEKLY, FIXED_SCHEDULE, or any unknown type — use schedule hours.
    expectedDates = new Set<string>();
    iterateDateRange(effectiveStart, effectiveEnd, tz, (ds, utcDate) => {
      const dow = getDayOfWeekInTz(utcDate, tz);
      if (getDayHoursFromSchedule(schedule, dow) > 0) {
        expectedDates.add(ds);
      }
    });
  }

  // ── Step 4: Build gaps ───────────────────────────────────────────────────
  //
  // For each expected day:
  //   - Skip if in entryDates (employee has an entry).
  //   - Skip if in coveredDates (leave/absence/holiday covers it).
  //   - Otherwise: gap { date, partial: false }.
  //
  // For each halfDayDate not in entryDates (and within span):
  //   - Add as gap { date, partial: true }.
  //   - Note: a half-day date IS in coveredDates, so it was already skipped in
  //     the expected-day loop above. Step 4b below emits the partial gap.

  const gaps: WorkdayGap[] = [];

  for (const d of expectedDates) {
    if (entryDates.has(d) || coveredDates.has(d)) continue;
    gaps.push({ date: d, partial: false });
  }

  // Step 4b: partial gaps from half-day leave with no time entry (D-02).
  for (const d of halfDayDates) {
    // Span guard: half-day dates were already span-filtered when building
    // halfDayDates, so no additional check needed here.
    if (!entryDates.has(d)) {
      // Avoid duplicating a day that was already emitted as a full gap above.
      // Since a half-day date IS in coveredDates, it was skipped in step 4a
      // and cannot already be in gaps as a full gap. Safe to push directly.
      gaps.push({ date: d, partial: true });
    }
  }

  // ── Step 5: Sort gaps by date ascending for stable output ────────────────
  gaps.sort((a, b) => a.date.localeCompare(b.date));

  return { gaps, coveredDates, entryDates };
}

// ── Internal helper ───────────────────────────────────────────────────────────

/**
 * Iterate every calendar day from `from` to `to` (inclusive) in the given
 * tenant timezone, invoking `callback` with the date string "YYYY-MM-DD" and
 * the UTC Date at each step.
 *
 * DST-safe: advances by 24h in UTC (not 86400000ms) and re-derives the tenant
 * date string each step. A 25h or 23h DST day still maps to the correct
 * calendar date string in the tenant TZ.
 */
function iterateDateRange(
  from: Date,
  to: Date,
  tz: string,
  callback: (dateStr: string, utcDate: Date) => void,
): void {
  const endStr = dateStrInTz(to, tz);
  // Start at the UTC timestamp of `from`, but align to midnight UTC to avoid
  // sub-day offset issues when dateStrInTz resolves to a different calendar day.
  const cur = new Date(from.getTime());

  let safetyLimit = 400; // max ~13 months; prevents infinite loop on bad input

  while (true) {
    const ds = dateStrInTz(cur, tz);
    if (ds > endStr) break;
    callback(ds, cur);
    // Advance by exactly 24h in UTC. DST-safe for date-string comparisons.
    cur.setTime(cur.getTime() + 24 * 60 * 60 * 1000);
    if (--safetyLimit <= 0) break;
  }
}
