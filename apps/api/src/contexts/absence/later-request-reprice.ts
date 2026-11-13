// Issue #467 — after a /correct moves a VACATION request into the ISO weeks of requests created
// LATER, those later requests were priced when the corrected one did not yet cover the week, so
// the week is deducted twice (§ 13 Abs. 1 BUrlG: never more than was taken).
//
// This re-prices exactly those later requests through the ONE pricing kernel (`resolveLeaveDays`,
// each against the requests created before it, in creation order, so every price sees the
// already-updated earlier ones). Rules:
//   - only a LOWER price is ever written (a correction never makes a later request dearer);
//   - a request touching a closed month is left alone (`isSnapshotLocked`, Revisionssicherheit);
//   - the entitlement ledger moves by the delta (APPROVED / CANCELLATION_REQUESTED only — a
//     PENDING request has booked nothing);
//   - every change is audited as `LEAVE_DAYS_ADJUSTED` (same shape as the roster recalc, Phase
//     107 D-20) inside the caller's transaction.
// Stored requests that are not touched by the correction's weeks are never re-priced.

import type { Prisma } from "@clokr/db";
import { EFFECTIVE_LEAVE_STATUSES } from "./effective-leave-statuses";
import { resolveLeaveDays, getHolidayMap, reverseVacationDays } from "./leave-days";
import { isSnapshotLocked } from "../working-time-account";

const DAY_MS = 24 * 60 * 60 * 1000;

function mondayOf(d: Date): Date {
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
}

export interface RepricedLaterRequest {
  id: string;
  oldDays: number;
  newDays: number;
}

export async function repriceLaterVacationRequests(
  tx: Prisma.TransactionClient,
  input: {
    employeeId: string;
    tenantId: string;
    correctedRequest: { id: string; createdAt: Date };
    start: Date;
    end: Date;
    audit: (entry: {
      action: string;
      entity: string;
      entityId: string;
      oldValue?: object;
      newValue?: object;
    }) => Promise<void>;
  },
): Promise<RepricedLaterRequest[]> {
  const { employeeId, tenantId, correctedRequest, start, end } = input;
  const weekSpanStart = mondayOf(start);
  const weekSpanEnd = new Date(mondayOf(end).getTime() + 6 * DAY_MS);

  const candidates = await tx.leaveRequest.findMany({
    where: {
      employeeId,
      employee: { tenantId },
      deletedAt: null,
      status: { in: ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] },
      leaveType: { code: "VACATION" },
      startDate: { lte: weekSpanEnd },
      endDate: { gte: weekSpanStart },
      id: { not: correctedRequest.id },
      OR: [
        { createdAt: { gt: correctedRequest.createdAt } },
        { createdAt: correctedRequest.createdAt, id: { gt: correctedRequest.id } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const results: RepricedLaterRequest[] = [];
  for (const candidate of candidates) {
    if (await isSnapshotLocked(tx, employeeId, tenantId, candidate.startDate, candidate.endDate)) {
      continue;
    }
    const holidayMap = await getHolidayMap(
      tx,
      tenantId,
      employeeId,
      candidate.startDate,
      candidate.endDate,
    );
    const holidays = new Set(holidayMap.keys());
    const recomputed = await resolveLeaveDays(
      tx,
      employeeId,
      tenantId,
      candidate.startDate,
      candidate.endDate,
      candidate.halfDay,
      holidays,
      { mode: "request", leaveTypeCode: "VACATION", excludeRequestId: candidate.id },
    );
    const oldDays = Number(candidate.days);
    const newDays = recomputed.days;
    // Never dearer, never a no-op write.
    if (newDays >= oldDays) continue;

    await tx.leaveRequest.update({
      where: { id: candidate.id },
      data: { days: newDays },
    });
    if (candidate.status !== "PENDING") {
      await reverseVacationDays(
        tx,
        employeeId,
        candidate.leaveTypeId,
        candidate.startDate,
        candidate.endDate,
        oldDays - newDays,
        holidays,
        tenantId,
      );
    }
    await input.audit({
      action: "LEAVE_DAYS_ADJUSTED",
      entity: "LeaveRequest",
      entityId: candidate.id,
      oldValue: { days: oldDays, daysProvisional: candidate.daysProvisional },
      newValue: {
        days: newDays,
        daysProvisional: candidate.daysProvisional,
        trigger: "Korrektur eines früheren Antrags",
        triggerSource: "CORRECTION",
        correctedLeaveRequestId: correctedRequest.id,
      },
    });
    results.push({ id: candidate.id, oldDays, newDays });
  }
  return results;
}
