/**
 * Phase 107 (D-14/D-15/D-16) — the single resolver every shift-mutating write path in
 * `apps/api/src/routes/shifts.ts` reports to after changing an employee's roster for a given
 * ISO week. Recomputes any APPROVED, provisional VACATION leave request's `days` from the
 * now-current roster, corrects the vacation entitlement by the delta, and leaves a full audit
 * trail — or does nothing at all when nothing actually changed.
 *
 * D-14 — ONE decision point. Every call site is a thin adapter: it derives
 * `(employeeId, affectedWeekStart, affectedWeekEnd)` from its own mutation and calls this
 * function inside its own transaction. No route re-implements any part of the guard chain
 * below (the clock-trigger-resolver pattern this codebase already uses elsewhere).
 *
 * D-15 — transaction-pure. `tx` MUST be the SAME `Prisma.TransactionClient` as the caller's
 * shift mutation. Every read and every write in this function goes through `tx`, never the
 * top-level Fastify-decorated Prisma client — so a failure here rolls back the shift mutation
 * that triggered it (fail-closed; see `shifts.ts`'s call sites for the transaction wrapping and
 * why they do NOT `.catch()` this call the way the neighbouring best-effort
 * `updateOvertimeAccount()` hook does).
 *
 * D-16 — the guard chain, all six conditions, in exactly one place:
 *   1. status = APPROVED
 *   2. daysProvisional = true
 *   3. same employeeId
 *   4. period overlaps [affectedWeekStart, affectedWeekEnd]
 *   5. period not entirely in the past (tenant-timezone "today")
 *   6. month not locked (isSnapshotLocked())
 * plus two structural guards CLAUDE.md requires regardless (deletedAt: null, tenant scope) and
 * one scope decision — VACATION type only — documented on VACATION_LEAVE_TYPE_NAME below.
 *
 * D-17 is a CONSEQUENCE of this guard set, not a separate mechanism: provisionality only ends
 * when the period elapses (guard 5) or the month locks (guard 6) — every roster change before
 * then keeps correcting the same request, because nothing here remembers "already adjusted
 * once". Do not add a "only adjust once" short-circuit; that would silently reintroduce the
 * exact staleness D-17 exists to prevent.
 */
import type { Prisma } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import { isSnapshotLocked } from "./snapshot-lock";
import { todayInTz } from "./timezone";

/**
 * Phase 107, D-16 scope decision: `daysProvisional` (D-10/D-11) and this whole feature
 * (D-05..D-21) are specified entirely in terms of "Urlaubsverbrauch" (vacation consumption) —
 * the D-13 "Restanspruch" entitlement correction and the D-19 notification wording in
 * `shifts.ts` both assume a VACATION request.
 *
 * `daysProvisional` CAN technically end up `true` on a non-VACATION request too: Phase 94's
 * generic correction branch (`PATCH /requests/:id` in `routes/leave.ts`) gates its
 * `daysProvisional` write only on the EMPLOYEE's schedule type being SHIFT_BASED, not on the
 * REQUEST's own leave type — so a SHIFT_BASED employee's corrected SICK/OVERTIME_COMP/etc.
 * request can carry `daysProvisional: true` too. Adjusting `LeaveEntitlement.usedDays` (a
 * VACATION-only concept — OVERTIME_COMP books hours on `OvertimeAccount`, every other type is
 * entitlement-neutral, see the correction branch's own comment) or sending a "Urlaubsverbrauch
 * angepasst" notice for one of those would be wrong on both counts. Scoped out here
 * deliberately, at the query, rather than silently mis-handled — logged as a discovered,
 * deliberately-out-of-scope gap in this phase's deferred-items.md.
 *
 * Mirrors `LEAVE_TYPE_DEFS.VACATION.name` in `routes/leave.ts` verbatim (not imported directly
 * — see the "Dependency surface" note below); pinned by a dedicated test in
 * `shift-leave-recalc.test.ts` so a future rename of that display name fails loudly here
 * instead of silently mis-scoping this resolver.
 */
