/**
 * Phase 67b Plan 02 (issue #67) — the lock-checked WRITE surface for `EmployeeSalonAssignment`:
 * create an Einsatzsalon (DEPLOYMENT), change the Stammsalon (HOME), end an assignment.
 *
 * This module imports `isSnapshotLocked`/`monthRangeUtc`/`monthDayBounds` from
 * `../../working-time-account` (the barrel) — `contexts/platform/index.ts`'s own docblock forbids
 * transitively reaching another context, which is exactly why this module is a SEPARATE file from
 * `./salon-assignments` (the read facade, D-16/D-17) and is deliberately NOT re-exported from
 * `contexts/platform/index.ts`. Only `api/salon-assignments.ts` imports this module.
 *
 * Every exported function here MUST be called inside the caller's own `$transaction` (`db` is
 * always `Prisma.TransactionClient`) — the row locks below are released at the end of that
 * transaction, so calling one of these functions with a bare `PrismaClient` gives no protection
 * against the concurrent-write races D-02 exists to prevent.
 *
 * Rows are never deleted — the only permitted change to an EXISTING row is setting `validUntil`
 * (D-03/D-11). A row with `validUntil = validFrom − 1 day` is "voided": effective on no day.
 */
import type { Prisma } from "@clokr/db";
import { isSnapshotLocked, monthDayBounds, monthRangeUtc } from "../../working-time-account";
import {
  dayToDate,
  FAR_FUTURE_DAY,
  firstCommonWeekday,
  normalizeWeekdays,
  periodsOverlap,
  tenantLocalDay,
  type AssignmentRow,
  type CalendarDay,
} from "../salon-assignment-rules";
import { readTenantTimezone } from "./salon-assignments";

// ── Row locks (D-02) — always FIRST, before any invariant check ────────────────────────────────

/**
 * D-02: locks the employee row for the lifetime of the enclosing transaction and doubles as a
 * T-100-09-safe existence check — a foreign OR nonexistent id both return `null` from this ONE
 * query (`$queryRaw` tagged templates sit outside `lint-tenant-scoping`'s judged method set, same
 * as `salonExistsInForeignTenant`'s `NOT: { tenantId }` shape, so no scoping exception is needed).
 * Same lock shape as `services/clock/resolver.ts`'s per-employee lock, narrowed to `Employee`.
 */
