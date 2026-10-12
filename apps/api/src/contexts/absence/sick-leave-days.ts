/**
 * Issue #84 (D-14) — THE one place sick-leave days are counted for reports and the dashboard.
 *
 * Moved out of `composition/reports.ts` (`computeEmployeeSummary`), where it was a business rule
 * living in the composition layer (ADR 0002, Entscheidung 9). The monthly report (JSON and both
 * PDFs) and the dashboard team trend call this function; neither carries a day-counting rule of
 * its own.
 *
 * The rule:
 *   - calendar days, Saturday and Sunday included (sick leave is not a workday count),
 *   - each range is clipped to the period [firstDay, lastDay],
 *   - a half day multiplies the row's clipped count by 0.5,
 *   - the attest split: the attest window intersected with the request is "with attest", the rest
 *     of the request is "without attest"; `attestPresent` without a validity window attests the
 *     whole request,
 *   - the § 9 BUrlG shift: days of a CONFIRMED `Section9Credit` are attested by definition, so
 *     min(without attest, credited days) moves from the without to the with bucket. The two
 *     buckets move as one transfer, their sum (`sickDays`) is invariant.
 *
 * Only `LeaveRequest` rows count. `Absence` rows (SICK / SICK_CHILD, the AU document path) are
 * deliberately never an input: the Absence model tracks the AU-Bescheinigung document, not the
 * sick event, and adding both would double-count the days of one sickness. The kernel filters the
 * rows itself — sick codes via `isSickLeaveTypeCode`, statuses via `EFFECTIVE_LEAVE_STATUSES` —
 * so a caller may hand it every leave row of the period. Overlapping rows are NOT de-duplicated
 * (the report never did); two sick rows on one day count twice.
 *
 * `countsDay` is the dashboard's hook (salon attribution by Stammsalon, D-04/D-13): every counted
 * range — request, attest window and § 9 credit — is restricted to the days the predicate
 * accepts. A predicate that accepts every day yields exactly the predicate-free result.
 *
 * Pure: no Prisma, no clock. Dates are UTC-midnight calendar days (`@db.Date` columns).
 */
import type { LeaveRequestStatus, LeaveTypeCode } from "@clokr/db";
import { isSickLeaveTypeCode } from "./leave-type";
import { EFFECTIVE_LEAVE_STATUSES } from "./effective-leave-statuses";

const MS_PER_DAY = 86_400_000;

/** The fields of a `LeaveRequest` (with its `LeaveType`) the kernel reads. */
export interface SickLeaveDayRow {
  startDate: Date;
  endDate: Date;
  halfDay: boolean;
  status: LeaveRequestStatus;
  attestPresent: boolean;
  attestValidFrom: Date | null;
  attestValidTo: Date | null;
  leaveType: { code: LeaveTypeCode | null };
}

export interface SickLeaveDayCounts {
  /** Always `sickDaysWithAttest + sickDaysWithoutAttest`. */
  sickDays: number;
  sickDaysWithAttest: number;
  sickDaysWithoutAttest: number;
  /** The clipped days of the supplied § 9 credits (0 when none were supplied). */
  section9DaysThisMonth: number;
}

export function sickLeaveDayCounts(
  rows: readonly SickLeaveDayRow[],
  firstDay: Date,
  lastDay: Date,
  options: {
    section9Credits?: ReadonlyArray<{ creditedStart: Date; creditedEnd: Date }>;
    countsDay?: (day: string) => boolean;
  } = {},
): SickLeaveDayCounts {
  const { section9Credits = [], countsDay } = options;

  // Days of [from, to] clipped to the period; with a predicate only the accepted days.
  function daysInRange(from: Date, to: Date): number {
    const s = from < firstDay ? firstDay : from;
    const e = to > lastDay ? lastDay : to;
    const span = Math.max(0, Math.round((e.getTime() - s.getTime()) / MS_PER_DAY) + 1);
    if (!countsDay) return span;
    let accepted = 0;
    for (let i = 0; i < span; i++) {
      const day = new Date(s.getTime() + i * MS_PER_DAY).toISOString().slice(0, 10);
      if (countsDay(day)) accepted += 1;
    }
    return accepted;
  }

  let sickDaysWithAttest = 0;
  let sickDaysWithoutAttest = 0;

  for (const lr of rows) {
    if (!isSickLeaveTypeCode(lr.leaveType.code)) continue;
    if (!(EFFECTIVE_LEAVE_STATUSES as readonly LeaveRequestStatus[]).includes(lr.status)) continue;

    const factor = lr.halfDay ? 0.5 : 1;
    const totalDays = daysInRange(lr.startDate, lr.endDate) * factor;
    if (lr.attestPresent && lr.attestValidFrom && lr.attestValidTo) {
      const attestFrom = lr.attestValidFrom > lr.startDate ? lr.attestValidFrom : lr.startDate;
      const attestTo = lr.attestValidTo < lr.endDate ? lr.attestValidTo : lr.endDate;
      const attestDays = daysInRange(attestFrom, attestTo) * factor;
      sickDaysWithAttest += attestDays;
      sickDaysWithoutAttest += Math.max(0, totalDays - attestDays);
    } else if (lr.attestPresent) {
      sickDaysWithAttest += totalDays;
    } else {
      sickDaysWithoutAttest += totalDays;
    }
  }

  // § 9 BUrlG: only days that were actually in the without-attest bucket may move, so a request
  // that already carries an attest is not counted twice (Phase 104 review WR-02).
  const section9DaysThisMonth = section9Credits.reduce(
    (sum, c) => sum + daysInRange(c.creditedStart, c.creditedEnd),
    0,
  );
  const section9DaysShiftedToAttest = Math.min(sickDaysWithoutAttest, section9DaysThisMonth);
  sickDaysWithoutAttest -= section9DaysShiftedToAttest;
  sickDaysWithAttest += section9DaysShiftedToAttest;

  return {
    sickDays: sickDaysWithAttest + sickDaysWithoutAttest,
    sickDaysWithAttest,
    sickDaysWithoutAttest,
    section9DaysThisMonth,
  };
}
