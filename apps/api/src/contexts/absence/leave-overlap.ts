/**
 * Issue #478 — the create-side guards of a leave request, in ONE place.
 *
 * `POST /leave/requests`, the PENDING edit (`PATCH /leave/requests/:id`) and the approval of a
 * PENDING request (`PATCH /leave/requests/:id/review`) all decide "does this range collide with
 * another request" and "does it fit the yearly quota of its type" through these two functions.
 * Without the shared helper the edit path was a way around the POST guard (create on free
 * dates, then move onto an approved request).
 *
 * The blocking set is PENDING plus EFFECTIVE_LEAVE_STATUSES: a request in CANCELLATION_REQUESTED
 * is still active leave until its cancellation is approved (CLAUDE.md "Leave Cancellation
 * Flow"). The § 9 BUrlG exception (Phase 104 / R1) is narrow and directed: a SICK/SICK_CHILD
 * range may lie over an EFFECTIVE non-sick request; sick over sick and anything over PENDING
 * stay blocked. Two half days on one date stay an overlap (owner decision 25.10.2026).
 */
import type { Prisma, PrismaClient } from "@clokr/db";
import { EFFECTIVE_LEAVE_STATUSES, isEffectiveLeaveStatus } from "./effective-leave-statuses";
import { isSickLeaveTypeCode } from "./leave-type";

/** German 409 text, shared by every path that refuses an overlap. */
export const LEAVE_OVERLAP_ERROR = "Überschneidung mit bestehendem Antrag";

type Db = Pick<PrismaClient, "leaveRequest"> | Prisma.TransactionClient;

export async function findBlockingLeaveOverlap(
  db: Db,
  input: {
    employeeId: string;
    start: Date;
    end: Date;
    /** The range being booked is a SICK/SICK_CHILD one (enables the § 9 exception). */
    isSickRequest: boolean;
    /** The request being edited/approved — never collides with itself. */
    excludeRequestId?: string;
  },
) {
  const overlaps = await db.leaveRequest.findMany({
    where: {
      employeeId: input.employeeId,
      deletedAt: null,
      status: { in: ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] },
      startDate: { lte: input.end },
      endDate: { gte: input.start },
      ...(input.excludeRequestId ? { id: { not: input.excludeRequestId } } : {}),
    },
    include: { leaveType: true },
  });
  return (
    overlaps.find((o) => {
      if (!input.isSickRequest) return true; // non-sick: any counted or pending request blocks
      if (!isEffectiveLeaveStatus(o.status)) return true; // sick vs PENDING: still blocked
      if (isSickLeaveTypeCode(o.leaveType.code)) return true; // sick vs sick: still blocked
      return false; // § 9 case — permitted
    }) ?? null
  );
}

/**
 * Days a leave type already uses in the calendar year of `start` (PENDING plus effective
 * statuses — a request in CANCELLATION_REQUESTED keeps using up the quota). The caller compares
 * `used + days > maxDaysPerYear`.
 */
export async function leaveDaysUsedInYear(
  db: Db,
  input: { employeeId: string; leaveTypeId: string; start: Date; excludeRequestId?: string },
): Promise<number> {
  const yearStart = new Date(input.start.getFullYear(), 0, 1);
  const yearEnd = new Date(input.start.getFullYear(), 11, 31);
  const agg = await db.leaveRequest.aggregate({
    where: {
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      deletedAt: null,
      status: { in: ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] },
      startDate: { gte: yearStart, lte: yearEnd },
      ...(input.excludeRequestId ? { id: { not: input.excludeRequestId } } : {}),
    },
    _sum: { days: true },
  });
  return Number(agg._sum.days ?? 0);
}
