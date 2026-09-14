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
