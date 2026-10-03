/**
 * section9-detect.ts — § 9 BUrlG overlap detection (Phase 104).
 *
 * Pure, DB-free. Given a sick range and a set of the employee's APPROVED non-SICK leave requests,
 * answers "which of them does the sickness overlap, and over which days?".
 *
 * Kept out of routes/leave.ts so the same rule is used by the create guard (R1), the approve-path
 * auto-detection (D-09) and the tests — mirroring the single-source-of-truth structure of
 * find-unconfirmed-break-days.ts / find-missing-workdays.ts.
 *
 * IMPORTANT (R5 invariant, D-23): this module never reads or references the Karenztage rule in
 * any form. § 9 BUrlG grants the vacation credit only against a medical certificate; the § 5
 * EFZG Karenz threshold governs documentation duty only and must never reach this path. Phase 97
 * (T2) adds one import — the shared sickness-code check from `utils/leave-type.ts` — replacing
 * the local pair of German sick-type display names this module used to carry. That import
 * carries no rule content, only the closed set of sickness codes; it does not, and must never,
 * import from `find-karenz-overrun-days.ts` or reference the Karenz threshold. The invariant
 * this file protects is "never reads the Karenztage rule", not "imports nothing" — the former is
 * what R5 actually requires.
 */
import type { LeaveTypeCode } from "@clokr/db";
import { isSickLeaveTypeCode } from "./leave-type";

export type LeaveRangeRow = {
  id: string;
  startDate: Date;
  endDate: Date;
  status: string;
  leaveType: { code: LeaveTypeCode | null };
};

export type Section9Overlap = {
  vacationRequestId: string;
  overlapStart: Date;
  overlapEnd: Date;
};

/** Inclusive intersection of two date ranges, or null when disjoint. */
export function intersectRanges(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): { start: Date; end: Date } | null {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return start > end ? null : { start, end };
}

/**
 * The § 9 candidates for a sick range: every APPROVED, non-SICK request it intersects.
 * PENDING requests are deliberately excluded — an unapproved vacation is not yet an
 * "erfüllter Urlaubsanspruch" and there is nothing to not-count against.
 */
export function findSection9Overlaps(
  sickStart: Date,
  sickEnd: Date,
  candidates: LeaveRangeRow[],
): Section9Overlap[] {
  const out: Section9Overlap[] = [];
  for (const c of candidates) {
    if (c.status !== "APPROVED") continue;
    if (isSickLeaveTypeCode(c.leaveType.code)) continue;
    const hit = intersectRanges(sickStart, sickEnd, c.startDate, c.endDate);
    if (!hit) continue;
    out.push({ vacationRequestId: c.id, overlapStart: hit.start, overlapEnd: hit.end });
  }
  return out.sort(
    (a, b) =>
      a.overlapStart.getTime() - b.overlapStart.getTime() ||
      a.vacationRequestId.localeCompare(b.vacationRequestId),
  );
}

export type Section9CreditForPlanning = {
  id: string;
  status: string;
  creditedStart: Date | null;
  creditedEnd: Date | null;
  overlapStart: Date;
  overlapEnd: Date;
};

export type Section9CorrectionPlan = {
  /** Credit ids that stay exactly as they are — no status change, no ledger write. */
  keep: string[];
  /** Credit ids that move to SUPERSEDED. `ledgerUndo` is true only for a CONFIRMED credit —
   * a CONFIRMED credit actually booked a ledger entry (via reverseVacationDays at confirm
   * time) that must now be undone; AU_PENDING/REJECTED never booked anything. */
  supersede: Array<{ id: string; ledgerUndo: boolean }>;
  /** The clipped replacement range for a CONFIRMED credit whose credited range only PARTIALLY
   * overlaps the new range — the caller re-prices this range and creates a revision+1
   * correction credit for it (never produced for AU_PENDING/REJECTED, D-04). */
  clip: Array<{ id: string; start: Date; end: Date }>;
};

/**
 * Issue #468 (D-04/A-3, finding 2/G18): pure, DB-free classification of a vacation's (or sick
 * request's) § 9 credits against the NEW range a `/correct` call is about to apply.
 *
 * Decision rules recorded on the issue (plan 05):
 * - A credit whose status is already SUPERSEDED is ignored entirely — it has no effect and is
 *   never reconsidered by a later correction (only a later clip of its OWN revision chain can
 *   supersede it again, and that chain is built by the caller, not this function).
 * - `typeChanged` (the corrected request's type no longer matches what it was) supersedes every
 *   remaining credit of it, regardless of range overlap — the credited days are no longer that
 *   type's days at all. Only a CONFIRMED credit has a ledger effect to undo.
 * - Otherwise, a CONFIRMED credit is compared by its CREDITED range (what was actually booked);
 *   an AU_PENDING/REJECTED credit is compared by its OVERLAP range (nothing was booked yet):
 *   - no overlap with the new range → supersede (CONFIRMED undoes its ledger entry; the others
 *     never had one).
 *   - the credit's own range lies fully inside the new range → keep, untouched.
 *   - partial overlap → a CONFIRMED credit is superseded AND clipped to the overlapping part (a
 *     new revision+1 correction credit is created for it by the caller); an AU_PENDING/REJECTED
 *     credit with partial overlap simply stays — confirm/reject clip it to the vacation's
 *     CURRENT range at decision time instead (Task 2).
 *
 * R5 invariant unchanged (see the file docblock): this function never reads or references the
 * Karenztage rule.
 */
export function planSection9CreditsForCorrection(input: {
  credits: ReadonlyArray<Section9CreditForPlanning>;
  newStart: Date;
  newEnd: Date;
  typeChanged: boolean;
}): Section9CorrectionPlan {
  const keep: string[] = [];
  const supersede: Array<{ id: string; ledgerUndo: boolean }> = [];
  const clip: Array<{ id: string; start: Date; end: Date }> = [];

  for (const credit of input.credits) {
    if (credit.status === "SUPERSEDED") continue; // already overholt, never reconsidered here

    const isConfirmed = credit.status === "CONFIRMED";
    const rangeStart = isConfirmed ? credit.creditedStart! : credit.overlapStart;
    const rangeEnd = isConfirmed ? credit.creditedEnd! : credit.overlapEnd;

    if (input.typeChanged) {
      supersede.push({ id: credit.id, ledgerUndo: isConfirmed });
      continue;
    }

    const overlap = intersectRanges(rangeStart, rangeEnd, input.newStart, input.newEnd);

    if (!overlap) {
      supersede.push({ id: credit.id, ledgerUndo: isConfirmed });
      continue;
    }

    const fullyInside =
      overlap.start.getTime() === rangeStart.getTime() &&
      overlap.end.getTime() === rangeEnd.getTime();
    if (fullyInside) {
      keep.push(credit.id);
      continue;
    }

    // Partial overlap: only a CONFIRMED credit gets superseded + a clipped replacement — an
    // AU_PENDING/REJECTED credit is left alone (confirm/reject clip it at decision time).
    if (isConfirmed) {
      supersede.push({ id: credit.id, ledgerUndo: true });
      clip.push({ id: credit.id, start: overlap.start, end: overlap.end });
    } else {
      keep.push(credit.id);
    }
  }

  return { keep, supersede, clip };
}
