/**
 * Issue #835 (D-835-12) — the leave-request decision core: "how a PENDING request for leave is
 * approved or rejected".
 *
 * Lifted out of `PATCH /api/v1/leave/requests/:id/review` (`api/leave.ts`) so the route and the
 * leave-planner takeover (plan 835-03) decide a request through ONE function. The PENDING branch
 * is moved verbatim (closed-month and overlap refusals, the #836 limit check, the SHIFT_BASED
 * recompute, the vacation deduction, the Überstundenausgleich booking, the § 9 credits, the
 * snapshot recalculation, the shift-conflict reverse hook, the pro-rata warning, the audit, the
 * notification and the dismissal); only the HTTP seams changed: a refusal is returned as data with
 * a stable machine `reason` (a control value, never the German text), and the reviewer and the
 * audit request meta are inputs. Approve and reject share the update, the audit and the
 * notification, so both go through `decidePendingLeaveRequest`; `approveLeaveRequestCore` is its
 * APPROVED entry point. The CANCELLATION_REQUESTED branch stays in the route.
 *
 * Contract:
 *   - the CALLER authorizes: the tenant check and the Stammsalon scope check stay with the caller
 *     (the route: `CROSS_TENANT_ACCESS_DENIED` / `SCOPE_ACCESS_DENIED` audits), the core runs
 *     neither;
 *   - the pre-decision guard (decidable status, self-approval, cancellation four-eyes) is
 *     `leaveDecisionGuard`, called by the caller before any write, in this order;
 *   - a refusal is `{ ok: false, statusCode, body, reason }`; a limit exceedance without a reason is
 *     returned as data (`limit`) because the redacted 409 body needs the caller's reader reach;
 *   - the approval is NOT one transaction: it is the same sequence of writes the route ran before
 *     the move (update, deduction, audit, tail transaction), so a late failure leaves the same
 *     partial state as before.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22); importers:
 * `api/leave.ts` and, from 835-03, the planner takeover.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { closedMonthLeaveMessage } from "./correction-lock";
import { findClosedMonthsInRange } from "./closed-month-guard";
import { findBlockingLeaveOverlap, LEAVE_OVERLAP_ERROR } from "./leave-overlap";
import { isSickLeaveTypeCode } from "./leave-type";
import { EFFECTIVE_LEAVE_STATUSES } from "./effective-leave-statuses";
import { findSection9Overlaps } from "./section9-detect";
import { scheduledLeaveMinutes } from "./overtime-comp-minutes";
import {
  resolveLeaveDays,
  getHolidayMap,
  deductVacationDays,
  exitVacationOverUseWarning,
} from "./leave-days";
import {
  LEAVE_LIMIT_EXCEPTION_REQUIRED,
  buildLeaveLimitExceptionAudit,
  evaluateLeaveLimits,
  leaveLimitExceptionRequiredBody,
  type LeaveLimitCheckResult,
  type LeaveLimitExceedance,
} from "./leave-limits";
import {
  flagShiftsConflictingWithLeave,
  notifyShiftLeaveConflicts, // Phase 100B Plan 05 — S1/S2; Phase 430 (D-02) — shared audit+notify helper
} from "../scheduling";
import {
  bookOvertimeCompensation,
  getTenantTimezone,
  recalculateSnapshots,
  computeOvertimeBalanceHours, // Issue #294 — pure read, run BEFORE the booking+persist transaction
  persistOvertimeBalance, // Issue #294 — booking + recompute in one $transaction
} from "../working-time-account";
import {
  userIdsHoldingPermission,
  resolveScopedHolderIds,
  isStammsalonScopeMatch,
} from "../platform";

/** Internal machine marker of a refusal; the route sends `statusCode` + `body` only. */
export type DecisionRefusalReason =
  | "NOT_DECIDABLE"
  | "SELF_APPROVAL"
  | "CANCELLATION_BY_REQUESTER"
  | "CANCELLATION_BY_APPROVER"
  | "MONTH_CLOSED"
  | "OVERLAP"
  | "LIMIT_EXCEPTION_REQUIRED";

export interface DecisionRefusal {
  ok: false;
  statusCode: 403 | 409;
  body: { error: string; code?: string; [key: string]: unknown };
  reason: DecisionRefusalReason;
  /**
   * Only for `LIMIT_EXCEPTION_REQUIRED`: the raw exceedances, so the caller renders the redacted
   * 409 body with its own reader reach. `body` is then a placeholder the route never sends.
   */
  limit?: {
    exceedances: LeaveLimitExceedance[];
    personNames: LeaveLimitCheckResult["personNames"];
  };
}

