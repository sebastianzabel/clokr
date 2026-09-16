/**
 * Phase 94-01 — DELTA-based locked-month protection for manager leave corrections.
 *
 * When a Manager/Admin directly corrects an already-APPROVED LeaveRequest
 * (PATCH /requests/:id/correct), only the days that actually CHANGE may not
 * fall into a finalized (isLocked / Monatsabschluss) month — the retained
 * overlap of a shortened leave is left untouched (Revisionssicherheit).
 *
 * `computeAffectedMonths` is the pure core of that guard: given the old and new
 * date ranges (plus whether the leave type or half-day flag changed), it returns
 * the DISTINCT calendar months whose immutability the route must check against a
 * MONTHLY SaldoSnapshot(superseded:false).
 *
 * Affected days =
 *   symmetric date difference of [oldStart,oldEnd] vs [newStart,newEnd]
 *   (i.e. added ∪ removed days)
 *   ∪  (when typeChanged OR halfDayChanged) the retained intersection days,
 *      because their saldo/entitlement meaning changes even though the calendar
 *      day is unchanged.
 *
 * Pure — no Prisma, no I/O. Day iteration is at UTC date granularity to match
 * the @db.Date storage of LeaveRequest.startDate/endDate (UTC midnight).
 */

export interface CorrectionRange {
  oldStart: Date;
  oldEnd: Date;
  newStart: Date;
  newEnd: Date;
  typeChanged: boolean;
  halfDayChanged: boolean;
}

/** A calendar month, `month` is 1-12 (matching monthRangeUtc's convention). */
export interface AffectedMonth {
  year: number;
  month: number;
}

/** Inclusive list of "YYYY-MM-DD" UTC date strings from start..end. */
function eachUtcDay(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur <= last) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

export function computeAffectedMonths(args: CorrectionRange): AffectedMonth[] {
  const oldDays = new Set(eachUtcDay(args.oldStart, args.oldEnd));
  const newDays = new Set(eachUtcDay(args.newStart, args.newEnd));

  const affected = new Set<string>();
  // Symmetric difference: days present in exactly one of the two ranges.
  for (const d of oldDays) if (!newDays.has(d)) affected.add(d);
  for (const d of newDays) if (!oldDays.has(d)) affected.add(d);

  // Retained intersection matters only when the meaning of a kept day changed.
  if (args.typeChanged || args.halfDayChanged) {
    for (const d of oldDays) if (newDays.has(d)) affected.add(d);
  }

  // Dedup affected days into distinct {year, month}.
  const months = new Map<string, AffectedMonth>();
  for (const d of affected) {
    const year = Number(d.slice(0, 4));
    const month = Number(d.slice(5, 7));
    months.set(`${year}-${month}`, { year, month });
  }
  return [...months.values()];
}
