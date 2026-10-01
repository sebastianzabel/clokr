/**
 * Phase 430 (D-02) — the shared audit+notify half of Type-1 conflict detection ("Schicht auf
 * genehmigtem Urlaubstag"), extracted out of `contexts/absence/api/leave.ts:1719-1806` (the
 * leave-approval reverse-hook, Phase 43-04/100B Plan 05) so every direction that can produce a
 * newly-flagged conflicting shift — leave approval (S2, unchanged), the Phorest sync, and the
 * manual shift-planning routes (S4, new) — shares ONE implementation instead of three copies.
 *
 * Not a facade function: `lint-facade-signatures`'s D-07 rule requires every `contexts/*\/facade/`
 * export to take `db: Prisma.TransactionClient` as its only "context" parameter, because a facade
 * answers a pure data question. This helper calls `app.audit()`/`app.notify()` — orchestration that
 * belongs one level up, per the SAME rule `facade/shifts.ts`'s own module docblock states for S2's
 * caller-side audit loop. It therefore lives directly under `contexts/scheduling/`, re-exported via
 * `index.ts` for cross-context callers (`contexts/absence/api/leave.ts`) exactly like
 * `flagShiftsConflictingWithLeave` already is; same-context callers (`contexts/scheduling/api/
 * shifts.ts`, `services/phorest/sync-shifts.ts` — the latter counts as this context's own boundary
 * area, CLAUDE.md § Context Boundaries) import it by relative path, no index.ts round-trip needed.
 *
 * Recipients are resolved via the #367 salon-scope fix
 * (`userIdsHoldingPermission` + `resolveScopedHolderIds` + `isShiftInScope`,
 * `contexts/platform/facade/role-assignments.ts:450/579`) — the exact call shape `leave.ts` already
 * used before this extraction. No new permission, no new recipient logic.
 */
import type { FastifyInstance } from "fastify";
import { userIdsHoldingPermission, resolveScopedHolderIds, isShiftInScope } from "../platform";

export interface ShiftLeaveConflictParams {
  /** `req.user.sub` on the manual path; `undefined` on the Phorest-sync (cron/SYSTEM) path — mirrors
   *  `sync-shifts.ts`'s own `buildPhorestSafeAudit()` handling of the never-persisted SYSTEM sentinel. */
  actorUserId?: string;
  employeeId: string;
  tenantId: string;
  employeeName: { firstName: string; lastName: string };
  leaveRequestId: string;
  leaveStart: Date;
  leaveEnd: Date;
  conflictingShifts: Array<{ id: string; date: Date; label: string | null; salonId: string }>;
  /** Present on the manual (HTTP) path only; absent on the Phorest-sync path (no request context). */
  request?: { ip: string; headers: Record<string, string> };
}

/**
 * Audits every shift in `conflictingShifts` as `SHIFT_MARKED_CONFLICTING`, then resolves the
 * salon-scoped `shift:plan:ZUGEWIESEN` holders and sends each one ONE `SHIFT_LEAVE_CONFLICT`
 * notification (never one notification per shift — mirrors the leave-approval direction's own
 * "one notification summarizes the whole batch" behaviour). A no-op when `conflictingShifts` is
 * empty (nothing to audit or notify about). Best-effort throughout — an audit or notify failure is
 * logged and swallowed, never thrown, so a caller inside its own write transaction is never rolled
 * back by a notification-layer failure.
 */
export async function notifyShiftLeaveConflicts(
  app: FastifyInstance,
  params: ShiftLeaveConflictParams,
): Promise<void> {
  const {
    actorUserId,
    employeeId,
    tenantId,
    employeeName,
    leaveRequestId,
    leaveStart,
    leaveEnd,
    conflictingShifts,
    request,
  } = params;

  if (conflictingShifts.length === 0) return;

  for (const s of conflictingShifts) {
    await app
      .audit({
        userId: actorUserId,
        action: "SHIFT_MARKED_CONFLICTING",
        entity: "Shift",
        entityId: s.id,
        newValue: {
          leaveRequestId,
          leaveStart: leaveStart.toISOString().slice(0, 10),
          leaveEnd: leaveEnd.toISOString().slice(0, 10),
          shiftDate: s.date.toISOString().slice(0, 10),
          shiftLabel: s.label,
        },
        request,
      })
      .catch((err) =>
        app.log.warn({ err, shiftId: s.id }, "Failed to audit SHIFT_MARKED_CONFLICTING"),
      );
  }

  // Notify managers — find all shift:plan:ZUGEWIESEN holders in scope of the flagged shifts.
  try {
    const shiftPlanHolderIds = await userIdsHoldingPermission(
      app.prisma,
      tenantId,
      "shift:plan:ZUGEWIESEN",
    );
    // Phase 91b Plan 09 (Issue #91), D-11/D-17: narrow to holders whose OWN reach covers AT LEAST
    // ONE of the flagged conflicting shifts' salon(s) — one leave/conflict batch can touch several
    // salons, and this ONE notification summarizes all of them.
    const scopedShiftPlanHolderIds = await resolveScopedHolderIds(
      app.prisma,
      tenantId,
      shiftPlanHolderIds,
      "shift:plan:ZUGEWIESEN",
      (reach) =>
        conflictingShifts.some((s) => isShiftInScope(reach, { salonId: s.salonId, employeeId })),
    );
    const managers = await app.prisma.user.findMany({
      where: {
        isActive: true,
        id: { in: scopedShiftPlanHolderIds },
        employee: { tenantId },
      },
      select: { id: true },
    });
    const dStart = leaveStart.toLocaleDateString("de-DE");
    const dEnd = leaveEnd.toLocaleDateString("de-DE");
    for (const mgr of managers) {
      await app
        .notify({
          userId: mgr.id,
          type: "SHIFT_LEAVE_CONFLICT",
          title: `Schicht-Konflikt: ${employeeName.firstName} ${employeeName.lastName}`,
          message: `Genehmigter Urlaub vom ${dStart} bis ${dEnd} überschneidet sich mit ${conflictingShifts.length} Schicht(en). Bitte überprüfen Sie /shifts.`,
          link: "/shifts",
          tenantId,
          relatedType: "LeaveRequest",
          relatedId: leaveRequestId,
        })
        .catch((err) =>
          app.log.warn(
            { err, managerId: mgr.id },
            "Failed to notify manager of SHIFT_LEAVE_CONFLICT",
          ),
        );
    }
  } catch (err) {
    app.log.warn({ err }, "SHIFT_LEAVE_CONFLICT manager-notify pass failed");
  }
}