function refusal(
  statusCode: DecisionRefusal["statusCode"],
  body: DecisionRefusal["body"],
  reason: DecisionRefusalReason,
): DecisionRefusal {
  return { ok: false, statusCode, body, reason };
}

/** The audit request meta, as the route passes it: `{ ip: req.ip, headers: req.headers as Record<string, string> }`. */
export type AuditRequestMeta = { ip: string; headers: Record<string, string> };

/** The request row exactly as the review route loads and uses it. */
export async function loadLeaveRequestForReview(app: FastifyInstance, id: string) {
  return app.prisma.leaveRequest.findFirst({
    where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
    include: { leaveType: true, employee: { select: { tenantId: true } } },
  });
}
export type ReviewableLeaveRequest = NonNullable<
  Awaited<ReturnType<typeof loadLeaveRequestForReview>>
>;

/**
 * The pre-decision checks, in the order the route ran them: the status must still be decidable,
 * a reviewer may not decide their own request, and the person who requested a cancellation (or
 * who approved the leave) may not approve its cancellation. Returns the refusal, or null.
 */
export async function leaveDecisionGuard(
  app: FastifyInstance,
  input: { existing: ReviewableLeaveRequest; reviewerUserId: string },
): Promise<DecisionRefusal | null> {
  const { existing } = input;
  if (!["PENDING", "CANCELLATION_REQUESTED"].includes(existing.status)) {
    return refusal(409, { error: "Antrag kann nicht mehr geändert werden" }, "NOT_DECIDABLE");
  }

  // Block self-approval — managers cannot approve their own requests
  const reviewerEmployee = await app.prisma.employee.findFirst({
    where: { userId: input.reviewerUserId },
    select: { id: true },
  });
  if (reviewerEmployee && existing.employeeId === reviewerEmployee.id) {
    return refusal(
      403,
      { error: "Eigene Anträge können nicht selbst genehmigt werden" },
      "SELF_APPROVAL",
    );
  }

  // 4-eyes: block cancellation-approval by the person who requested the cancellation (COMP-V1814-02)
  if (
    existing.cancellationRequestedBy &&
    input.reviewerUserId === existing.cancellationRequestedBy
  ) {
    return refusal(
      403,
      { error: "Stornierung kann nicht vom Antragsteller genehmigt werden" },
      "CANCELLATION_BY_REQUESTER",
    );
  }
  // 4-eyes: block cancellation-approval by the manager who originally approved the leave (COMP-V1814-02)
  if (existing.reviewedBy && input.reviewerUserId === existing.reviewedBy) {
    return refusal(
      403,
      { error: "Stornierung kann nicht vom ursprünglichen Genehmiger genehmigt werden" },
      "CANCELLATION_BY_APPROVER",
    );
  }
  return null;
}

/**
 * German date label for USER-FACING § 9 notification texts: "16.09.2026".
 *
 * Phase 104 follow-up (not in REVIEW.md, owner-reported): the § 9 notification bodies rendered
 * dates ISO-style ("2026-09-16 – 2026-09-17") while everything else user-facing in this app
 * uses DD.MM.YYYY. UTC accessors on purpose — every date fed in here is a @db.Date column
 * (UTC midnight), so a local-time formatter would shift the label by a day on any host with a
 * negative UTC offset (the same class of bug as WR-09). API payloads and AuditLog values keep
 * their ISO form; only the human-readable message text changes.
 */
