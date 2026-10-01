/**
 * Phase 430 (D-05..D-07) — Type-2 conflict: a SHIFT_BASED person scheduled on more distinct days
 * in an ISO week than her contract allows once approved leave and other absences that week are
 * subtracted. Unlike Type 1 (`shift-leave-conflict-notify.ts`), there is no single `Shift` row a
 * week-level aggregate conflict naturally attaches to — no schema change, no persisted conflict
 * state. Detection is computed LIVE (`detectWeekCapacityConflict`); idempotency for the
 * notification is achieved purely via a query against the existing `Notification` model
 * (`notifyWeekCapacityConflictOnce`) — never a new table (D-06).
 *
 * Not a facade function: `detectWeekCapacityConflict` DOES take `db: Prisma.TransactionClient`
 * first (so it satisfies `lint-facade-signatures`' shape), but it lives here rather than under
 * `./facade/` because `notifyWeekCapacityConflictOnce` — its constant companion, taking
 * `app: FastifyInstance` for `app.prisma`/`app.notify()` — cannot live under `./facade/` at all
 * (D-07 of that directory forbids an `app` parameter). Keeping detect+notify in one file mirrors
 * `shift-leave-conflict-notify.ts`'s own module shape for the Type-1 direction.
 *
 * Recipients are resolved via the SAME #367 salon-scope fix
 * (`userIdsHoldingPermission` + `resolveScopedHolderIds` + `isShiftInScope`,
 * `contexts/platform/facade/role-assignments.ts:450/579`) `shift-leave-conflict-notify.ts` already
 * uses for Type 1 — no new permission, no new recipient logic.
 *
 * Phase 430-06 (follow-up to #437/#429): `leaveDays` below (via `getShiftBasedLeaveDaysForWeek`)
 * now uses the EXACT same per-week kernel (`leaveDaysPerWeek()`, Issue #429 D-01/D-02) the saldo
 * side uses, and — deliberately — counts every approved leave TYPE including SICK/SICK_CHILD/
 * SPECIAL, regardless of Issue #429's `leaveCreditBasisForCode()` CONTRACT/ROSTER payroll split.
 * See `leave-days.ts`'s own docblock on `getShiftBasedLeaveDaysForWeek` for the full reasoning —
 * this is a scheduling question ("still need a shift?"), not the payroll question #429 answers.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import {
  userIdsHoldingPermission,
  resolveScopedHolderIds,
  isShiftInScope,
  type EmployeeScope,
} from "../platform";
import {
  resolveContractWorkDaysPerWeek,
  getShiftBasedLeaveDaysForWeek,
  getAbsencesOverlapping,
} from "../absence"; // Phase 430 (D-08) — the additive absence-context exports
import { getShiftsInRange } from "./facade/shifts"; // same context, relative import — no index.ts round-trip needed

export interface WeekCapacityConflict {
  contractDays: number;
  leaveDays: number;
  otherAbsenceDays: number;
  scheduledDays: number;
  overbookedBy: number;
}

/**
 * Detects a Type-2 overbooking for exactly one employee's one ISO week (Mon..Sun,
 * `weekStart`/`weekEnd` as UTC-midnight Dates spanning that week). Only meaningful for
 * SHIFT_BASED employees — the CALLER is responsible for that filter (mirrors how
 * `resolveLeaveDays()` branches on schedule type; this function does not check it itself).
 *
 * `overbookedBy = scheduledDays - max(0, contractDays - leaveDays - otherAbsenceDays)`. Returns
 * `null` when `overbookedBy <= 0` (no conflict), else the full breakdown so the caller (the
 * notification text, and `GET /shifts/conflicts`'s `weekOverbooked` bucket) can show its numbers
 * without a second query.
 */
