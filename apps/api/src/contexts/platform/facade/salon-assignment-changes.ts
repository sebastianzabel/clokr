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
  addDays,
  dateToDay,
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
 * The full set of codes every write function in this module can return. Never rendered directly —
 * the ROUTE maps each status to its own German message.
 */
export type SalonAssignmentOutcome =
  | { status: "OK_CREATED"; created: AssignmentRow }
  | {
      status: "OK_HOME_CHANGED";
      ended: { before: AssignmentRow; after: AssignmentRow } | null;
      created: AssignmentRow;
    }
  | { status: "OK_ENDED"; before: AssignmentRow; after: AssignmentRow }
  | { status: "EMPLOYEE_NOT_FOUND" }
  | { status: "SALON_NOT_FOUND" }
  | { status: "SALON_INACTIVE" }
  | { status: "BEFORE_HIRE_DATE" }
  | { status: "INVALID_PERIOD" }
  | { status: "SAME_SALON_OVERLAP" }
  | { status: "WEEKDAY_CONFLICT"; weekday: number }
  | { status: "MONTH_LOCKED" }
  | { status: "HOME_OVERLAP" }
  | { status: "ALREADY_HOME" }
  | { status: "FIRST_HOME_NOT_AT_HIRE_DATE" }
  | { status: "ASSIGNMENT_NOT_FOUND" }
  | { status: "HOME_NEEDS_SUCCESSOR" }
  | { status: "END_BEFORE_START" }
  | { status: "ONLY_SHORTEN" };

/** The statuses {@link createDeploymentAssignment} can return. */
export type CreateDeploymentOutcome = Extract<
  SalonAssignmentOutcome,
  {
    status:
      | "OK_CREATED"
      | "EMPLOYEE_NOT_FOUND"
      | "SALON_NOT_FOUND"
      | "SALON_INACTIVE"
      | "BEFORE_HIRE_DATE"
      | "INVALID_PERIOD"
      | "SAME_SALON_OVERLAP"
      | "WEEKDAY_CONFLICT"
      | "MONTH_LOCKED";
  }
>;

/** The statuses {@link changeHomeSalon} can return. */
export type ChangeHomeSalonOutcome = Extract<
  SalonAssignmentOutcome,
  {
    status:
      | "OK_HOME_CHANGED"
      | "EMPLOYEE_NOT_FOUND"
      | "SALON_NOT_FOUND"
      | "SALON_INACTIVE"
      | "BEFORE_HIRE_DATE"
      | "HOME_OVERLAP"
      | "ALREADY_HOME"
      | "FIRST_HOME_NOT_AT_HIRE_DATE"
      | "SAME_SALON_OVERLAP"
      | "MONTH_LOCKED";
  }
>;

/** The statuses {@link endSalonAssignment} can return. */
export type EndSalonAssignmentOutcome = Extract<
  SalonAssignmentOutcome,
  {
    status:
      | "OK_ENDED"
      | "EMPLOYEE_NOT_FOUND"
      | "ASSIGNMENT_NOT_FOUND"
      | "HOME_NEEDS_SUCCESSOR"
      | "END_BEFORE_START"
      | "ONLY_SHORTEN"
      | "MONTH_LOCKED";
  }
>;

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

/**
 * AC-Stamm-3/AC-Stamm-4/D-05/D-06/D-09/D-12/D-13, D-02, D-27: change the Stammsalon (HOME) as of
 * `input.validFrom` (D). Gapless by construction — the open row's `validUntil` is set to `D − 1`
 * (voiding it when `D` equals its own `validFrom`, D-03) and the new open row `[D, null)` is
 * created, both inside the caller's transaction.
 *
 * Order: lock the employee → lock the target salon `FOR SHARE` → resolve the tenant timezone and
 * hire date → `D < hireLocal` → BEFORE_HIRE_DATE → load every one of the employee's rows → no HOME
 * row at all (legacy employee) requires `D === hireLocal`, else FIRST_HOME_NOT_AT_HIRE_DATE;
 * otherwise there MUST be exactly one open (validUntil null) HOME row by construction — its absence
 * despite HOME rows existing is an invariant violation, not a status this function can name, so it
 * throws → `D` before the open row's own `validFrom` → HOME_OVERLAP; the open row's salon already
 * equals the target → ALREADY_HOME (D-05: also when `D` equals the open row's own `validFrom` — a
 * void-and-recreate of the identical salon would write two rows for no observable change) → any
 * OTHER non-voided row with the same salon overlapping the new open-ended period `[D, ∞)` →
 * SAME_SALON_OVERLAP (D-09, across both kinds) → the closed-month lock (D-12, checked against the
 * new open-ended period) → write.
 */