export function formatDateDe(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

export interface DecideInput {
  existing: ReviewableLeaveRequest;
  reviewerUserId: string;
  reviewNote?: string | null;
  /** The approver's exception over a salon limit (Issue #836, D-836-09); approval only. */
  limitException?: { reason: string };
  /**
   * Issue #835 (D-835-37): skip ONLY the live-saldo recompute and the persist of the stored
   * overtime balance after an approval. Every other effect (status, days, entitlement deduction,
   * the OVERTIME_COMP booking, audit, four-eyes, limit check, snapshot recalculation) is the same.
   * The caller then owns the refresh of the stored balance (the planner takeover refreshes once per
   * person after its batch); a normal approval never sets it. Approval only.
   */
  deferOvertimeRecompute?: boolean;
  /** The audit request meta (`{ ip, headers }`). */
  request: AuditRequestMeta;
}

/** The updated row exactly as the review route used it. */
export type DecidedLeaveRequestRow = Prisma.LeaveRequestGetPayload<{
  include: { employee: { select: { firstName: true; lastName: true } }; leaveType: true };
}>;

export interface DecideSuccess {
  ok: true;
  /** The updated row as the route used it. */
  updated: DecidedLeaveRequestRow;
  /** Exactly the optional keys the route spreads into its response. */
  responseExtras: { overtimeCompMinutes?: number; proRataWarning?: unknown };
}

export type DecideOutcome = DecideSuccess | DecisionRefusal;

export async function decidePendingLeaveRequest(
  app: FastifyInstance,
  input: DecideInput & { status: "APPROVED" | "REJECTED" },
): Promise<DecideOutcome> {
  const { existing } = input;
  const id = existing.id;

  // ── Regular request (PENDING) ────────────────────────────────────────────
  // Issue #446 (D-06(b)/D-10): gated on APPROVED only — a PENDING -> REJECTED review
  // stays allowed (saldo-neutral), checked before any read-dependent computation and
  // before the write below.
  if (input.status === "APPROVED") {
    const closedMonths = await findClosedMonthsInRange(
      app.prisma,
      existing.employeeId,
      existing.employee.tenantId,
      existing.startDate,
      existing.endDate,
    );
    if (closedMonths.length > 0) {
      return refusal(
        409,
        {
          error: closedMonthLeaveMessage(closedMonths, "change"),
          code: "LEAVE_MONTH_CLOSED",
        },
        "MONTH_CLOSED",
      );
    }
  }

  // Issue #478: approving must not turn a double booking into active leave. A PENDING
  // request is normally collision-free from POST/PATCH, but a stored double booking (made
  // before those guards) is refused here with the same 409 as POST.
  if (input.status === "APPROVED") {
    const approveBlockingOverlap = await findBlockingLeaveOverlap(app.prisma, {
      employeeId: existing.employeeId,
      start: existing.startDate,
      end: existing.endDate,
      isSickRequest: isSickLeaveTypeCode(existing.leaveType.code),
      excludeRequestId: id,
    });
    if (approveBlockingOverlap) {
      return refusal(409, { error: LEAVE_OVERLAP_ERROR }, "OVERLAP");
    }
  }

  // Issue #836 (D-836-09/10): an approval that pushes a salon group over a rule needs an
  // explicit, audited exception. A pure read BEFORE the first write, so a refusal leaves no
  // trace (status, reviewedAt, audit, notices); a rejection is never checked. Fail-closed: a
  // failing check propagates (500) instead of approving without the legally relevant record.
  let leaveLimitException: ReturnType<typeof buildLeaveLimitExceptionAudit> | null = null;
  if (input.status === "APPROVED") {
    const limitResult = await evaluateLeaveLimits(app.prisma, existing.employee.tenantId, {
      candidates: [
        {
          requestId: existing.id,
          employeeId: existing.employeeId,
          typeCode: existing.leaveType.code,
          startDay: existing.startDate.toISOString().slice(0, 10),
          endDay: existing.endDate.toISOString().slice(0, 10),
        },
      ],
      excludeRequestIds: [existing.id],
    });
    if (limitResult.exceedances.length > 0) {
      if (!input.limitException) {
        // The redacted 409 body needs the caller's reader reach (`req`), so the core returns the
        // raw exceedances as data and the route renders the body. `body` is a placeholder the
        // route never sends.
        return {
          ...refusal(
            409,
            {
              error: leaveLimitExceptionRequiredBody([]).error,
              code: LEAVE_LIMIT_EXCEPTION_REQUIRED,
            },
            "LIMIT_EXCEPTION_REQUIRED",
          ),
          limit: { exceedances: limitResult.exceedances, personNames: limitResult.personNames },
        };
      }
      leaveLimitException = buildLeaveLimitExceptionAudit(
        input.limitException.reason,
        limitResult.exceedances,
      );
    }
  }

  const reviewTypeCode = existing.leaveType.code;

  // Issue #294: the OVERTIME_COMP booking below is computed but NOT written where it is
  // decided — it is issued at the tail, in the SAME $transaction as the balance persist,
  // so a failed persist rolls the booking back with it instead of leaving an orphan receipt.
  // Issue #468 (A-4/D-02): `minutes` carried alongside `hours` — the exact integer value
  // stored on LeaveRequest.overtimeCompMinutes, written in the SAME transaction as the
  // REDUCTION journal row below.
  let pendingOvertimeBooking: {
    tenantId: string;
    hours: number;
    minutes: number;
    description: string;
  } | null = null;

  // Phase 107 (D-07/D-10, T-107-20): for an APPROVED SHIFT_BASED vacation request, recompute
  // `days` from the roster and determine `daysProvisional` BEFORE the update() call below, so
  // both land in the SAME write as the status flip — a second update() would leave a crash
  // window where a request is APPROVED with stale days and no flag. Builds the holiday map
  // once here and reuses it for deductVacationDays() further down. Every other type/branch
  // is untouched: `daysProvisional` stays `null`.
  let holidayMapForDeduct: Map<string, string> | null = null;
  let shiftBasedApprovalRecompute: { days: number; provisional: boolean } | null = null;
  if (input.status === "APPROVED" && reviewTypeCode === "VACATION") {
    holidayMapForDeduct = await getHolidayMap(
      app.prisma,
      existing.employee.tenantId,
      existing.employeeId,
      existing.startDate,
      existing.endDate,
    );
    const wsForApproval = await app.prisma.workSchedule.findFirst({
      where: { employeeId: existing.employeeId },
      orderBy: { validFrom: "desc" },
      select: { type: true },
    });
    if (wsForApproval?.type === "SHIFT_BASED") {
      // Issue #436 (D-04): approval recomputes against the other counted VACATION requests,
      // excluding this one — the ordering rule (createdAt, ties by id) keeps this request's
      // price stable whether it is approved before or after a sibling.
      shiftBasedApprovalRecompute = await resolveLeaveDays(
        app.prisma,
        existing.employeeId,
        existing.employee.tenantId,
        existing.startDate,
        existing.endDate,
        existing.halfDay,
        new Set(holidayMapForDeduct.keys()),
        { mode: "request", leaveTypeCode: reviewTypeCode, excludeRequestId: existing.id },
      );
    }
  }

  // Phase 120 (D-01/D-04): snapshot the pre-decision state BEFORE the update() below overwrites
  // `days`/`daysProvisional` (Phase 107 writes both in the same call that flips `status`). Reading
  // these values again after the write would return the NEW ones and silently produce an audit row
  // whose oldValue equals its newValue — the exact failure this phase exists to prevent.
  // `days` is a Prisma Decimal; JSON.stringify() would serialise it as a string, so Number() is
  // load-bearing, not cosmetic (it matches the LEAVE_DAYS_ADJUSTED row's numeric `days`).
  const auditOldValue = {
    status: existing.status,
    days: Number(existing.days),
    daysProvisional: existing.daysProvisional,
  };

  // Issue #835 (D-835-41, WR-05): the status flip is the FIRST write and is conditional on the row
  // still being PENDING. Two deciders that both read the request as PENDING (two reviewers, or a
  // review and a planner takeover) serialise on the row: the second one's UPDATE re-evaluates the
  // condition after the first committed, writes nothing and gets the same "already decided" refusal
  // as a request read in a decided state — so the entitlement is never deducted twice.
  const flipped = await app.prisma.leaveRequest.updateMany({
    where: {
      id,
      status: "PENDING",
      deletedAt: null,
      employee: { tenantId: existing.employee.tenantId },
    },
    data: {
      status: input.status,
      reviewedBy: input.reviewerUserId,
      reviewedAt: new Date(),
      reviewNote: input.reviewNote,
      ...(shiftBasedApprovalRecompute
        ? {
            days: shiftBasedApprovalRecompute.days,
            daysProvisional: shiftBasedApprovalRecompute.provisional,
          }
        : {}),
    },
  });
  if (flipped.count === 0) {
    return refusal(409, { error: "Antrag kann nicht mehr geändert werden" }, "NOT_DECIDABLE");
  }
  const updated = await app.prisma.leaveRequest.findFirstOrThrow({
    where: { id, employee: { tenantId: existing.employee.tenantId } },
    include: {
      employee: { select: { firstName: true, lastName: true } },
      leaveType: true,
    },
  });

  if (input.status === "APPROVED") {
    const typeCode = reviewTypeCode;

    if (typeCode === "VACATION") {
      const empForDeduct = await app.prisma.employee.findUnique({
        where: { id: existing.employeeId },
      });
      await deductVacationDays(
        app.prisma,
        existing.employeeId,
        existing.leaveTypeId,
        existing.startDate,
        existing.endDate,
        Number(updated.days),
        new Set(holidayMapForDeduct!.keys()),
        empForDeduct?.tenantId ?? "",
      );
    }

    if (typeCode === "OVERTIME_COMP") {
      const empTenant = await app.prisma.employee.findUnique({
        where: { id: existing.employeeId },
        select: { tenantId: true },
      });
      const tenantIdForBooking = empTenant?.tenantId ?? "";
      const hMap = await getHolidayMap(
        app.prisma,
        tenantIdForBooking,
        existing.employeeId,
        existing.startDate,
        existing.endDate,
      );
      const tzForBooking = await getTenantTimezone(app.prisma, tenantIdForBooking);
      const bookingMinutes = await scheduledLeaveMinutes(
        app.prisma,
        existing.employeeId,
        tenantIdForBooking,
        existing.startDate,
        existing.endDate,
        existing.halfDay,
        new Set(hMap.keys()),
        tzForBooking,
      );
      pendingOvertimeBooking = {
        tenantId: tenantIdForBooking,
        hours: bookingMinutes / 60,
        minutes: bookingMinutes,
        description: `Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]} – ${existing.endDate.toISOString().split("T")[0]}`,
      };
    }

    // ── § 9 BUrlG (Phase 104, D-09): create the sick-during-vacation case ──────────
    // The record is created IMMEDIATELY when the sick note is approved, in the ineffective
    // state AU_PENDING — the vacation days stay charged until a manager confirms the medical
    // certificate (Plan 104-06). Never credit first and reverse later.
    // D-13: this is exactly why the detection hangs on the approve path and not on
    // POST /requests — a sick note that is not yet approved must not create a case.
    if (typeCode === "SICK" || typeCode === "SICK_CHILD") {
      const candidates = await app.prisma.leaveRequest.findMany({
        where: {
          employeeId: existing.employeeId,
          deletedAt: null,
          // Issue #478: sick over a CANCELLATION_REQUESTED request is allowed by the POST
          // guard, so the § 9 case must be detected against it as well (a credit left
          // behind by an approved cancellation is superseded, Issue #662).
          status: { in: [...EFFECTIVE_LEAVE_STATUSES] },
          id: { not: existing.id },
          startDate: { lte: existing.endDate },
          endDate: { gte: existing.startDate },
        },
        include: { leaveType: true },
      });
      const overlaps = findSection9Overlaps(existing.startDate, existing.endDate, candidates);
      for (const ov of overlaps) {
        // Idempotent: re-running approve must not fan out duplicate Vorgänge.
        const dupe = await app.prisma.section9Credit.findFirst({
          where: { sickRequestId: existing.id, vacationRequestId: ov.vacationRequestId },
        });
        if (dupe) continue;
        // Phase 104 review (WR-03): the findFirst/create pair above is NOT in a
        // transaction, so it is a check-then-create race — two concurrent approvals
        // (double click, retry, a manager racing a cron path) both pass the guard.
        // @@unique([sickRequestId, vacationRequestId]) now closes it in the DB; the
        // loser of the race lands here as P2002 and is treated exactly like `dupe`:
        // the Vorgang already exists, so skip it silently rather than 500 the whole
        // approve. Without the constraint a second CONFIRMED row would double-credit
        // the vacation, and the double credit SURVIVES selfHealUsedDays() because the
        // self-heal trusts the credit sum.
        let credit;
        try {
          credit = await app.prisma.section9Credit.create({
            data: {
              employeeId: existing.employeeId,
              sickRequestId: existing.id,
              vacationRequestId: ov.vacationRequestId,
              overlapStart: ov.overlapStart,
              overlapEnd: ov.overlapEnd,
              // status defaults to AU_PENDING
            },
          });
        } catch (err: unknown) {
          if (
            err &&
            typeof err === "object" &&
            "code" in err &&
            (err as { code: unknown }).code === "P2002"
          ) {
            app.log.info(
              { sickRequestId: existing.id, vacationRequestId: ov.vacationRequestId },
              "§ 9: concurrent detection lost the race, Vorgang already exists",
            );
            continue;
          }
          throw err;
        }
        await app.audit({
          userId: input.reviewerUserId,
          action: "SECTION9_CREDIT_DETECTED",
          entity: "Section9Credit",
          entityId: credit.id,
          newValue: {
            sickRequestId: existing.id,
            vacationRequestId: ov.vacationRequestId,
            overlapStart: ov.overlapStart.toISOString().split("T")[0],
            overlapEnd: ov.overlapEnd.toISOString().split("T")[0],
            note: "§ 9 BUrlG — Vorgang erkannt, AU ausstehend",
          },
          request: input.request,
        });

        // ── D-14: notify both sides through the existing bell mechanism ──
        const employeeUser = await app.prisma.employee.findUnique({
          where: { id: existing.employeeId },
          select: { userId: true, tenantId: true },
        });
        // Phase 104 review (WR-05): in Prisma an `undefined` filter value means "omit
        // this filter", not "match nothing". Passing employeeUser?.tenantId into the
        // manager fan-out below would, if the row were ever missing, return EVERY
        // ADMIN/MANAGER across ALL tenants and notify each of them about a foreign
        // tenant's sickness period (plus a deep link into it). The FK is Restrict so
        // this should be unreachable — but the failure mode is a silent cross-tenant
        // broadcast, so it must not depend on that. The Vorgang itself is already
        // created and audited; only the notification fan-out is skipped.
        if (!employeeUser) {
          app.log.error(
            { employeeId: existing.employeeId, creditId: credit.id },
            "§ 9: employee row missing, skipping notification fan-out",
          );
          continue;
        }
        const rangeLabel = `${formatDateDe(ov.overlapStart)} – ${formatDateDe(ov.overlapEnd)}`;
        if (employeeUser.userId) {
          await app.notify({
            userId: employeeUser.userId,
            type: "SECTION9_AU_PENDING_EMPLOYEE",
            title: "AU nachreichen — Urlaubstage stehen auf dem Spiel",
            message:
              `Für ${rangeLabel} liegt eine Krankmeldung während Ihres genehmigten Urlaubs vor. ` +
              `Ohne ärztliche Bescheinigung bleiben diese Urlaubstage angerechnet (§ 9 BUrlG).`,
            link: "/leave",
            tenantId: employeeUser.tenantId,
            relatedType: "Section9Credit",
            relatedId: credit.id,
          });
        }
        // User has no tenantId column — tenant scoping goes through Employee.
        // Phase 75b Plan 10 (#75), D-16: holders of section9:decide replace the legacy A,M
        // role predicate — the recorded recipient set (skipping the acting manager) is
        // unchanged (docs/permissions.md § Empfängersuchen).
        const section9DecideHolderIds = await userIdsHoldingPermission(
          app.prisma,
          employeeUser.tenantId,
          "section9:decide:ZUGEWIESEN",
        );
        // Phase 91b Plan 09 (Issue #91), D-17: narrow to holders whose OWN reach covers this
        // Section9Credit's employee — Stammsalon-only (D-10), Stichtag = the credit's own
        // overlap period start.
        const scopedSection9DecideHolderIds = await resolveScopedHolderIds(
          app.prisma,
          employeeUser.tenantId,
          section9DecideHolderIds,
          "section9:decide:ZUGEWIESEN",
          (reach) =>
            isStammsalonScopeMatch(
              app.prisma,
              employeeUser.tenantId,
              reach,
              existing.employeeId,
              ov.overlapStart,
            ),
        );
        const section9Managers = await app.prisma.employee.findMany({
          where: {
            tenantId: employeeUser.tenantId,
            user: {
              id: { in: scopedSection9DecideHolderIds, not: input.reviewerUserId }, // Phase-91 idiom: never notify the actor
              isActive: true,
            },
          },
          select: { userId: true },
        });
        for (const mgr of section9Managers) {
          await app.notify({
            userId: mgr.userId,
            type: "SECTION9_AU_PENDING_MANAGER",
            title: "§ 9 BUrlG — AU-Nachweis ausstehend",
            message: `Krankmeldung während genehmigten Urlaubs (${rangeLabel}). Sobald die AU vorliegt, bitte bestätigen.`,
            link: `/team/leave?section9=${credit.id}`,
            tenantId: employeeUser.tenantId,
            relatedType: "Section9Credit",
            relatedId: credit.id,
          });
        }
      }
    }
  }

  // Phase 120 (D-01/D-02/D-03): a value-changing operation records before AND after. BOTH actions
  // write the full pair — REJECT does not change `days`, and "unchanged" is a different statement
  // from "not recorded" in a revisionssichere Spur. `status` is part of the pair because only the
  // OLD status answers "was this a first approval or the reversal of a cancellation?".
  await app.audit({
    userId: input.reviewerUserId,
    action: input.status === "APPROVED" ? "APPROVE" : "REJECT",
    entity: "LeaveRequest",
    entityId: id,
    oldValue: auditOldValue,
    newValue: {
      status: updated.status,
      days: Number(updated.days),
      daysProvisional: updated.daysProvisional,
      reviewNote: input.reviewNote,
      ...(leaveLimitException ? { leaveLimitException } : {}),
    },
    // Phase 120 (D-12): CLAUDE.md §Audit-Proof names "userId, timestamp, IP, and before/after
    // values" in ONE sentence — this entry was missing two of those parts, not one. Same call site,
    // same rule, same phase. Verhaltensneutral: `request` is optional on `app.audit`
    // (plugins/audit.ts:13) and feeds nothing but `ipAddress`/`userAgent`.
    request: input.request,
  });

  // Retroactive recalculation: leave approval affects snapshots
  if (input.status === "APPROVED") {
    await recalculateSnapshots(app, existing.employeeId, existing.startDate).catch((err) =>
      app.log.error(
        { err, employeeId: existing.employeeId },
        "Failed to recalculate snapshots after leave approval",
      ),
    );

    // Issue #294: pure read BEFORE the transaction; booking (if any) then persist happen
    // inside ONE `$transaction` — no swallower any more, so a failed persist now answers
    // non-2xx instead of a silent 200 with a stale balance.
    const effectiveBalanceHours = input.deferOvertimeRecompute
      ? null
      : await computeOvertimeBalanceHours(app, existing.employeeId);
    await app.prisma.$transaction(async (tx) => {
      if (pendingOvertimeBooking) {
        // Issue #468 (A-4/D-02): the booked minutes, the journal row and the audit commit
        // together or not at all — written BEFORE bookOvertimeCompensation so
        // "overtimeCompMinutes is set" <=> "the booking was written" even if a later
        // statement in this same transaction fails.
        await tx.leaveRequest.update({
          where: { id: existing.id },
          data: { overtimeCompMinutes: pendingOvertimeBooking.minutes },
        });
        await app.audit({
          tx,
          userId: input.reviewerUserId,
          action: "OVERTIME_COMP_BOOKED",
          entity: "LeaveRequest",
          entityId: existing.id,
          newValue: {
            overtimeCompMinutes: pendingOvertimeBooking.minutes,
            hours: pendingOvertimeBooking.hours,
          },
          request: input.request,
        });
        await bookOvertimeCompensation(
          tx,
          existing.employeeId,
          pendingOvertimeBooking.tenantId,
          pendingOvertimeBooking.hours,
          pendingOvertimeBooking.description,
        );
      }
      // null = §18-exempt, or the caller deferred the recompute (Issue #835, D-835-37): persist
      // nothing, the booking above (if any) still stands as the sole writer for that path.
      if (effectiveBalanceHours !== null) {
        await persistOvertimeBalance(app, tx, existing.employeeId, effectiveBalanceHours);
      }
    });

    // Phase 43-04: reverse-hook — when a leave is APPROVED, mark any
    // existing shifts for this employee on overlapping dates as
    // conflictsWithLeave=true (audit-proof: never silent-delete shifts).
    // Best-effort: never roll back the approval if marking fails.
    // Phase 100B Plan 05 — S2, contexts/scheduling facade (find + flag as ONE operation).
    try {
      const conflictingShifts = await flagShiftsConflictingWithLeave(
        app.prisma,
        existing.employeeId,
        existing.employee.tenantId,
        existing.startDate,
        existing.endDate,
        { halfDay: existing.halfDay },
      );

      if (conflictingShifts.length > 0) {
        // Phase 430 (D-02): the audit loop + recipient-resolution + notify loop that used to
        // live inline here are now ONE shared helper (`contexts/scheduling`), reused by the
        // Phorest sync and the manual shift-planning routes for the new (inverse) direction —
        // a shift created/updated on an already-approved leave day. Behaviour here is
        // byte-identical: same audit rows, same notification text/link, same recipients.
        const empName = await app.prisma.employee.findUnique({
          where: { id: existing.employeeId },
          select: { firstName: true, lastName: true, tenantId: true },
        });
        if (empName) {
          await notifyShiftLeaveConflicts(app, {
            actorUserId: input.reviewerUserId,
            employeeId: existing.employeeId,
            tenantId: empName.tenantId,
            employeeName: { firstName: empName.firstName, lastName: empName.lastName },
            leaveRequestId: existing.id,
            leaveStart: existing.startDate,
            leaveEnd: existing.endDate,
            conflictingShifts,
            request: input.request,
          });
        }
      }
    } catch (err) {
      // Reverse-hook is best-effort — never undo the approval on failure
      app.log.error(
        { err, leaveRequestId: existing.id },
        "Phase 43-04 reverse-hook (mark-conflicting shifts) failed",
      );
    }
  }

  // ── Pro-rata vacation warning on approval (VACATION only, only with an exitDate) ──
  let proRataWarning: { used: number; entitlement: number; message: string } | undefined =
    undefined;
  if (input.status === "APPROVED") {
    const typeCodeForWarning = existing.leaveType.code;
    if (typeCodeForWarning === "VACATION") {
      try {
        const empWithExit = await app.prisma.employee.findUnique({
          where: { id: existing.employeeId },
          select: { exitDate: true, tenantId: true, firstName: true, lastName: true },
        });
        // Issue #447 (D-08): no first-half-year guard any more — § 5 Abs. 1 b BUrlG
        // Teilurlaub can also follow an exit in the second half-year, so a second-half exit
        // can over-use just as well; exitVacationOverUseWarning itself decides, from the
        // (already exit-synced, D-06) persisted row, whether used exceeds entitled.
        if (empWithExit?.exitDate) {
          // Issue #447 WR-01: exitDate is a UTC-midnight @db.Date value — use the UTC
          // accessor to match the sync code (getUTCFullYear()) that keyed the row.
          const exitYear = empWithExit.exitDate.getUTCFullYear();
          const vacLeaveType = await app.prisma.leaveType.findUnique({
            where: {
              tenantId_code: { tenantId: empWithExit.tenantId, code: "VACATION" },
            },
          });
          if (vacLeaveType) {
            const entitlement = await app.prisma.leaveEntitlement.findFirst({
              where: {
                employeeId: existing.employeeId,
                leaveTypeId: vacLeaveType.id,
                year: exitYear,
              },
            });
            if (entitlement) {
              proRataWarning =
                exitVacationOverUseWarning({
                  employeeName: `${empWithExit.firstName} ${empWithExit.lastName}`,
                  exitDate: empWithExit.exitDate,
                  row: entitlement,
                }) ?? undefined;
            }
          }
        }
      } catch (err) {
        app.log.warn({ err }, "Pro-rata warning calculation failed silently in leave review");
      }
    }
  }

  // ── Notification: inform the employee of the decision ──
  const requestEmployee = await app.prisma.employee.findUnique({
    where: { id: existing.employeeId },
  });
  if (requestEmployee) {
    await app.notify({
      userId: requestEmployee.userId,
      type: input.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
      title: input.status === "APPROVED" ? "Antrag genehmigt" : "Antrag abgelehnt",
      message: `Ihr ${existing.leaveType.name}-Antrag wurde ${input.status === "APPROVED" ? "genehmigt" : "abgelehnt"}.`,
      link: `/leave?request=${existing.id}`,
      tenantId: requestEmployee.tenantId,
    });
  }

  // Auto-dismiss manager LEAVE_REQUEST notifications for this request
  try {
    await app.dismissByRelated("LeaveRequest", existing.id);
  } catch (err) {
    app.log.warn(
      { err, leaveRequestId: existing.id },
      "Failed to auto-dismiss LEAVE_REQUEST notifications on review",
    );
  }

  return {
    ok: true,
    updated,
    responseExtras: {
      // Issue #468 (A-4/D-02): `updated` was read BEFORE the tail transaction wrote
      // overtimeCompMinutes — reflect the just-booked value in the response without a
      // second round-trip.
      ...(pendingOvertimeBooking ? { overtimeCompMinutes: pendingOvertimeBooking.minutes } : {}),
      ...(proRataWarning ? { proRataWarning } : {}),
    },
  };
}

/** The APPROVED entry point of the decision core. */
export function approveLeaveRequestCore(
  app: FastifyInstance,
  input: DecideInput,
): Promise<DecideOutcome> {
  return decidePendingLeaveRequest(app, { ...input, status: "APPROVED" });
}