const VACATION_LEAVE_TYPE_NAME = "Urlaub";

// ── Dependency surface ──────────────────────────────────────────────────────────────────────
// This file intentionally imports NOTHING from `routes/` — `resolveLeaveDays()`,
// `getHolidayMap()`, `deductVacationDays()` and `reverseVacationDays()` all already live in
// `routes/leave.ts` (D-04's single count/day resolution chain plus its established booking
// helpers) and are exported there for exactly this reuse (see each function's own "Exported"
// docblock note). `shifts.ts` imports them and passes them in here as `RecalcDeps`, so this
// utils/ module's own dependency surface stays free of any `routes/` import. Do NOT import from
// `../routes/leave` here — extend `RecalcDeps` instead; duplicating any of these four functions
// would recreate exactly the divergence D-04 exists to prevent.

export type ResolveLeaveDaysFn = (
  prisma: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  start: Date,
  end: Date,
  halfDay: boolean,
  holidays: Set<string>,
) => Promise<{ days: number; provisional: boolean }>;

export type GetHolidayMapFn = (
  prisma: Prisma.TransactionClient,
  tenantId: string,
  start: Date,
  end: Date,
) => Promise<Map<string, string>>;

export type DeductVacationDaysFn = (
  prisma: Prisma.TransactionClient,
  employeeId: string,
  leaveTypeId: string,
  startDate: Date,
  endDate: Date,
  totalDays: number,
  holidays: Set<string>,
  tenantId: string,
) => Promise<void>;

export type ReverseVacationDaysFn = (
  prisma: Prisma.TransactionClient,
  employeeId: string,
  leaveTypeId: string,
  startDate: Date,
  endDate: Date,
  totalDays: number,
  holidays: Set<string>,
  tenantId: string,
) => Promise<{ missingYears: number[] }>;

export interface RecalcDeps {
  resolveLeaveDays: ResolveLeaveDaysFn;
  getHolidayMap: GetHolidayMapFn;
  deductVacationDays: DeductVacationDaysFn;
  reverseVacationDays: ReverseVacationDaysFn;
  /**
   * D-20. The same `app.audit` decorator every route already uses; `tx` is passed explicitly
   * on the one call below so the row lands in the SAME transaction as the value change it
   * records — a rollback of the shift mutation rolls the audit row back too.
   */
  audit: FastifyInstance["audit"];
}

/**
 * One adjusted leave request, returned so the CALLER can fire D-19's notifications AFTER its
 * transaction commits — never from inside this function (see the closing note below the loop).
 */
export interface AdjustmentRecord {
  leaveRequestId: string;
  employeeId: string;
  employeeUserId: string;
  approverUserId: string | null;
  oldDays: number;
  newDays: number;
  direction: "up" | "down";
  startDate: Date;
  endDate: Date;
}

