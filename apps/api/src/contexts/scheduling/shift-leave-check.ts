/**
 * Phase 430 (D-03/D-04) — S4, the inverse of `facade/shifts.ts`'s S2
 * (`flagShiftsConflictingWithLeave`): a shift just created/updated for `employeeId` on `date` may
 * land on a day that ALREADY has an APPROVED LeaveRequest.
 *
 * Phase 430-06 (follow-up to #437/#429, boundary-cycle gate): deliberately NOT in
 * `facade/shifts.ts` and NOT re-exported from `contexts/scheduling/index.ts`. Every real caller
 * (`services/phorest/sync-shifts.ts`, `contexts/scheduling/api/shifts.ts`) already imports this
 * function by its own relative path, inside the Schichtplanung boundary area (CLAUDE.md:
 * `services/phorest/` counts as this context) — no cross-context caller exists or is expected
 * (grep confirms zero hits outside `contexts/scheduling/`/`services/phorest/`). `facade/shifts.ts`
 * is, unlike this file, unavoidably reachable from the pre-existing absence/scheduling/
 * time-tracking/working-time-account import cycle (via its own cross-context-needed
 * `getShiftsInRange` export) — adding this function's own `../../absence` import THERE would close
 * a NEW back-edge into that cycle for no functional reason, since nothing needs this function
 * through `scheduling/index.ts` in the first place. Keeping it in its own, non-re-exported file
 * means it can import `getApprovedLeaveOverlapping` from `../../absence` (a legitimate, ADR-0002-
 * sanctioned peer read) without joining that cycle: nothing cycle-internal imports this file, so
 * the loop never closes.
 */
import type { Prisma } from "@clokr/db";
import { type EmployeeScope } from "../platform";
import { getApprovedLeaveOverlapping } from "../absence";

/**
 * S4 — mirrors S2's own idempotency idiom exactly (every RELEVANT_METHOD call here carries the
 * same inline `employeeId`/`employee: { tenantId }` filter S2 and S3 already use,
 * `lint-tenant-scoping`) — only flags+returns the shift when its `conflictsWithLeave` is currently
 * `false`. A shift that is already flagged, foreign to this tenant/employee, or soft-deleted is a
 * no-op: `updateMany`'s `count` is 0, so the caller never re-audits/re-notifies it (no extra dedup
 * state needed, same as S2).
 */
export async function flagShiftIfConflictsWithApprovedLeave(
  db: Prisma.TransactionClient,
  shiftId: string,
  employeeId: string,
  tenantId: string,
  date: Date,
): Promise<{
  shiftId: string;
  date: Date;
  startTime: string;
  endTime: string;
  label: string | null;
  salonId: string;
  leaveRequestId: string;
  leaveStart: Date;
  leaveEnd: Date;
} | null> {
  const scope: EmployeeScope = { kind: "employee", employeeId, tenantId };
  const [leave] = await getApprovedLeaveOverlapping(db, scope, date, date);
  if (!leave) return null;

  const { count } = await db.shift.updateMany({
    where: {
      id: shiftId,
      employeeId,
      employee: { tenantId },
      conflictsWithLeave: false,
      deletedAt: null, // Phase 67.2 — never (re-)flag a soft-deleted row
    },
    data: { conflictsWithLeave: true },
  });
  if (count === 0) return null; // already flagged, soft-deleted, or a tenant/employee mismatch

  const shift = await db.shift.findFirst({
    where: { id: shiftId, employeeId, employee: { tenantId } },
    select: { date: true, startTime: true, endTime: true, label: true, salonId: true },
  });
  if (!shift) return null; // defensive; the updateMany above just touched this exact row

  return {
    shiftId,
    date: shift.date,
    startTime: shift.startTime,
    endTime: shift.endTime,
    label: shift.label,
    salonId: shift.salonId,
    leaveRequestId: leave.id,
    leaveStart: leave.startDate,
    leaveEnd: leave.endDate,
  };
}