export async function changeHomeSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  input: { salonId: string; validFrom: CalendarDay },
): Promise<ChangeHomeSalonOutcome> {
  const employee = await lockEmployee(db, tenantId, employeeId);
  if (!employee) return { status: "EMPLOYEE_NOT_FOUND" };

  const salon = await lockSalonForShare(db, tenantId, input.salonId);
  if (!salon) return { status: "SALON_NOT_FOUND" };
  if (!salon.isActive) return { status: "SALON_INACTIVE" };

  const tz = await readTenantTimezone(db, tenantId);
  const hireLocal = tenantLocalDay(employee.hireDate, tz);
  if (input.validFrom < hireLocal) return { status: "BEFORE_HIRE_DATE" };

  const existingRows = await db.employeeSalonAssignment.findMany({
    where: { tenantId, employeeId },
  });
  const homeRows = existingRows.filter((row) => row.kind === "HOME");
  const openHome = homeRows.find((row) => row.validUntil === null) ?? null;

  if (homeRows.length === 0) {
    if (input.validFrom !== hireLocal) return { status: "FIRST_HOME_NOT_AT_HIRE_DATE" };
  } else {
    if (!openHome) {
      // Invariant violation, not a user-facing status: by construction (this function is the
      // ONLY writer of HOME rows) there is always exactly one open HOME row once any exist.
      throw new Error(
        "EmployeeSalonAssignment invariant violation (D-05): employee has HOME rows but none is " +
          "open (validUntil null) — expected exactly one open HOME row per employee.",
      );
    }
    const openValidFromDay = dateToDay(openHome.validFrom);
    if (input.validFrom < openValidFromDay) return { status: "HOME_OVERLAP" };
    if (openHome.salonId === input.salonId) return { status: "ALREADY_HOME" };
  }

  const newPeriod = { validFrom: dayToDate(input.validFrom), validUntil: null };
  const sameSalonOverlap = existingRows.some(
    (row) =>
      row.id !== openHome?.id && row.salonId === input.salonId && periodsOverlap(row, newPeriod),
  );
  if (sameSalonOverlap) return { status: "SAME_SALON_OVERLAP" };

  if (await touchesLockedMonth(db, tenantId, employeeId, input.validFrom, null, tz)) {
    return { status: "MONTH_LOCKED" };
  }

  let ended: { before: AssignmentRow; after: AssignmentRow } | null = null;
  if (openHome) {
    const after = await db.employeeSalonAssignment.update({
      where: { id: openHome.id, tenantId },
      data: { validUntil: dayToDate(addDays(input.validFrom, -1)) },
    });
    ended = { before: openHome, after };
  }

  const created = await db.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId,
      salonId: input.salonId,
      kind: "HOME",
      validFrom: newPeriod.validFrom,
      validUntil: null,
      weekdays: [],
    },
  });

  return { status: "OK_HOME_CHANGED", ended, created };
}

/**
 * AC-Stamm-4/D-06/D-11/D-12, D-02, D-27: end an assignment at `validUntil` (T). Ending only ever
 * SHORTENS a row — extending or reopening is rejected. `T = validFrom − 1` voids the row (D-03).
 *
 * Order: lock the employee → read ONLY the row's `salonId` via a TRIPLE-scoped lookup (`id`,
 * `tenantId`, `employeeId` — a row belonging to another employee is indistinguishable from none,
 * same T-100-09 shape as a foreign tenant's row) → ASSIGNMENT_NOT_FOUND → lock that salon
 * `FOR SHARE` (uniform lock order employee → salon, so a concurrent `deactivateSalon()` cannot
 * deadlock against this update) → RE-READ the row → every check below runs on that fresh row →
 * `kind === "HOME"` → HOME_NEEDS_SUCCESSOR (D-06) → `T < validFrom − 1` → END_BEFORE_START → the
 * row is not already open-ended AND `T >=` its current `validUntil` → ONLY_SHORTEN → the
 * closed-month lock (D-12, over the days the shortening actually removes: `(T, oldValidUntil]`) →
 * write (`validUntil` is the ONLY field this ever changes).
 *
 * Why the re-read (review CR-01): `deactivateSalon()` never locks the Employee row — it holds
 * `FOR UPDATE` on the tenant's Salon rows and then ends this salon's deployments directly. A row
 * read BEFORE the salon lock is a READ COMMITTED snapshot that may predate a deactivation which
 * commits while this transaction waits for `FOR SHARE`; checking ONLY_SHORTEN against that stale
 * copy would let this update re-extend (or un-void) a deployment the deactivation just ended, and
 * the END audit row would record a false `oldValue`. The statement after the lock takes a fresh
 * snapshot and so sees the committed deactivation. The row itself is deliberately NOT locked
 * `FOR UPDATE` before the salon: the deactivation holds the salon and wants the row, so that order
 * would deadlock.
 */
export async function endSalonAssignment(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  assignmentId: string,
  validUntil: CalendarDay,
): Promise<EndSalonAssignmentOutcome> {
  const employee = await lockEmployee(db, tenantId, employeeId);
  if (!employee) return { status: "EMPLOYEE_NOT_FOUND" };

  const probe = await db.employeeSalonAssignment.findFirst({
    where: { id: assignmentId, tenantId, employeeId },
    select: { salonId: true },
  });
  if (!probe) return { status: "ASSIGNMENT_NOT_FOUND" };

  await lockSalonForShare(db, tenantId, probe.salonId);

  // Review CR-01: a fresh READ COMMITTED snapshot AFTER the salon lock — sees the validUntil a
  // concurrent, now committed deactivation wrote. Every check and the audit `before` use THIS row.
  const row = await db.employeeSalonAssignment.findFirst({
    where: { id: assignmentId, tenantId, employeeId },
  });
  if (!row) return { status: "ASSIGNMENT_NOT_FOUND" };

  if (row.kind === "HOME") return { status: "HOME_NEEDS_SUCCESSOR" };

  const validFromDay = dateToDay(row.validFrom);
  const minEnd = addDays(validFromDay, -1);
  if (validUntil < minEnd) return { status: "END_BEFORE_START" };

  if (row.validUntil !== null) {
    const currentEndDay = dateToDay(row.validUntil);
    if (validUntil >= currentEndDay) return { status: "ONLY_SHORTEN" };
  }

  const tz = await readTenantTimezone(db, tenantId);
  const lockFrom = addDays(validUntil, 1);
  const lockTo = row.validUntil !== null ? dateToDay(row.validUntil) : null;
  if (await touchesLockedMonth(db, tenantId, employeeId, lockFrom, lockTo, tz)) {
    return { status: "MONTH_LOCKED" };
  }

  const after = await db.employeeSalonAssignment.update({
    where: { id: assignmentId, tenantId },
    data: { validUntil: dayToDate(validUntil) },
  });

  return { status: "OK_ENDED", before: row, after };
}