export async function detectWeekCapacityConflict(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<WeekCapacityConflict | null> {
  const scope: EmployeeScope = { kind: "employee", employeeId, tenantId };

  const [contractDays, leaveResult, absences, shifts] = await Promise.all([
    resolveContractWorkDaysPerWeek(db, employeeId, tenantId),
    getShiftBasedLeaveDaysForWeek(db, employeeId, tenantId, weekStart, weekEnd),
    getAbsencesOverlapping(db, scope, weekStart, weekEnd),
    getShiftsInRange(db, scope, weekStart, weekEnd),
  ]);

  const leaveDays = leaveResult.days;

  // Distinct Mon-Sat calendar days covered by an absence, excluding Sunday (never a Werktag —
  // mirrors getShiftBasedLeaveDaysForWeek's own § 3 Abs. 2 BUrlG exclusion). No further exclusion
  // against leaveDays is needed: a `LeaveRequest` (requested absence) and an `Absence` (imposed
  // absence) are disjoint by construction (CLAUDE.md § Context Boundaries — "Absence is NEVER a
  // TimeEntryType" / LeaveRequest vs. Absence split), so the two day sets cannot double-count the
  // same day in normal operation; this defensive note replaces a redundant runtime check.
  const otherAbsenceDayStrings = new Set<string>();
  for (const absence of absences) {
    const clipStart = absence.startDate > weekStart ? absence.startDate : weekStart;
    const clipEnd = absence.endDate < weekEnd ? absence.endDate : weekEnd;
    for (
      const d = new Date(clipStart);
      d.getTime() <= clipEnd.getTime();
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      if (d.getUTCDay() === 0) continue; // Sunday never a Werktag
      otherAbsenceDayStrings.add(d.toISOString().slice(0, 10));
    }
  }
  const otherAbsenceDays = otherAbsenceDayStrings.size;

  const scheduledDayStrings = new Set(shifts.map((s) => s.date.toISOString().slice(0, 10)));
  const scheduledDays = scheduledDayStrings.size;

  const allowed = Math.max(0, contractDays - leaveDays - otherAbsenceDays);
  const overbookedBy = scheduledDays - allowed;
  if (overbookedBy <= 0) return null;

  return { contractDays, leaveDays, otherAbsenceDays, scheduledDays, overbookedBy };
}

export interface NotifyWeekCapacityConflictParams {
  employeeId: string;
  tenantId: string;
  employeeName: { firstName: string; lastName: string };
  weekStart: Date;
  salonId: string;
  conflict: WeekCapacityConflict;
}

/**
 * The D-06 idempotency check: before creating a new `SHIFT_WEEK_OVERBOOKED` notification for a
 * recipient, look for an existing, not-yet-dismissed `Notification` row with the SAME
 * `relatedType`/`relatedId` for that same recipient — skip if found. `relatedId` is
 * `"<employeeId>:<weekStartISO>"`, so a conflict that persists across several Phorest sync runs
 * (or several manual-planning writes) produces exactly ONE notification per still-unresolved
 * (employeeId, week); dismissing it re-arms the check for the next run (D-06's own "not a
 * permanent per-week block" requirement).
 *
 * No audit row here (Claude's discretion, CONTEXT.md leaves this open) — nothing is MUTATED by
 * this pure detection (unlike Type 1's `Shift.conflictsWithLeave` flip), so there is no
 * before/after state change for Revisionssicherheit to record; the Notification row itself is
 * already the durable record of "this was surfaced".
 */
export async function notifyWeekCapacityConflictOnce(
  app: FastifyInstance,
  params: NotifyWeekCapacityConflictParams,
): Promise<void> {
  const { employeeId, tenantId, employeeName, weekStart, salonId, conflict } = params;
  const relatedId = `${employeeId}:${weekStart.toISOString().slice(0, 10)}`;

  try {
    const shiftPlanHolderIds = await userIdsHoldingPermission(
      app.prisma,
      tenantId,
      "shift:plan:ZUGEWIESEN",
    );
    const scopedShiftPlanHolderIds = await resolveScopedHolderIds(
      app.prisma,
      tenantId,
      shiftPlanHolderIds,
      "shift:plan:ZUGEWIESEN",
      (reach) => isShiftInScope(reach, { salonId, employeeId }),
    );
    const managers = await app.prisma.user.findMany({
      where: {
        isActive: true,
        id: { in: scopedShiftPlanHolderIds },
        employee: { tenantId },
      },
      select: { id: true },
    });

    const weekStartDe = weekStart.toLocaleDateString("de-DE");
    const allowed = conflict.contractDays - conflict.leaveDays - conflict.otherAbsenceDays;

    for (const mgr of managers) {
      const already = await app.prisma.notification.findFirst({
        where: {
          userId: mgr.id,
          type: "SHIFT_WEEK_OVERBOOKED",
          relatedType: "ShiftWeekConflict",
          relatedId,
          dismissedAt: null,
        },
      });
      if (already) continue;

      await app
        .notify({
          userId: mgr.id,
          type: "SHIFT_WEEK_OVERBOOKED",
          title: `Wochenkapazität überschritten: ${employeeName.firstName} ${employeeName.lastName}`,
          message: `In der Woche ab ${weekStartDe} sind ${conflict.scheduledDays} Schichttage geplant, Vertrag − Urlaub − Abwesenheit erlaubt nur ${allowed}. Bitte überprüfen Sie /shifts.`,
          link: "/shifts",
          tenantId,
          relatedType: "ShiftWeekConflict",
          relatedId,
        })
        .catch((err) =>
          app.log.warn(
            { err, managerId: mgr.id, employeeId },
            "Failed to notify manager of SHIFT_WEEK_OVERBOOKED",
          ),
        );
    }
  } catch (err) {
    app.log.warn({ err, employeeId }, "SHIFT_WEEK_OVERBOOKED manager-notify pass failed");
  }
}
