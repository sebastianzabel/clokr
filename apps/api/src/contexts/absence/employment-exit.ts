/**
 * Issue #614 — the ONE place the rule "no absence outlives the employment" lives.
 *
 * DSGVO anonymization (`DELETE /api/v1/employees/:id`) ends the employment (D-01: it sets the exit
 * date when empty). From the exit day on, no absence of the person may stay in force: a leave
 * request is a release from the duty to work inside an existing employment (§ 1, § 7 Abs. 1
 * BUrlG), and after the employment ends no release can be granted (untaken leave is compensated,
 * § 7 Abs. 4 BUrlG). The decision recorded on the issue (D-02):
 *
 *   - a request starting AFTER the exit day is CANCELLED by status change (never deleted); an
 *     approved one is booked back exactly as an approved cancellation books it;
 *   - a request spanning the exit day is SHORTENED to the exit day, never cancelled (later plans);
 *   - imposed absences after the exit day are soft-deleted (later plans);
 *   - a row whose changed days touch a CLOSED month is never touched, only reported (`skipped`).
 *
 * This file covers every absence lying wholly after the exit day: PENDING, APPROVED and
 * CANCELLATION_REQUESTED requests of every leave type (an approved or cancellation-requested one is
 * booked back exactly as an approved cancellation books it) and the imposed Berufsschule rows.
 * Plans 03-04 add the shortening of a request that spans the exit day.
 *
 * Contract — three phases, so the Unterbau route can run them around its own transaction:
 *   1. {@link planEmploymentExit}   pure reads, BEFORE the transaction opens;
 *   2. {@link applyEmploymentExit}  every write plus ONE audit row per changed row, INSIDE the
 *                                    anonymization transaction (a refused anonymization rolls
 *                                    all of it back);
 *   3. {@link afterEmploymentExit}  reactive (ADR 0002 Entscheidung 10), AFTER the commit: snapshot
 *                                    and overtime-balance recompute, notification dismissal. Logs
 *                                    failures, never throws.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts`: the Unterbau must not import a
 * business context, and an index re-export would grow the 22-module import cycle. The route
 * reaches it through the `app.absenceExit` decoration (`plugins/employment-exit-decorate.ts`),
 * registered by the composition root — the Issue #451 D-07 precedent (`vacation-balance-decorate`).
 *
 * Audit values carry NO free text: only ids, status, dates (`YYYY-MM-DD`), the day count and the
 * leave type CODE. `auditReason` is the human-readable German reason, `trigger` the machine marker.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import {
  computeOvertimeBalanceHours,
  getTenantTimezone,
  persistOvertimeBalance,
  recalculateSnapshots,
  reverseOvertimeCompensation,
} from "../working-time-account";
import { revalidateLeaveCancellationEntries } from "../time-tracking";
import { findClosedMonthsInRange } from "./closed-month-guard";
import { getHolidayMap, reverseVacationDays } from "./leave-days";
import { overtimeCompReversalMinutes } from "./overtime-comp-minutes";
import { activeParentalReductions } from "./parental-leave-reduction";

export interface EmploymentExitInput {
  tenantId: string;
  employeeId: string;
  /** UTC midnight of the exit day (the convention of stored `Employee.exitDate` values). */
  exitDay: Date;
}

/** One row the exit did not touch, reported in the ANONYMIZE audit (ids and codes only). */
export interface EmploymentExitSkipped {
  entity: "LeaveRequest" | "Absence";
  id: string;
  /** UPPER_SNAKE reason code. */
  reason: string;
}

type OpenLeaveStatus = "PENDING" | "APPROVED" | "CANCELLATION_REQUESTED";

/** A leave request lying wholly after the exit day: cancel it and book back what it booked. */
interface CancelLeaveAction {
  kind: "cancelLeave";
  requestId: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  days: number;
  /** Optimistic guard: the row must still look like this inside the transaction. */
  guard: { status: OpenLeaveStatus; startDate: Date; endDate: Date; updatedAt: Date };
  /** Holiday dates of the request range (VACATION only), read before the transaction. */
  holidayDates: string[];
  /** The amount to give back for an OVERTIME_COMP booking (stored, else recomputed); else null. */
  overtimeReversal: { minutes: number; source: "stored" | "recomputed" } | null;
}

/** An imposed absence (Berufsschule) lying wholly after the exit day: soft-delete it. */
interface DeleteAbsenceAction {
  kind: "deleteAbsence";
  absenceId: string;
  type: string;
  source: string;
  days: number;
  guard: { startDate: Date; endDate: Date };
}

