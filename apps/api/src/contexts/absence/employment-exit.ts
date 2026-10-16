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
 * This file currently covers the tracer scope: an APPROVED VACATION request lying wholly after the
 * exit day. Plans 02-04 extend it with the other statuses and types and the shortening.
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
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import {
  computeOvertimeBalanceHours,
  persistOvertimeBalance,
  recalculateSnapshots,
} from "../working-time-account";
import { findClosedMonthsInRange } from "./closed-month-guard";
import { getHolidayMap, reverseVacationDays } from "./leave-days";

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

/** An APPROVED VACATION request lying wholly after the exit day: cancel and book back. */
interface CancelLeaveAction {
  kind: "cancelLeave";
  requestId: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  days: number;
  /** Optimistic guard: the row must still look like this inside the transaction. */
  guard: { status: "APPROVED"; startDate: Date; endDate: Date; updatedAt: Date };
  /** Holiday dates of the request range, read before the transaction (as the cancellation does). */
  holidayDates: string[];
}

export type EmploymentExitAction = CancelLeaveAction;

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
  constructor(requestId: string) {
    super(`employment exit: leave request ${requestId} changed concurrently`);
  }
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Phase 1 — pure reads. Decides what the exit cancels and what it must leave alone. */
export async function planEmploymentExit(
  prisma: FastifyInstance["prisma"],
  input: EmploymentExitInput,
): Promise<EmploymentExitPlan> {
  const { tenantId, employeeId, exitDay } = input;
  const actions: EmploymentExitAction[] = [];
  const skipped: EmploymentExitSkipped[] = [];

  const approvedVacation = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      employee: { tenantId },
      deletedAt: null,
      status: "APPROVED",
      startDate: { gt: exitDay },
      leaveType: { code: "VACATION" },
    },
    select: {
      id: true,
      leaveTypeId: true,
      days: true,
      startDate: true,
      endDate: true,
      updatedAt: true,
      leaveType: { select: { code: true } },
    },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });

  for (const row of approvedVacation) {
    // D-05: a closed month is immutable. The row stays as it is and is reported instead.
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
    const holidays = await getHolidayMap(prisma, tenantId, employeeId, row.startDate, row.endDate);
    actions.push({
      kind: "cancelLeave",
      requestId: row.id,
      leaveTypeId: row.leaveTypeId,
      leaveTypeCode: row.leaveType.code,
      days: Number(row.days),
      guard: {
        status: "APPROVED",
        startDate: row.startDate,
        endDate: row.endDate,
        updatedAt: row.updatedAt,
      },
      holidayDates: [...holidays.keys()],
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
  const { tenantId, employeeId, exitDay } = plan.input;
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
    if (count !== 1) throw new EmploymentExitConflictError(action.requestId);

    // The booking an approved cancellation reverses (leave.ts, cancellation approval).
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
      newValue: {
        status: "CANCELLED",
        auditReason: "Anonymisierung",
        trigger: "ANONYMIZATION",
        exitDate: isoDay(exitDay),
      },
    });
    result.cancelled.push(action.requestId);
    touch(action.guard.startDate);
  }

  return result;
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
