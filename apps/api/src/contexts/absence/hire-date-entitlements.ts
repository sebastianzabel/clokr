/**
 * Issue #961 — the reaction of Abwesenheiten to a changed hire date (`Employee.hireDate`, Unterbau).
 *
 * The ONE place that decides what a moved hire date does to the person's `LeaveEntitlement` rows.
 * Invariant-carrying (ADR 0002 Entscheidung 10): `platform/api/employees.ts` calls it inside the
 * PATCH transaction right after the employee write, like the #447 exit-year sync, because the
 * booking check and the Resturlaub facade trust the persisted rows. A refusal
 * ({@link LeaveBeforeHireDateError}) rolls the whole hire-date change back.
 *
 * Rules, as built:
 * - Moving LATER is refused (409) while a non-deleted leave request that is pending or effective
 *   starts before the new hire day, or a row of a year before the new hire year has used days. Days
 *   already requested or taken cannot silently disappear; they are cancelled or corrected first.
 * - Every row (any leave type) of a year before the new hire year is set to `totalDays` 0 and
 *   `carriedOverDays` 0. Nothing is deleted. A person not employed in a year has no entitlement in
 *   it (§ 1, § 4, § 5 BUrlG), so this applies to human-written and past-year rows too; the
 *   `#447`/`#450` past-year and human-write guards protect values computed from correct inputs, and
 *   here the input itself was wrong. The audit row keeps the old value.
 * - Every existing VACATION row from the earlier to the later hire year plus one (the waiting
 *   period of § 4 BUrlG can reach into the following year) is recomputed to its regular value
 *   through {@link resolveRegularVacationDays}, the one formula; a row a human ever wrote
 *   (`hasHumanVacationWrite`) is left alone.
 * - Moving EARLIER creates the rows employee creation would have created (the new hire year and the
 *   tenant's current year, `employee-creation.ts`, Issue #416/#849) when they are missing; no
 *   intermediate year is invented.
 * - Finally the carry-over is recomputed year by year from the year after the earlier hire year
 *   through the newest existing VACATION row, through {@link recalculateCarryOver} (never creating
 *   a row), so a carry computed from a now-void year disappears.
 * Every change is audited with the acting user (the caller's `audit`) and the reason
 * {@link ENTITLEMENT_REASON_HIRE_DATE_CHANGED}.
 */
import { FastifyInstance } from "fastify";
import { Prisma } from "@clokr/db";
import type { EntitlementAuditEntry } from "./entitlement-audit";
import { EFFECTIVE_LEAVE_STATUSES } from "./effective-leave-statuses";
import { ensureVacationEntitlementForYear } from "./facade/entitlements";
import { getLeaveTypeByCode } from "./facade/leave-types";
import {
  daysDiffer,
  hasHumanVacationWrite,
  loadVacationContractSegments,
  recalculateCarryOver,
  resolveRegularVacationDays,
  resolveVacationBaseDays,
} from "./leave-days";

type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

/** Issue #961 — the audit reason of every entitlement change caused by a hire-date change. */
export const ENTITLEMENT_REASON_HIRE_DATE_CHANGED = "Eintrittsdatum geändert";

/** Issue #961 — the German 409 text (du-form) of a refused later hire date. */
export const LEAVE_BEFORE_HIRE_DATE_MESSAGE =
  "Das Eintrittsdatum kann nicht auf diesen Tag verschoben werden: Vor dem neuen Eintrittsdatum " +
  "liegen Urlaubs- oder Abwesenheitsanträge oder bereits genommener Urlaub. Storniere oder " +
  "korrigiere diese Anträge zuerst.";

/** Issue #961 — the control value of the 409, never the display text. */
export const LEAVE_BEFORE_HIRE_DATE_CODE = "LEAVE_BEFORE_HIRE_DATE";

/** Thrown inside the PATCH transaction; the route maps it to 409 and nothing is committed. */
export class LeaveBeforeHireDateError extends Error {
  constructor(
    readonly requestCount: number,
    readonly usedRowCount: number,
  ) {
    super("Leave lies before the new hire date");
    this.name = "LeaveBeforeHireDateError";
  }
}

/** Statuses of a request that still holds days: open or effective (CLAUDE.md, Issue #446). */
const HOLDING_STATUSES = ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] as const;

export interface HireDateChange {
  employeeId: string;
  tenantId: string;
  oldHireDate: Date;
  newHireDate: Date;
  /** The new hire date as a tenant-local calendar day, `YYYY-MM-DD`. */
  newHireDay: string;
  /** The tenant's current calendar year (tenant-local), the creation rule's second year. */
  currentYear: number;
}

/**
 * Issue #961 — must run AFTER the employee row carries the new hire date (the regular formula
 * reads it from there), on the same transaction client.
 */
