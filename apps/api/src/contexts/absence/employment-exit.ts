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
 *   - a request spanning the exit day (`startDate <= exit day < endDate`) is SHORTENED to end ON the
 *     exit day, never cancelled: an APPROVED / CANCELLATION_REQUESTED one through the leave
 *     correction core (`leave-correction.ts`, the one implementation `PATCH /leave/requests/:id/correct`
 *     runs: old booking reversed, new booking applied, days re-priced, § 9 credits superseded or
 *     clipped, removed days' invalid entries revalidated), a PENDING one by re-pricing its days
 *     exactly like the pending edit. Only when no leave day is left up to the exit (re-priced to 0
 *     days, or Berufsschule only) is it cancelled instead;
 *   - imposed absences after the exit day are soft-deleted;
 *   - a row whose changed days touch a CLOSED month, or that the correction core refuses, is never
 *     touched, only reported (`skipped`).
 *
 * This file covers every absence of the person that reaches past the exit day: PENDING, APPROVED
 * and CANCELLATION_REQUESTED requests of every leave type (cancelled when wholly after the exit
 * day, shortened when spanning it) and the imposed Berufsschule rows.
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
import { getHolidayMap, resolveLeaveDays, reverseVacationDays } from "./leave-days";
import {
  Section9ConcurrentCorrectionError,
  supersedeSection9CreditsOfCancelledRequest,
} from "./section9-supersede";
import {
  applyLeaveCorrection,
  prepareLeaveCorrection,
  type LeaveCorrectionPlan,
} from "./leave-correction";
import { overtimeCompReversalMinutes } from "./overtime-comp-minutes";
import { activeParentalReductions } from "./parental-leave-reduction";

export interface EmploymentExitInput {
  tenantId: string;
  employeeId: string;
  /** UTC midnight of the exit day (the convention of stored `Employee.exitDate` values). */
  exitDay: Date;
  /**
   * The acting `User.id` (written as `reviewedBy` of a § 9 correction credit the shortening
   * creates); null / absent for an API-key actor, never the raw `apikey:` subject.
   */
  actorUserId?: string | null;
  /**
   * Audit marker of the run. Absent = a live anonymization (`Anonymisierung` / `ANONYMIZATION`);
   * the Bestandskorrektur of Issue #666 passes its own, so a corrected row is told apart from a
   * row ended at anonymization time. Display reason and machine trigger, never free text.
   */
  marker?: EmploymentExitMarker;
}

/** The `auditReason` (German display) and `trigger` (machine marker) written to every audit row. */
export interface EmploymentExitMarker {
  auditReason: string;
  trigger: string;
}

const ANONYMIZATION_MARKER: EmploymentExitMarker = {
  auditReason: "Anonymisierung",
  trigger: "ANONYMIZATION",
};

const markerOf = (input: EmploymentExitInput): EmploymentExitMarker =>
  input.marker ?? ANONYMIZATION_MARKER;

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

/**
 * An APPROVED / CANCELLATION_REQUESTED request spanning the exit day: end it ON the exit day through
 * the leave correction core. The core's plan was built (all reads, all refusals) before the
 * transaction opened.
 */
interface ShortenLeaveAction {
  kind: "shortenLeave";
  requestId: string;
  correction: LeaveCorrectionPlan;
  guard: { status: OpenLeaveStatus; startDate: Date; endDate: Date; updatedAt: Date };
}

/** A PENDING request spanning the exit day: end it on the exit day and re-price its days. */
interface RepricePendingAction {
  kind: "repricePending";
  requestId: string;
  leaveTypeCode: string;
  /** The re-priced day count of [startDate, exit day] (never 0 — that case is a cancel). */
  days: number;
  guard: { startDate: Date; endDate: Date; updatedAt: Date; days: number };
}

export type EmploymentExitAction =
  CancelLeaveAction | ShortenLeaveAction | RepricePendingAction | DeleteAbsenceAction;

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

/** The columns of a leave request the cancel branch of the plan reads. */
interface CancelableRow {
  id: string;
  leaveTypeId: string;
  status: string;
  days: { toString(): string };
  halfDay: boolean;
  overtimeCompMinutes: number | null;
  startDate: Date;
  endDate: Date;
  updatedAt: Date;
  leaveType: { code: string };
}

/** The correction plan minus the § 9 credits an earlier shortening of the same run already settled. */
function withoutHandledCredits(
  plan: LeaveCorrectionPlan,
  handled: ReadonlySet<string>,
): LeaveCorrectionPlan {
  if (handled.size === 0) return plan;
  const open = <T extends { id: string }>(list: T[]): T[] => list.filter((c) => !handled.has(c.id));
  const { keep, supersede, clip } = plan.section9CorrectionPlan;
  return {
    ...plan,
    touchingSection9Credits: open(plan.touchingSection9Credits),
    section9CorrectionPlan: {
      keep: keep.filter((id) => !handled.has(id)),
      supersede: open(supersede),
      clip: open(clip),
    },
    section9ClipPricings: open(plan.section9ClipPricings),
  };
}

/** Phase 1 — pure reads. Decides what the exit cancels, shortens and must leave alone. */
export async function planEmploymentExit(
  app: FastifyInstance,
  input: EmploymentExitInput,
): Promise<EmploymentExitPlan> {
  const prisma = app.prisma;
  const log: Pick<FastifyBaseLogger, "warn"> = app.log;
  const { tenantId, employeeId, exitDay } = input;
  const actions: EmploymentExitAction[] = [];
  const skipped: EmploymentExitSkipped[] = [];
  const dayAfterExit = new Date(exitDay.getTime() + 86_400_000);

  let tzCache: string | null = null;
  const tenantTz = async () => (tzCache ??= await getTenantTimezone(prisma, tenantId));

  /**
   * Cancels `row` as a whole (and books back what its approval booked) unless a protection rule
   * applies. Skip precedence (one reason per row): D-05 closed month anywhere in the row's range,
   * then the § 17 BEEG reduction. The row stays as it is and is reported. A live § 9 credit is not
   * a protection (Issue #662): the cancellation supersedes it.
   */
  const cancelOrSkip = async (row: CancelableRow): Promise<void> => {
    const closed = await findClosedMonthsInRange(
      prisma,
      employeeId,
      tenantId,
      row.startDate,
      row.endDate,
    );
    if (closed.length > 0) {
      skipped.push({ entity: "LeaveRequest", id: row.id, reason: "CLOSED_MONTH" });
      return;
    }
    if (row.leaveType.code === "PARENTAL") {
      const reductions = await activeParentalReductions(prisma, row.id, tenantId);
      if (reductions.length > 0) {
        skipped.push({ entity: "LeaveRequest", id: row.id, reason: "PARENTAL_REDUCTION_ACTIVE" });
        return;
      }
    }
    // Issue #662: a live § 9 credit no longer protects the row - the cancellation supersedes it
    // (section9-supersede.ts, the rule the cancellation approval runs). The holiday set is then
    // needed for the ledger undo of a CONFIRMED credit even on a non-vacation (sick) row.
    const hasSection9Credit =
      (await prisma.section9Credit.count({
        where: {
          employeeId,
          employee: { tenantId },
          status: { not: "SUPERSEDED" },
          OR: [{ vacationRequestId: row.id }, { sickRequestId: row.id }],
        },
      })) > 0;

    // A PENDING request booked nothing; every other status reverses what its approval booked.
    const booked = row.status !== "PENDING";
    const code = row.leaveType.code;
    let holidayDates: string[] = [];
    if (booked && (code === "VACATION" || hasSection9Credit)) {
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
          return { holidays: new Set(holidays.keys()), tz: await tenantTz() };
        },
      );
      if (overtimeReversal.source === "recomputed") {
        log.warn(
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
  };

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
  for (const row of requests) await cancelOrSkip(row);

  // ── Leave requests spanning the exit day (D-02: shorten to the exit day, never cancel) ──────
  const spanning = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      employee: { tenantId },
      deletedAt: null,
      status: { in: ["PENDING", "APPROVED", "CANCELLATION_REQUESTED"] },
      startDate: { lte: exitDay },
      endDate: { gt: exitDay },
    },
    include: { leaveType: true, employee: { select: { tenantId: true } } },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  // § 9 credits already handled by an earlier shortening of this run. A sick/vacation pair that
  // BOTH span the exit day shares one credit: the second correction would plan against the stale
  // pre-run credit and abort the whole anonymization with a concurrent-correction conflict. Both
  // requests end on the same day, so the first correction's supersede/clip already covers the
  // second request's new range — the second one must not touch that credit again.
  const handledCredits = new Set<string>();
  for (const row of spanning) {
    const status = row.status as OpenLeaveStatus;
    const guard = {
      status,
      startDate: row.startDate,
      endDate: row.endDate,
      updatedAt: row.updatedAt,
    };

    if (status === "PENDING") {
      // The removed days [exit day + 1 .. old end] must not lie in a closed month (D-05), and a
      // declared § 17 reduction anchors the request (same conservative rule as a wholly-after row).
      const closed = await findClosedMonthsInRange(
        prisma,
        employeeId,
        tenantId,
        dayAfterExit,
        row.endDate,
      );
      if (closed.length > 0) {
        skipped.push({ entity: "LeaveRequest", id: row.id, reason: "CLOSED_MONTH" });
        continue;
      }
      if (row.leaveType.code === "PARENTAL") {
        const reductions = await activeParentalReductions(prisma, row.id, tenantId);
        if (reductions.length > 0) {
          skipped.push({
            entity: "LeaveRequest",
            id: row.id,
            reason: "PARENTAL_REDUCTION_ACTIVE",
          });
          continue;
        }
      }
      // Priced exactly like the pending edit (PATCH /requests/:id): self-excluded, request mode.
      const holidays = await getHolidayMap(prisma, tenantId, employeeId, row.startDate, exitDay);
      const priced = await resolveLeaveDays(
        prisma,
        employeeId,
        tenantId,
        row.startDate,
        exitDay,
        row.halfDay,
        new Set(holidays.keys()),
        { mode: "request", leaveTypeCode: row.leaveType.code, excludeRequestId: row.id },
      );
      if (priced.days <= 0 || priced.vocationalSchoolOnly) {
        await cancelOrSkip(row);
        continue;
      }
      actions.push({
        kind: "repricePending",
        requestId: row.id,
        leaveTypeCode: row.leaveType.code,
        days: priced.days,
        guard: { ...guard, days: Number(row.days) },
      });
      continue;
    }

    // APPROVED / CANCELLATION_REQUESTED: the correction core decides (delta-lock, § 17 anchor,
    // overlap, pricing, § 9 plan). `note: null` — the PII sweep nulls notes anyway and the exit
    // never writes one back.
    const prepared = await prepareLeaveCorrection(app, {
      existing: row,
      start: row.startDate,
      end: exitDay,
      halfDay: row.halfDay,
      note: null,
      reason: markerOf(input).auditReason,
      tenantId,
    });
    if (!prepared.ok) {
      if (prepared.reason === "BS_ONLY") {
        await cancelOrSkip(row);
      } else {
        skipped.push({
          entity: "LeaveRequest",
          id: row.id,
          reason:
            prepared.reason === "CLOSED_MONTH"
              ? "CLOSED_MONTH"
              : prepared.reason === "PARENTAL_REDUCTION"
                ? "PARENTAL_REDUCTION_ACTIVE"
                : "CORRECTION_REFUSED",
        });
      }
      continue;
    }
    if (prepared.plan.days <= 0) {
      // No leave day is left up to the exit: nothing to keep, cancel with the reversal instead.
      await cancelOrSkip(row);
      continue;
    }
    const correction = withoutHandledCredits(prepared.plan, handledCredits);
    for (const credit of prepared.plan.touchingSection9Credits) handledCredits.add(credit.id);
    actions.push({ kind: "shortenLeave", requestId: row.id, correction, guard });
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
    if (action.kind === "shortenLeave") {
      await shortenLeave(tx, plan.input, action, audit);
      result.shortened.push(action.requestId);
      // The saldo recalculation starts from the ORIGINAL start (the route's "earlier of old/new").
      touch(action.guard.startDate);
      continue;
    }
    if (action.kind === "repricePending") {
      await repricePending(tx, plan.input, action, audit);
      result.shortened.push(action.requestId);
      touch(action.guard.startDate);
      continue;
    }
    await cancelLeave(tx, plan.input, action, audit);
    result.cancelled.push(action.requestId);
    touch(action.guard.startDate);
  }

  return result;
}

/**
 * Optimistic lock on a planned request: a guarded no-op write that takes the row lock and answers
 * 0 rows when the request changed between plan and apply (the caller throws the conflict).
 */
async function lockPlannedRequest(
  tx: Prisma.TransactionClient,
  input: EmploymentExitInput,
  requestId: string,
  guard: { status?: OpenLeaveStatus; startDate: Date; endDate: Date; updatedAt: Date },
): Promise<void> {
  const { count } = await tx.leaveRequest.updateMany({
    where: {
      id: requestId,
      employeeId: input.employeeId,
      employee: { tenantId: input.tenantId },
      deletedAt: null,
      status: guard.status ?? "PENDING",
      startDate: guard.startDate,
      endDate: guard.endDate,
      updatedAt: guard.updatedAt,
    },
    data: { status: guard.status ?? "PENDING" },
  });
  if (count !== 1) throw new EmploymentExitConflictError("LeaveRequest", requestId);
}

/**
 * Ends an APPROVED / CANCELLATION_REQUESTED request ON the exit day through the leave correction
 * core (D-02): the status stays, the days are re-priced, the booking is moved by the core. The
 * core's own audit rows (§ 9, revalidated entries) get the exit marker merged into `newValue`.
 */
async function shortenLeave(
  tx: Prisma.TransactionClient,
  input: EmploymentExitInput,
  action: ShortenLeaveAction,
  audit: EmploymentExitAuditPort,
): Promise<void> {
  const { exitDay } = input;
  const marker = markerOf(input);
  const { correction } = action;
  const { existing } = correction;

  await lockPlannedRequest(tx, input, action.requestId, action.guard);
  try {
    await applyLeaveCorrection(tx, correction, {
      actorUserId: input.actorUserId ?? null,
      audit: (entry) => audit({ ...entry, newValue: { ...(entry.newValue ?? {}), ...marker } }),
    });
  } catch (err) {
    // A concurrent § 9 correction of a credit this request touches: same 409 as a changed row.
    if (err instanceof Section9ConcurrentCorrectionError) {
      throw new EmploymentExitConflictError("LeaveRequest", action.requestId);
    }
    throw err;
  }

  const otDelta =
    existing.leaveType.code === "OVERTIME_COMP"
      ? (correction.newOtMinutes ?? 0) - (correction.oldOtMinutes ?? 0)
      : null;
  await audit({
    action: "LEAVE_CORRECTED",
    entity: "LeaveRequest",
    entityId: action.requestId,
    oldValue: {
      status: action.guard.status,
      startDate: isoDay(existing.startDate),
      endDate: isoDay(existing.endDate),
      days: Number(existing.days),
      leaveTypeCode: existing.leaveType.code,
    },
    newValue: {
      startDate: isoDay(correction.start),
      endDate: isoDay(correction.end),
      days: correction.days,
      ...marker,
      exitDate: isoDay(exitDay),
      ...(otDelta !== null ? { overtimeCompDeltaMinutes: otDelta } : {}),
    },
  });
}

/** Ends a PENDING request on the exit day and re-prices its days (nothing was booked). */
async function repricePending(
  tx: Prisma.TransactionClient,
  input: EmploymentExitInput,
  action: RepricePendingAction,
  audit: EmploymentExitAuditPort,
): Promise<void> {
  await lockPlannedRequest(tx, input, action.requestId, { ...action.guard, status: "PENDING" });
  await tx.leaveRequest.update({
    where: { id: action.requestId },
    data: { endDate: input.exitDay, days: action.days },
  });
  await audit({
    action: "UPDATE",
    entity: "LeaveRequest",
    entityId: action.requestId,
    oldValue: {
      status: "PENDING",
      startDate: isoDay(action.guard.startDate),
      endDate: isoDay(action.guard.endDate),
      days: action.guard.days,
      leaveTypeCode: action.leaveTypeCode,
    },
    newValue: {
      endDate: isoDay(input.exitDay),
      days: action.days,
      ...markerOf(input),
      exitDate: isoDay(input.exitDay),
    },
  });
}

/** Cancels one request and books back exactly what an approved cancellation books back. */
async function cancelLeave(
  tx: Prisma.TransactionClient,
  input: EmploymentExitInput,
  action: CancelLeaveAction,
  audit: EmploymentExitAuditPort,
): Promise<void> {
  const { tenantId, employeeId, exitDay } = input;
  const marker = markerOf(input);

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

  // Issue #662: a cancelled request leaves no § 9 credit standing - the same shared supersession
  // the cancellation approval runs (section9-supersede.ts), audited with the anonymization marker.
  try {
    await supersedeSection9CreditsOfCancelledRequest(tx, {
      requestId: action.requestId,
      employeeId,
      tenantId,
      holidays: new Set(action.holidayDates),
      audit: (entry) => audit({ ...entry, newValue: { ...(entry.newValue ?? {}), ...marker } }),
    });
  } catch (err) {
    if (err instanceof Section9ConcurrentCorrectionError) {
      throw new EmploymentExitConflictError("LeaveRequest", action.requestId);
    }
    throw err;
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
      `Stornierung Überstundenausgleich ${isoDay(action.guard.startDate)} (${markerOf(input).auditReason})`,
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
      ...markerOf(input),
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
