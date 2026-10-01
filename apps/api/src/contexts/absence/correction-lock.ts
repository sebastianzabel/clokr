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
 *
 * Issue #446 (D-07/D-08): `monthsInRange` and `closedMonthLeaveMessage` extend this pure
 * module for the SEPARATE closed-month guard that refuses a leave TRANSITION (create,
 * approve, approve cancellation, request cancellation) touching an already-closed month —
 * as opposed to `computeAffectedMonths` above, which only guards the CHANGED days of a
 * manager's direct correction. `monthsInRange` is every distinct calendar month of a
 * period; `closedMonthLeaveMessage` builds the shared German 409 message. The DB walk over
 * `isMonthClosed` lives in the sibling `closed-month-guard.ts` (kept out of this file to
 * preserve purity).
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

/**
 * Issue #446 (D-07): every DISTINCT calendar month touched by the inclusive UTC-day range
 * [start, end], ascending by year then month. Unlike `computeAffectedMonths`, there is no
 * old/new comparison here — the whole period is what must not touch a closed month for a
 * leave TRANSITION (create, approve, approve cancellation, request cancellation).
 */
export function monthsInRange(start: Date, end: Date): AffectedMonth[] {
  const months = new Map<string, AffectedMonth>();
  for (const d of eachUtcDay(start, end)) {
    const year = Number(d.slice(0, 4));
    const month = Number(d.slice(5, 7));
    months.set(`${year}-${month}`, { year, month });
  }
  return [...months.values()].sort((a, b) => a.year - b.year || a.month - b.month);
}

/** `MM/YYYY`, zero-padded month. */
function formatMonthLabel(m: AffectedMonth): string {
  return `${String(m.month).padStart(2, "0")}/${m.year}`;
}

/** German list join: "A" | "A und B" | "A, B und C". */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} und ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} und ${labels[labels.length - 1]}`;
}

/**
 * Issue #446 (D-08, revised): the ONE message builder shared by all four closed-month guard
 * points. Names the closed month(s) and the reason, points to the real correction path — the
 * audited "Monat entsperren" unlock in Admin -> Monatsabschluss (`POST
 * /overtime/unlock-month`) — the only correction path for a closed month. There is NO
 * separate "Korrekturbuchung" feature, so the text never promises one. `kind: "request"` is
 * used for a brand-new leave request (guard point a); `kind: "change"` covers every
 * existing-request transition (approval, cancellation approval, cancellation request) — the
 * wording differs only in that second sentence. `/correct` keeps its own, unrelated message
 * ("Gesperrter Monat — Korrektur nicht möglich") unchanged.
 */
export function closedMonthLeaveMessage(
  months: readonly AffectedMonth[],
  kind: "request" | "change",
): string {
  const labels = months.map(formatMonthLabel);
  const joined = joinLabels(labels);
  const plural = months.length > 1;
  const first = plural
    ? `Der Zeitraum enthält die abgeschlossenen Monate ${joined}.`
    : `Der Zeitraum enthält den abgeschlossenen Monat ${joined}.`;
  const tail = plural
    ? "die Monate nicht wieder entsperrt sind."
    : "der Monat nicht wieder entsperrt ist.";
  const second =
    kind === "request"
      ? `Dafür kann keine Abwesenheit beantragt werden, solange ${tail}`
      : `Nach dem Monatsabschluss ist diese Änderung dort nicht möglich, solange ${tail}`;
  return `${first} ${second}`;
}