async function lockEmployee(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
): Promise<{ id: string; hireDate: Date } | null> {
  const rows = await db.$queryRaw<{ id: string; hireDate: Date }[]>`
    SELECT "id", "hireDate" FROM "Employee" WHERE "id" = ${employeeId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * D-02: `FOR SHARE` on the target salon row — weaker than `deactivateSalon`'s `FOR UPDATE` over
 * every tenant salon, but strong enough to serialise against it: a concurrent `deactivateSalon()`
 * cannot commit its `FOR UPDATE` while this transaction still holds `FOR SHARE` on the same row, so
 * the two can never both believe they observed a stable salon state.
 */
async function lockSalonForShare(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
): Promise<{ id: string; isActive: boolean } | null> {
  const rows = await db.$queryRaw<{ id: string; isActive: boolean }[]>`
    SELECT "id", "isActive" FROM "Salon" WHERE "id" = ${salonId} AND "tenantId" = ${tenantId} FOR SHARE
  `;
  return rows[0] ?? null;
}

/**
 * D-12: widens `[firstDay, lastDay]` to full tenant-local CALENDAR months (never the raw instant
 * bounds `monthRangeUtc` alone would give — those are UTC instants that Postgres casts to the WRONG
 * date for a non-UTC tenant, see `monthDayBounds`'s own docblock for the exact prod bug class this
 * avoids), then asks `isSnapshotLocked` whether any locked `TimeEntry` falls inside that widened
 * window. An open end (`lastDay === null`) uses the {@link FAR_FUTURE_DAY} sentinel directly rather
 * than widening a sentinel year through `monthRangeUtc` — simpler, and avoids relying on far-future
 * `Date` arithmetic behaving sensibly.
 *
 * Inherits `isSnapshotLocked`'s own documented limitation (a closed month with zero time entries
 * does not register as locked) — the issue explicitly says to reuse that definition, not work
 * around it.
 */
async function touchesLockedMonth(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  firstDay: CalendarDay,
  lastDay: CalendarDay | null,
  tz: string,
): Promise<boolean> {
  const [fromYear, fromMonth] = firstDay.split("-").map(Number);
  const fromMonthInstant = monthRangeUtc(fromYear, fromMonth, tz).start;
  const from = monthDayBounds(fromMonthInstant, fromMonthInstant, tz).firstDay;

  let to: Date;
  if (lastDay === null) {
    to = dayToDate(FAR_FUTURE_DAY);
  } else {
    const [toYear, toMonth] = lastDay.split("-").map(Number);
    const toMonthInstant = monthRangeUtc(toYear, toMonth, tz).end;
    to = monthDayBounds(toMonthInstant, toMonthInstant, tz).lastDay;
  }

  return isSnapshotLocked(db, employeeId, tenantId, from, to);
}

// ── Outcome union (D-27) — a code, never a display string ──────────────────────────────────────

/**
 * The full set of codes every write function in this module can return. Task 2 (HOME change, end)
 * adds its own OK variants and failure codes on top of these. Never rendered directly — the ROUTE
 * maps each status to its own German message.
 */
export type SalonAssignmentOutcome =
  | { status: "OK_CREATED"; created: AssignmentRow }
  | { status: "EMPLOYEE_NOT_FOUND" }
  | { status: "SALON_NOT_FOUND" }
  | { status: "SALON_INACTIVE" }
  | { status: "BEFORE_HIRE_DATE" }
  | { status: "INVALID_PERIOD" }
  | { status: "SAME_SALON_OVERLAP" }
  | { status: "WEEKDAY_CONFLICT"; weekday: number }
  | { status: "MONTH_LOCKED" };

/** The statuses {@link createDeploymentAssignment} can return. */
export type CreateDeploymentOutcome = SalonAssignmentOutcome;

/**
 * AC-Einsatz-1/D-08..D-13, D-02, D-27: create a DEPLOYMENT (Einsatzsalon) assignment.
 *
 * Order (each check MUST run before the next, per D-08..D-13; the lock check is LAST before the
 * write): lock the employee row (existence + lock) → lock the target salon `FOR SHARE` (existence +
 * active) → resolve the tenant timezone and the employee's tenant-local hire date → validate the
 * period against the hire date and against itself → normalise the weekdays → load every one of the
 * employee's OWN assignment rows and check the same-salon overlap rule (D-09) across BOTH kinds,
 * then the weekday-conflict rule (D-10) across DEPLOYMENT rows only → check the closed-month lock
 * (D-12) → create.
 */
export async function createDeploymentAssignment(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  input: {
    salonId: string;
    validFrom: CalendarDay;
    validUntil: CalendarDay | null;
    weekdays: number[];
  },
): Promise<CreateDeploymentOutcome> {
  const employee = await lockEmployee(db, tenantId, employeeId);
  if (!employee) return { status: "EMPLOYEE_NOT_FOUND" };

  const salon = await lockSalonForShare(db, tenantId, input.salonId);
  if (!salon) return { status: "SALON_NOT_FOUND" };
  if (!salon.isActive) return { status: "SALON_INACTIVE" };

  const tz = await readTenantTimezone(db, tenantId);
  const hireLocal = tenantLocalDay(employee.hireDate, tz);
  if (input.validFrom < hireLocal) return { status: "BEFORE_HIRE_DATE" };
  if (input.validUntil !== null && input.validUntil < input.validFrom) {
    return { status: "INVALID_PERIOD" };
  }

  const weekdays = normalizeWeekdays(input.weekdays);
  const period = {
    validFrom: dayToDate(input.validFrom),
    validUntil: input.validUntil !== null ? dayToDate(input.validUntil) : null,
  };

  const existingRows = await db.employeeSalonAssignment.findMany({
    where: { tenantId, employeeId },
  });

  // D-09: same-salon overlap across BOTH kinds (a HOME-vs-DEPLOYMENT clash on the same salon is
  // rejected here too — periodsOverlap() already excludes voided rows on either side).
  const sameSalonOverlap = existingRows.some(
    (row) => row.salonId === input.salonId && periodsOverlap(row, period),
  );
  if (sameSalonOverlap) return { status: "SAME_SALON_OVERLAP" };

  // D-10: weekday conflict, DEPLOYMENT rows only.
  for (const row of existingRows) {
    if (row.kind !== "DEPLOYMENT" || !periodsOverlap(row, period)) continue;
    const commonWeekday = firstCommonWeekday(row.weekdays, weekdays);
    if (commonWeekday !== null) return { status: "WEEKDAY_CONFLICT", weekday: commonWeekday };
  }

  if (await touchesLockedMonth(db, tenantId, employeeId, input.validFrom, input.validUntil, tz)) {
    return { status: "MONTH_LOCKED" };
  }

  const created = await db.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId,
      salonId: input.salonId,
      kind: "DEPLOYMENT",
      validFrom: period.validFrom,
      validUntil: period.validUntil,
      weekdays,
    },
  });

  return { status: "OK_CREATED", created };
}