export async function syncVacationEntitlementsForHireDateChange(
  db: Prisma.TransactionClient,
  change: HireDateChange,
  audit: (entry: EntitlementAuditEntry) => Promise<void>,
): Promise<{ changedEntitlementIds: string[] }> {
  const { employeeId, tenantId, oldHireDate, newHireDate } = change;
  if (oldHireDate.getTime() === newHireDate.getTime()) return { changedEntitlementIds: [] };

  // The same calendar-year convention as the regular formula's "employed in year" check.
  const oldYear = oldHireDate.getUTCFullYear();
  const newYear = newHireDate.getUTCFullYear();
  const movedLater = newHireDate.getTime() > oldHireDate.getTime();

  if (movedLater) await assertNoLeaveBeforeHireDate(db, change);

  const changed = new Set<string>();
  const reason = ENTITLEMENT_REASON_HIRE_DATE_CHANGED;

  // 1. Years before the new hire year carry nothing.
  const rows = await db.leaveEntitlement.findMany({
    where: { employeeId, employee: { tenantId } },
    orderBy: { year: "asc" },
  });
  for (const row of rows) {
    if (row.year >= newYear) continue;
    const oldTotal = Number(row.totalDays);
    const oldCarry = Number(row.carriedOverDays);
    if (oldTotal === 0 && oldCarry === 0) continue;
    const { count } = await db.leaveEntitlement.updateMany({
      where: { id: row.id, totalDays: row.totalDays, carriedOverDays: row.carriedOverDays },
      data: { totalDays: 0, carriedOverDays: 0 },
    });
    if (count === 1) {
      changed.add(row.id);
      await audit({
        action: "UPDATE",
        entityId: row.id,
        oldValue: { totalDays: oldTotal, carriedOverDays: oldCarry },
        newValue: { totalDays: 0, carriedOverDays: 0, reason },
      });
    }
  }

  const vacationType = await getLeaveTypeByCode(db, tenantId, "VACATION");
  if (!vacationType) return { changedEntitlementIds: [...changed] };

  // 2. Moving earlier: the rows employee creation would have created, when missing.
  if (!movedLater) {
    const years = [...new Set([newYear, Math.max(newYear, change.currentYear)])];
    const missing = years.filter(
      (y) => !rows.some((r) => r.leaveTypeId === vacationType.id && r.year === y),
    );
    if (missing.length > 0) {
      const employee = await db.employee.findFirstOrThrow({
        where: { id: employeeId, tenantId },
        select: { hireDate: true, birthDate: true, exitDate: true },
      });
      const segments = await loadVacationContractSegments(db, employeeId, tenantId);
      const baseDays = await resolveVacationBaseDays(db, employeeId, tenantId);
      for (const year of missing) {
        const result = await ensureVacationEntitlementForYear(
          db,
          employeeId,
          tenantId,
          year,
          employee.hireDate,
          employee.birthDate,
          employee.exitDate,
          segments,
          // An exit before this year leaves nothing to grant (same rule as the regular formula).
          employee.exitDate !== null && employee.exitDate.getUTCFullYear() < year ? 0 : baseDays,
          reason,
          (entry) =>
            audit({ action: entry.action, entityId: entry.entityId, newValue: entry.newValue }),
        );
        if (result?.created) changed.add(result.entitlement.id);
      }
    }
  }

  // 3. Recompute the regular value of every affected VACATION year (new hire year and later).
  const lo = Math.min(oldYear, newYear);
  const hi = Math.max(oldYear, newYear) + 1;
  const vacationRows = await db.leaveEntitlement.findMany({
    where: { employeeId, leaveTypeId: vacationType.id, employee: { tenantId } },
    orderBy: { year: "asc" },
  });
  for (const row of vacationRows) {
    if (row.year < newYear || row.year < lo || row.year > hi) continue;
    if (await hasHumanVacationWrite(db, row.id)) continue;
    const target = await resolveRegularVacationDays(db, employeeId, tenantId, row.year);
    const oldTotal = Number(row.totalDays);
    if (!daysDiffer(oldTotal, target)) continue;
    const { count } = await db.leaveEntitlement.updateMany({
      where: { id: row.id, totalDays: row.totalDays },
      data: { totalDays: target, isAutoCalculated: true },
    });
    if (count === 1) {
      changed.add(row.id);
      await audit({
        action: "UPDATE",
        entityId: row.id,
        oldValue: { totalDays: oldTotal },
        newValue: { totalDays: target, isAutoCalculated: true, reason },
      });
    }
  }

  // 4. The carry-over chain, ascending, so each year reads its corrected predecessor.
  const maxYear = vacationRows.reduce((m, r) => Math.max(m, r.year), lo);
  for (let year = lo + 1; year <= maxYear; year++) {
    await recalculateCarryOver(db, tenantId, employeeId, vacationType.id, year, {
      createIfMissing: false,
      reason,
      audit: async (entry) => {
        changed.add(entry.entityId);
        await audit(entry);
      },
    });
  }

  return { changedEntitlementIds: [...changed] };
}

async function assertNoLeaveBeforeHireDate(db: DbClient, change: HireDateChange): Promise<void> {
  const hireDay = new Date(`${change.newHireDay}T00:00:00.000Z`);
  const requestCount = await db.leaveRequest.count({
    where: {
      employeeId: change.employeeId,
      employee: { tenantId: change.tenantId },
      deletedAt: null,
      status: { in: [...HOLDING_STATUSES] },
      startDate: { lt: hireDay },
    },
  });
  const usedRowCount = await db.leaveEntitlement.count({
    where: {
      employeeId: change.employeeId,
      employee: { tenantId: change.tenantId },
      year: { lt: change.newHireDate.getUTCFullYear() },
      usedDays: { gt: 0 },
    },
  });
  if (requestCount > 0 || usedRowCount > 0) {
    throw new LeaveBeforeHireDateError(requestCount, usedRowCount);
  }
}