export async function recalcProvisionalLeaveForShiftChange(
  tx: Prisma.TransactionClient,
  deps: RecalcDeps,
  employeeId: string,
  tenantId: string,
  affectedWeekStart: Date,
  affectedWeekEnd: Date,
  actorUserId: string,
): Promise<AdjustmentRecord[]> {
  // D-16 guards 1-4 + CLAUDE.md soft-delete/tenant-scope + the VACATION-only scope decision
  // above, all in ONE query.
  const candidates = await tx.leaveRequest.findMany({
    where: {
      status: "APPROVED",
      daysProvisional: true,
      employeeId,
      deletedAt: null,
      employee: { tenantId },
      leaveType: { name: VACATION_LEAVE_TYPE_NAME },
      startDate: { lte: affectedWeekEnd },
      endDate: { gte: affectedWeekStart },
    },
    include: { employee: { select: { userId: true } } },
  });
  if (candidates.length === 0) return [];

  // D-16 guard 5 (AC-RC-04): tenant-timezone "today", never a bare `new Date()` comparison —
  // that misfires in the documented 00:00-02:00 UTC-vs-tenant-TZ window. Not
  // `getTenantTimezone()` (`./timezone`): that helper's signature is
  // `FastifyInstance["prisma"]`, not tx-compatible, and widening a utility dozens of unrelated
  // call sites share is out of this plan's scope. This is a plain, single-purpose read with
  // the SAME "Europe/Berlin" fallback that helper itself uses.
  const tenantConfigRow = await tx.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  const today = todayInTz(tenantConfigRow?.timezone ?? "Europe/Berlin");

  const results: AdjustmentRecord[] = [];

  for (const candidate of candidates) {
    // D-16 guard 5 / AC-RC-04 — period already fully in the past.
    if (candidate.endDate.getTime() < today.getTime()) continue;

    // D-16 guard 6 / AC-RC-05 — month locked. isSnapshotLocked() is the one canonical
    // definition of "locked" (see its own docblock's recorded limitation) — no second one is
    // hand-rolled here.

    // write depends on the previous one's committed state within the same tx.
    const locked = await isSnapshotLocked(tx, employeeId, candidate.startDate, candidate.endDate);
    if (locked) continue;

    // Recompute from the roster as it stands right now, inside this SAME transaction — sees
    // the shift mutation that triggered this call (D-15).
    const holidayMap = await deps.getHolidayMap(
      tx,
      tenantId,
      candidate.startDate,
      candidate.endDate,
    );
    const holidays = new Set(holidayMap.keys());
    const recomputed = await deps.resolveLeaveDays(
      tx,
      employeeId,
      tenantId,
      candidate.startDate,
      candidate.endDate,
      candidate.halfDay,
      holidays,
    );

    const oldDays = Number(candidate.days);
    const newDays = recomputed.days;

    // AC-RC-06 / no-op guard — a whole-week request (or any request the roster change did not
    // actually move) writes nothing, audits nothing, notifies nobody.
    if (newDays === oldDays) continue;

    const oldProvisional = candidate.daysProvisional;

    await tx.leaveRequest.update({
      where: { id: candidate.id },
      data: { days: newDays, daysProvisional: recomputed.provisional },
    });

    // D-13's entitlement correction — by the DELTA, not the full new/old total, so a request
    // already partly reflected in usedDays is corrected rather than double-booked.
    const delta = newDays - oldDays;
    if (delta > 0) {
      await deps.deductVacationDays(
        tx,
        employeeId,
        candidate.leaveTypeId,
        candidate.startDate,
        candidate.endDate,
        delta,
        holidays,
        tenantId,
      );
    } else {
      await deps.reverseVacationDays(
        tx,
        employeeId,
        candidate.leaveTypeId,
        candidate.startDate,
        candidate.endDate,
        -delta,
        holidays,
        tenantId,
      );
    }

    // D-20 — same transaction, so a rollback of the shift mutation rolls this audit row back
    // too (never a "the value changed but nothing recorded why" state).
    await deps.audit({
      userId: actorUserId,
      action: "LEAVE_DAYS_ADJUSTED",
      entity: "LeaveRequest",
      entityId: candidate.id,
      oldValue: { days: oldDays, daysProvisional: oldProvisional },
      newValue: {
        days: newDays,
        daysProvisional: recomputed.provisional,
        trigger: "Roster-Planung",
      },
      tx,
    });

    results.push({
      leaveRequestId: candidate.id,
      employeeId,
      employeeUserId: candidate.employee.userId,
      approverUserId: candidate.reviewedBy,
      oldDays,
      newDays,
      direction: newDays > oldDays ? "up" : "down",
      startDate: candidate.startDate,
      endDate: candidate.endDate,
    });
  }

  // D-19 — this function deliberately never calls the Fastify `notify` decorator. That plugin
  // takes no `tx` parameter and fires an email side effect; invoking it here, before the
  // caller's transaction has committed, could send a notice for a change that a later failure
  // in the SAME transaction then rolls back — a lie. The caller sends D-19's notifications
  // AFTER the transaction commits, from the AdjustmentRecord[] returned here.
  return results;
}