export type EmploymentExitAction = CancelLeaveAction | DeleteAbsenceAction;

export interface EmploymentExitPlan {
  input: EmploymentExitInput;
  actions: EmploymentExitAction[];
  skipped: EmploymentExitSkipped[];
}

export interface EmploymentExitResult {
  input: EmploymentExitInput;
  /** Ids of requests cancelled by status change. */
  cancelled: string[];
  /** Ids of requests shortened to the exit day. */
  shortened: string[];
  /** Ids of imposed absences soft-deleted. */
  deleted: string[];
  skipped: EmploymentExitSkipped[];
  /** Earliest calendar day any changed row touched, or null when nothing changed. */
  changedFrom: Date | null;
}

/** Writes one audit row; the route binds this to `app.audit` with the request's actor fields. */
export type EmploymentExitAuditPort = (entry: {
  action: string;
  entity: string;
  entityId: string;
  oldValue?: object;
  newValue?: object;
}) => Promise<void>;

/** Thrown inside the transaction when a planned row changed meanwhile; the route answers 409. */
export class EmploymentExitConflictError extends Error {
  readonly code = "EMPLOYMENT_EXIT_CONFLICT";
  constructor(entity: string, id: string) {
    super(`employment exit: ${entity} ${id} changed concurrently`);
  }
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Phase 1 — pure reads. Decides what the exit cancels and what it must leave alone. */
export async function planEmploymentExit(
  prisma: FastifyInstance["prisma"],
  input: EmploymentExitInput,
  log?: Pick<FastifyBaseLogger, "warn">,
): Promise<EmploymentExitPlan> {
  const { tenantId, employeeId, exitDay } = input;
  const actions: EmploymentExitAction[] = [];
  const skipped: EmploymentExitSkipped[] = [];

  // ── Leave requests wholly after the exit day (all open statuses, every leave type) ──────────
  const requests = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      employee: { tenantId },
      deletedAt: null,
      status: { in: ["PENDING", "APPROVED", "CANCELLATION_REQUESTED"] },
      startDate: { gt: exitDay },
    },
    select: {
      id: true,
      leaveTypeId: true,
      status: true,
      days: true,
      halfDay: true,
      overtimeCompMinutes: true,
      startDate: true,
      endDate: true,
      updatedAt: true,
      leaveType: { select: { code: true } },
    },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });

  const tz = requests.length > 0 ? await getTenantTimezone(prisma, tenantId) : "UTC";
  for (const row of requests) {
    // Skip precedence (one reason per row): D-05 closed month, then the § 17 BEEG reduction, then
    // a live § 9 credit. The row stays as it is and is reported instead.
    const closed = await findClosedMonthsInRange(
      prisma,
      employeeId,
      tenantId,
      row.startDate,
      row.endDate,
    );
    if (closed.length > 0) {
      skipped.push({ entity: "LeaveRequest", id: row.id, reason: "CLOSED_MONTH" });
      continue;
    }
    if (row.leaveType.code === "PARENTAL") {
      const reductions = await activeParentalReductions(prisma, row.id, tenantId);
      if (reductions.length > 0) {
        skipped.push({ entity: "LeaveRequest", id: row.id, reason: "PARENTAL_REDUCTION_ACTIVE" });
        continue;
      }
    }
    const credit = await prisma.section9Credit.findFirst({
      where: {
        employeeId,
        employee: { tenantId },
        status: { not: "SUPERSEDED" },
        OR: [{ vacationRequestId: row.id }, { sickRequestId: row.id }],
      },
      select: { id: true },
    });
    if (credit) {
      skipped.push({ entity: "LeaveRequest", id: row.id, reason: "SECTION9_CREDIT_ACTIVE" });
      continue;
    }

    // A PENDING request booked nothing; every other status reverses what its approval booked.
    const booked = row.status !== "PENDING";
    const code = row.leaveType.code;
    let holidayDates: string[] = [];
    if (booked && code === "VACATION") {
      const holidays = await getHolidayMap(
        prisma,
        tenantId,
        employeeId,
        row.startDate,
        row.endDate,
      );
      holidayDates = [...holidays.keys()];
    }
    let overtimeReversal: CancelLeaveAction["overtimeReversal"] = null;
    if (booked && code === "OVERTIME_COMP") {
      // Issue #468 (A-4/D-02): the STORED booking is reversed; only a legacy row is recomputed.
      overtimeReversal = await overtimeCompReversalMinutes(
        prisma,
        tenantId,
        { ...row, employeeId },
        async () => {
          const holidays = await getHolidayMap(
            prisma,
            tenantId,
            employeeId,
            row.startDate,
            row.endDate,
          );
          return { holidays: new Set(holidays.keys()), tz };
        },
      );
      if (overtimeReversal.source === "recomputed") {
        log?.warn(
          { leaveRequestId: row.id, employeeId },
          "OVERTIME_COMP reversal without a stored booking — recomputed (Issue #468 A-4 legacy fallback)",
        );
      }
    }
    actions.push({
      kind: "cancelLeave",
      requestId: row.id,
      leaveTypeId: row.leaveTypeId,
      leaveTypeCode: code,
      days: Number(row.days),
      guard: {
        status: row.status as OpenLeaveStatus,
        startDate: row.startDate,
        endDate: row.endDate,
        updatedAt: row.updatedAt,
      },
      holidayDates,
      overtimeReversal,
    });
  }

  // ── Imposed absences (Berufsschule) ──────────────────────────────────────────────────────────
  const absences = await prisma.absence.findMany({
    where: {
      employeeId,
      employee: { tenantId },
      deletedAt: null,
      endDate: { gt: exitDay },
    },
    select: {
      id: true,
      type: true,
      source: true,
      days: true,
      startDate: true,
      endDate: true,
    },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  for (const row of absences) {
    if (row.startDate <= exitDay) {
      // No correction mechanism exists for a multi-day Absence; none exists today either.
      skipped.push({ entity: "Absence", id: row.id, reason: "SPANNING_ABSENCE" });
      continue;
    }
    const closed = await findClosedMonthsInRange(
      prisma,
      employeeId,
      tenantId,
      row.startDate,
      row.endDate,
    );
    if (closed.length > 0) {
      skipped.push({ entity: "Absence", id: row.id, reason: "CLOSED_MONTH" });
      continue;
    }
    actions.push({
      kind: "deleteAbsence",
      absenceId: row.id,
      type: row.type,
      source: row.source,
      days: Number(row.days),
      guard: { startDate: row.startDate, endDate: row.endDate },
    });
  }

  return { input, actions, skipped };
}

/** Phase 2 — writes and audits, inside the caller's (anonymization) transaction. */
export async function applyEmploymentExit(
  tx: Prisma.TransactionClient,
  plan: EmploymentExitPlan,
  audit: EmploymentExitAuditPort,
): Promise<EmploymentExitResult> {
  const result: EmploymentExitResult = {
    input: plan.input,
    cancelled: [],
    shortened: [],
    deleted: [],
    skipped: [...plan.skipped],
    changedFrom: null,
  };
  const touch = (day: Date) => {
    if (result.changedFrom === null || day < result.changedFrom) result.changedFrom = day;
  };

  for (const action of plan.actions) {
    if (action.kind === "deleteAbsence") {
      await deleteAbsence(tx, plan.input, action, audit);
      result.deleted.push(action.absenceId);
      touch(action.guard.startDate);
      continue;
    }
    await cancelLeave(tx, plan.input, action, audit);
    result.cancelled.push(action.requestId);
    touch(action.guard.startDate);
  }

  return result;
}

/** Cancels one request and books back exactly what an approved cancellation books back. */
async function cancelLeave(
  tx: Prisma.TransactionClient,
  input: EmploymentExitInput,
  action: CancelLeaveAction,
  audit: EmploymentExitAuditPort,
): Promise<void> {
  const { tenantId, employeeId, exitDay } = input;
  const marker = { auditReason: "Anonymisierung", trigger: "ANONYMIZATION" } as const;

  // The anonymization is not a review: no reviewedBy / reviewNote change. The guard makes the
  // update an optimistic lock — 0 rows means the request changed between plan and apply.
  const { count } = await tx.leaveRequest.updateMany({
    where: {
      id: action.requestId,
      employeeId,
      employee: { tenantId },
      deletedAt: null,
      status: action.guard.status,
      startDate: action.guard.startDate,
      endDate: action.guard.endDate,
      updatedAt: action.guard.updatedAt,
    },
    data: { status: "CANCELLED" },
  });
  if (count !== 1) throw new EmploymentExitConflictError("LeaveRequest", action.requestId);

  if (action.guard.status !== "PENDING") {
    // Time entries created while a cancellation was pending become valid again (as the approval
    // does), one UPDATE audit per revalidated row (Issue #370, D-04).
    const revalidated = await revalidateLeaveCancellationEntries(
      tx,
      employeeId,
      tenantId,
      action.guard.startDate,
      action.guard.endDate,
    );
    for (const row of revalidated) {
      await audit({
        action: "UPDATE",
        entity: "TimeEntry",
        entityId: row.id,
        oldValue: row.oldValue,
        newValue: { ...row.newValue, ...marker },
      });
    }

    if (action.leaveTypeCode === "VACATION") {
      await reverseVacationDays(
        tx,
        employeeId,
        action.leaveTypeId,
        action.guard.startDate,
        action.guard.endDate,
        action.days,
        new Set(action.holidayDates),
        tenantId,
      );
    }
  }

  await audit({
    action: "CANCEL",
    entity: "LeaveRequest",
    entityId: action.requestId,
    oldValue: {
      status: action.guard.status,
      startDate: isoDay(action.guard.startDate),
      endDate: isoDay(action.guard.endDate),
      days: action.days,
      leaveTypeCode: action.leaveTypeCode,
    },
    newValue: { status: "CANCELLED", ...marker, exitDate: isoDay(exitDay) },
  });

  if (action.overtimeReversal) {
    const { minutes, source } = action.overtimeReversal;
    await reverseOvertimeCompensation(
      tx,
      employeeId,
      tenantId,
      minutes / 60,
      `Stornierung Überstundenausgleich ${isoDay(action.guard.startDate)} (Anonymisierung)`,
    );
    await audit({
      action: "OVERTIME_COMP_REVERSED",
      entity: "LeaveRequest",
      entityId: action.requestId,
      newValue: { overtimeCompMinutes: minutes, hours: minutes / 60, source },
    });
  }
}

/** Soft-deletes one imposed absence (the row stays; same end state as the BS generator's sweep). */
async function deleteAbsence(
  tx: Prisma.TransactionClient,
  input: EmploymentExitInput,
  action: DeleteAbsenceAction,
  audit: EmploymentExitAuditPort,
): Promise<void> {
  const { tenantId, employeeId, exitDay } = input;
  const { count } = await tx.absence.updateMany({
    where: {
      id: action.absenceId,
      employeeId,
      employee: { tenantId },
      deletedAt: null,
      startDate: action.guard.startDate,
      endDate: action.guard.endDate,
    },
    data: { deletedAt: new Date() },
  });
  if (count !== 1) throw new EmploymentExitConflictError("Absence", action.absenceId);

  await audit({
    action: "DELETE",
    entity: "Absence",
    entityId: action.absenceId,
    oldValue: {
      type: action.type,
      startDate: isoDay(action.guard.startDate),
      endDate: isoDay(action.guard.endDate),
      days: action.days,
      source: action.source,
    },
    newValue: {
      deleted: true,
      auditReason: "Anonymisierung",
      trigger: "ANONYMIZATION",
      exitDate: isoDay(exitDay),
    },
  });
}

/**
 * Phase 3 — reactive, after the commit. Recomputes what the changed days feed (snapshots, the
 * persisted overtime balance) and dismisses the managers' open notices of the cancelled requests.
 * Every step logs its own failure; the anonymization is already committed and never fails here.
 */
export async function afterEmploymentExit(
  app: FastifyInstance,
  result: EmploymentExitResult,
): Promise<void> {
  const { employeeId } = result.input;
  if (result.changedFrom === null) return;

  try {
    await recalculateSnapshots(app, employeeId, result.changedFrom);
  } catch (err) {
    app.log.error({ err, employeeId }, "Employment exit: snapshot recalculation failed");
  }

  try {
    // null = §18-exempt: nothing to persist (same guard as the leave cancellation review).
    const balanceHours = await computeOvertimeBalanceHours(app, employeeId);
    if (balanceHours !== null) {
      await app.prisma.$transaction(async (tx) => {
        await persistOvertimeBalance(app, tx, employeeId, balanceHours);
      });
    }
  } catch (err) {
    app.log.error({ err, employeeId }, "Employment exit: overtime balance recompute failed");
  }

  for (const requestId of [...result.cancelled, ...result.shortened]) {
    try {
      await app.dismissByRelated("LeaveRequest", requestId);
    } catch (err) {
      app.log.warn({ err, requestId }, "Employment exit: notification dismissal failed");
    }
  }
}
