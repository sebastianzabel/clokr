/**
 * Issue #835 (D-835-12) — the leave-request create core: "how a request for leave is validated,
 * priced and stored".
 *
 * Lifted out of `POST /api/v1/leave/requests` (`api/leave.ts`) so the route and the leave-planner
 * takeover (plan 835-03) create requests through ONE validator instead of two copies. The domain
 * block is moved verbatim (closed month, pricing, Berufsschule-only, overlap, half day, lead time,
 * entitlement, Überstundenausgleich balance, special-leave rule, the price re-read under the
 * employee lock, the CREATE audit, the approver notifications); only the HTTP seams changed — a
 * refusal is returned as data with a stable machine `reason` (a control value, never the German
 * text), the actor is an input. Same shape as `leave-correction.ts` (Issue #614).
 *
 * Contract:
 *   - the CALLER authorizes: `input.employeeId` is the target and is already checked against the
 *     caller's permission and tenant (the route: the two `leave-request:create:…` branches and the
 *     target lookup); the core does no permission check;
 *   - a refusal is `{ ok: false, statusCode, body, reason }`; the route sends `body` unchanged;
 *   - three additive options, all off by default so a plain call is byte-identical to the route
 *     before the move: `auditExtra` (merged at the END of the CREATE `newValue`, absent otherwise),
 *     `notifyApprovers: false` (skips the approver lookup AND the notifications) and
 *     `hooks.inTransaction` (runs inside the locked create transaction; a throw rolls the create
 *     back and reaches the caller).
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22); importers:
 * `api/leave.ts` and, from 835-03, the planner takeover.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { closedMonthLeaveMessage } from "./correction-lock";
import { findClosedMonthsInRange } from "./closed-month-guard";
import { resolveLeaveDays, getHolidayMap } from "./leave-days";
import { BS_ONLY_LEAVE_ERROR, BS_ONLY_LEAVE_ERROR_CODE } from "./bs-leave-days";
import { formatMinutesHM } from "./format-hm";
import { ensureLeaveType } from "./ensure-leave-type";
import { lockEmployeeForLeavePricing } from "./employee-leave-lock";
import { scheduledLeaveMinutes } from "./overtime-comp-minutes";
import { preserveCarryOverDeadline } from "./illness-carryover-guard";
import {
  findBlockingLeaveOverlap,
  leaveDaysUsedInYear,
  LEAVE_OVERLAP_ERROR,
} from "./leave-overlap";
import {
  ensureRegularVacationEntitlement,
  daysDiffer,
  CARRY_OVER_RECALC_REASON,
  REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
  REGULAR_ENTITLEMENT_REASON_ROLLOVER,
  splitLeaveDaysByYear,
  effectiveCarryOverDays,
  carryOverRemainder,
  recalculateCarryOver,
} from "./leave-days";
import { writeEntitlementAudit } from "./entitlement-audit";
import { LEAVE_TYPE_DEFS, LEAVE_REQUEST_EMAIL_SUBJECT, type RequestableCode } from "./leave-type";
import {
  getOvertimeAccount,
  getTenantTimezone,
  getConfirmedCarryOver,
  loadNegativeBalanceTolerance,
} from "../working-time-account";
import {
  userIdsHoldingPermission,
  resolveScopedHolderIds,
  isStammsalonScopeMatch,
} from "../platform";

/** Internal machine marker of a refusal; the route sends `statusCode` + `body` only. */
export type LeaveCreateRefusalReason =
  | "CLOSED_MONTH"
  | "BS_ONLY"
  | "OVERLAP"
  | "HALF_DAY_SICK"
  | "HALF_DAY_NOT_ALLOWED"
  | "LEAD_TIME"
  | "MAX_ADVANCE"
  | "MAX_DAYS_PER_YEAR"
  | "INSUFFICIENT_DAYS_YEAR_1"
  | "INSUFFICIENT_DAYS_YEAR_2"
  | "OVERTIME_COMP_BALANCE"
  | "SPECIAL_RULE_REQUIRED"
  | "SPECIAL_RULE_INVALID"
  | "SPECIAL_RULE_DAYS"
  | "PRICE_CHANGED";

/** The fields of the route's parsed `createSchema` output that the moved block reads. */
export interface CreateLeaveRequestBody {
  type: RequestableCode;
  /** YYYY-MM-DD, already Zod-parsed. */
  startDate: string;
  /** YYYY-MM-DD, already Zod-parsed. */
  endDate: string;
  halfDay: boolean;
  note?: string | null;
  specialLeaveRuleId?: string | null;
}

export interface CreateLeaveRequestInput {
  tenantId: string;
  /** The target employee — already authorised by the caller. */
  employeeId: string;
  /** Audit `userId` of the CREATE row (the route's `req.user.sub`). */
  actorUserId: string;
  body: CreateLeaveRequestBody;
  /** A manager files the request for someone else: the audit carries `source` + `targetEmployeeId`. */
  isOnBehalfOf: boolean;
  /** Merged at the END of the CREATE audit `newValue` when given; no key otherwise. */
  auditExtra?: Record<string, unknown>;
  /** Default true. `false` skips the approver recipient lookup and every notification. */
  notifyApprovers?: boolean;
}

export interface CreateLeaveRequestHooks {
  /**
   * Runs right after `tx.leaveRequest.create`, inside the locked create transaction
   * (`lockEmployeeForLeavePricing` is still its first statement). A throw rolls the create back;
   * the core never catches it.
   */
  inTransaction?: (tx: Prisma.TransactionClient, row: { id: string }) => Promise<void>;
}

/** The created row exactly as `POST /requests` used it. */
export type CreatedLeaveRequestRow = Prisma.LeaveRequestGetPayload<{
  include: { leaveType: true; employee: { select: { firstName: true; lastName: true } } };
}>;

export interface LeaveCreateRefusal {
  ok: false;
  statusCode: 400 | 404 | 409;
  body: { error: string; code?: string; [key: string]: unknown };
  reason: LeaveCreateRefusalReason;
}

export type CreateLeaveRequestOutcome =
  { ok: true; request: CreatedLeaveRequestRow; pricedDays: number } | LeaveCreateRefusal;

function refusal(
  statusCode: LeaveCreateRefusal["statusCode"],
  body: LeaveCreateRefusal["body"],
  reason: LeaveCreateRefusalReason,
): LeaveCreateRefusal {
  return { ok: false, statusCode, body, reason };
}

export async function createLeaveRequestCore(
  app: FastifyInstance,
  input: CreateLeaveRequestInput,
  hooks?: CreateLeaveRequestHooks,
): Promise<CreateLeaveRequestOutcome> {
  const { tenantId, employeeId, isOnBehalfOf } = input;
  const body = input.body;
  const start = new Date(body.startDate);
  const end = new Date(body.endDate);

  // Issue #446 (D-06(a)/D-09/D-10): checked before any read-dependent computation and
  // before every write — a range touching a closed month is rejected as a whole, naming
  // every closed month it spans (never just the first one found).
  const closedMonths = await findClosedMonthsInRange(app.prisma, employeeId, tenantId, start, end);
  if (closedMonths.length > 0) {
    return refusal(
      409,
      {
        error: closedMonthLeaveMessage(closedMonths, "request"),
        code: "LEAVE_MONTH_CLOSED",
      },
      "CLOSED_MONTH",
    );
  }

  const holidayMap = await getHolidayMap(app.prisma, tenantId, employeeId, start, end);
  const holidays = new Set(holidayMap.keys());
  // Phase 107 (D-09): roster-aware estimate from creation onward, so the number does not
  // visibly jump at approval. daysProvisional itself stays null until approval (D-10) --
  // only `.days` is used here, `.provisional` is deliberately discarded.
  // Issue #436 (D-04): priced against the employee's other counted VACATION requests
  // sharing an ISO week — no id yet, so there is nothing to exclude.
  const { days, vocationalSchoolOnly } = await resolveLeaveDays(
    app.prisma,
    employeeId,
    tenantId,
    start,
    end,
    body.halfDay,
    holidays,
    { mode: "request", leaveTypeCode: body.type },
  );

  // Issue #448 (D-02): a request whose every chargeable day is a Berufsschultag is
  // rejected before any write — the owner's binding text (01.10.2026), no LeaveRequest row
  // is ever created.
  if (vocationalSchoolOnly) {
    return refusal(400, { error: BS_ONLY_LEAVE_ERROR, code: BS_ONLY_LEAVE_ERROR_CODE }, "BS_ONLY");
  }

  // Check the overlap with the person's own requests.
  //
  // Phase 104 / R1: § 9 BUrlG — when an employee falls ill during approved leave, the certified
  // days must not count against the annual leave. Until Phase 104 this guard blocked exactly that
  // case with 409, so managers cancelled as a workaround and ended in the four-eyes dead end.
  //
  // The exception is DELIBERATELY narrow and directed (Pitfall 4): only a SICK/SICK_CHILD report
  // over an already APPROVED non-sick request is allowed. Same-kind overlaps (leave/leave,
  // sick/sick) and overlaps with still PENDING requests stay blocked — removing the guard
  // wholesale would reopen the double booking it exists against.
  //
  // Issue #478: the blocking set is PENDING plus EFFECTIVE_LEAVE_STATUSES — a request in
  // CANCELLATION_REQUESTED is still active leave until the cancellation is approved
  // (CLAUDE.md "Leave Cancellation Flow"), so a new request over it is a double booking
  // too. The § 9 exception is the same set: sick over CANCELLATION_REQUESTED stays allowed
  // exactly like over APPROVED. Two half days on one date stay an overlap (owner
  // decision 25.10.2026).
  const isSickRequest = body.type === "SICK" || body.type === "SICK_CHILD";
  const blockingOverlap = await findBlockingLeaveOverlap(app.prisma, {
    employeeId,
    start,
    end,
    isSickRequest,
  });
  if (blockingOverlap) return refusal(409, { error: LEAVE_OVERLAP_ERROR }, "OVERLAP");

  // Load tenant config for leave rules
  const tenantConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });

  const leaveTypeId = await ensureLeaveType(app.prisma, app.log, tenantId, body.type);
  const leaveType = await app.prisma.leaveType.findUnique({ where: { id: leaveTypeId } });

  // ── Half-day sick rejection ──
  // Legal: there is no partial incapacity for work; sick leave is always credited for the
  // whole day (EFZG §3/§4). Half-day only applies to vacation.
  if (body.halfDay && ["SICK", "SICK_CHILD"].includes(body.type)) {
    return refusal(
      400,
      {
        error:
          "Halbe Kranktage sind nicht zulässig — Krankheit wird immer ganztägig gutgeschrieben.",
      },
      "HALF_DAY_SICK",
    );
  }

  // ── Half-day check ──
  if (body.halfDay) {
    const globalHalfDay = tenantConfig?.halfDayAllowed ?? true;
    const typeHalfDay = leaveType?.allowHalfDay ?? true;
    if (!globalHalfDay || !typeHalfDay) {
      return refusal(
        400,
        { error: "Halbe Tage sind für diesen Abwesenheitstyp nicht erlaubt" },
        "HALF_DAY_NOT_ALLOWED",
      );
    }
  }

  // ── Lead time check (not for sick types) ──
  const isSickType = ["SICK", "SICK_CHILD"].includes(body.type);
  if (!isSickType) {
    const leadTimeDays = leaveType?.leadTimeDays ?? tenantConfig?.vacationLeadTimeDays ?? 0;
    if (leadTimeDays > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const diffMs = start.getTime() - today.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays < leadTimeDays) {
        return refusal(
          400,
          {
            error: `Abwesenheit muss mindestens ${leadTimeDays} Tage im Voraus beantragt werden`,
          },
          "LEAD_TIME",
        );
      }
    }

    // ── Max advance months check ──
    const maxAdvanceMonths = tenantConfig?.vacationMaxAdvanceMonths ?? 0;
    if (maxAdvanceMonths > 0) {
      const maxDate = new Date();
      maxDate.setMonth(maxDate.getMonth() + maxAdvanceMonths);
      if (end > maxDate) {
        return refusal(
          400,
          {
            error: `Abwesenheit darf maximal ${maxAdvanceMonths} Monate im Voraus beantragt werden`,
          },
          "MAX_ADVANCE",
        );
      }
    }
  }

  // ── Max days per year check ──
  if (leaveType?.maxDaysPerYear) {
    // Issue #478: shared with the PENDING edit — a request in CANCELLATION_REQUESTED is
    // still active leave and keeps using up the quota.
    const used = await leaveDaysUsedInYear(app.prisma, { employeeId, leaveTypeId, start });
    if (used + days > leaveType.maxDaysPerYear) {
      return refusal(
        400,
        {
          error: `Max. ${leaveType.maxDaysPerYear} Tage/Jahr für diesen Typ (bereits ${used} genutzt)`,
        },
        "MAX_DAYS_PER_YEAR",
      );
    }
  }

  // Für VACATION: Resturlaub auto-übertragen (lazy) + verfügbare Tage prüfen
  //
  // Issue #445 (D-08/D-09/P-15): UTC year boundaries, symmetric with deductVacationDays()/
  // reverseVacationDays(). A cross-year request is split chronologically through
  // splitLeaveDaysByYear() — the SAME day count the request itself was priced with above
  // (resolveLeaveDays) — instead of re-deriving each year's count from the placeholder
  // workDays array via splitDaysAcrossYears (a missing row used to also skip this entirely,
  // see the ensureRegularVacationEntitlement calls below, D-04).
  if (body.type === "VACATION") {
    const year1 = start.getUTCFullYear();
    const year2 = end.getUTCFullYear();
    const isCrossYear = year1 !== year2;

    const split = isCrossYear
      ? await splitLeaveDaysByYear(app.prisma, employeeId, tenantId, start, end, days, holidays)
      : { year1Days: days, year2Days: 0, year1, year2 };

    // ── Year 1: check entitlement ──
    await autoCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year1);
    // Issue #445 D-04: a missing row used to skip the availability check entirely —
    // ensureRegularVacationEntitlement() creates it (with the regular entitlement, never a
    // hard-coded zero) before the check below ever runs.
    const { entitlement: ent1 } = await ensureRegularVacationEntitlement(
      app.prisma,
      employeeId,
      tenantId,
      year1,
      leaveTypeId,
      REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
    );
    if (split.year1Days > 0) {
      // EuGH C-684/16: pre-fetch whether a warning was issued for this entitlement
      const hinweis1 =
        (await app.prisma.auditLog.count({
          where: { action: "CARRYOVER_WARNED", entity: "LeaveEntitlement", entityId: ent1.id },
        })) > 0;
      const co1 = await effectiveCarryOverDays(app.prisma, { ...ent1, tenantId }, start, hinweis1);
      // Issue #447 (D-06) — the row is exit-aware (ensureRegularVacationEntitlement synced
      // it just above) and carry-over is never pro-rated (§ 7 Abs. 3 BUrlG), so totalDays +
      // effective carry − used is the whole rule. No second exit-pro-rata reduction is
      // applied on top (the old H1-exit branch double-reduced an already-exit-prorated row).
      const avail1 = Number(ent1.totalDays) + co1 - Number(ent1.usedDays);

      if (split.year1Days > avail1) {
        return refusal(
          400,
          {
            error: `Nicht genug Urlaubstage in ${year1}`,
            available: avail1,
            requested: split.year1Days,
          },
          "INSUFFICIENT_DAYS_YEAR_1",
        );
      }
    }

    // ── Year 2: check entitlement (cross-year only) ──
    if (isCrossYear && split.year2Days > 0) {
      await autoCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year2);

      // Recalculate projected carry-over for year 2
      // (remaining from year 1 after this booking)
      await recalculateCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year2);

      // Issue #445 D-04: same reasoning as year 1 — a missing row used to skip this check
      // entirely.
      const { entitlement: ent2 } = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        tenantId,
        year2,
        leaveTypeId,
        REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
      );
      // EuGH C-684/16: pre-fetch whether a warning was issued for this entitlement
      const hinweis2 =
        (await app.prisma.auditLog.count({
          where: {
            action: "CARRYOVER_WARNED",
            entity: "LeaveEntitlement",
            entityId: ent2.id,
          },
        })) > 0;
      const co2 = await effectiveCarryOverDays(app.prisma, { ...ent2, tenantId }, end, hinweis2);
      // Issue #447 (D-06) — same rule as year 1: ent2 is already exit-aware, no second
      // exit-pro-rata cap on top.
      const avail2 = Number(ent2.totalDays) + co2 - Number(ent2.usedDays);

      if (split.year2Days > avail2) {
        return refusal(
          400,
          {
            error: `Nicht genug Urlaubstage in ${year2}`,
            available: avail2,
            requested: split.year2Days,
          },
          "INSUFFICIENT_DAYS_YEAR_2",
        );
      }
    }
  }

  // For OVERTIME_COMP: check the overtime balance (based on the real schedule)
  //
  // Code review (owner) — this used to read OvertimeAccount.balanceHours directly, the
  // SAME stale event-driven source 97-CONTEXT names as wrong (v1.8.24 already overrides it
  // at read time everywhere else) and, worse, the LIVE total (confirmed + open-month
  // forecast), while the leave form's own affordability UI (97-06) validates against the
  // CONFIRMED (closed-month) carry-over only — never against a forecast that can still
  // erode. This is a WRITE path touching entitlement, so {@link overtimeCompBalanceRejection}'s
  // fail-safe branch intentionally falls back to the PRE-EXISTING stored-balance check (never
  // 500, never silently permits an unbounded request) rather than inventing a new default.
  // Issue #468 (D-01): the needed amount comes from `scheduledLeaveMinutes` — the SAME
  // function the saldo and the booking/reversal use — not a `{day}Hours` placeholder sum.
  if (body.type === "OVERTIME_COMP") {
    const tzForGate = await getTenantTimezone(app.prisma, tenantId);
    const neededMinutes = await scheduledLeaveMinutes(
      app.prisma,
      employeeId,
      tenantId,
      start,
      end,
      body.halfDay,
      holidays,
      tzForGate,
    );
    const rejection = await overtimeCompBalanceRejection(app, employeeId, tenantId, neededMinutes);
    if (rejection) {
      return refusal(400, rejection, "OVERTIME_COMP_BALANCE");
    }
  }

  // Für SPECIAL: specialLeaveRuleId required, validate days against rule
  if (body.type === "SPECIAL") {
    if (!body.specialLeaveRuleId) {
      return refusal(
        400,
        { error: "Sonderurlaub erfordert einen Anlass (specialLeaveRuleId)" },
        "SPECIAL_RULE_REQUIRED",
      );
    }
    // #223: SpecialLeaveRule has its own tenantId — a client-supplied
    // specialLeaveRuleId must be scoped to the caller's tenant, otherwise a
    // tenant could reference (and consume) another tenant's rule. findUnique
    // cannot take a second field, hence findFirst.
    const rule = await app.prisma.specialLeaveRule.findFirst({
      where: { id: body.specialLeaveRuleId, tenantId },
    });
    if (!rule || !rule.isActive) {
      return refusal(
        400,
        { error: "Ungültiger oder deaktivierter Sonderurlaubs-Anlass" },
        "SPECIAL_RULE_INVALID",
      );
    }
    if (days > Number(rule.defaultDays)) {
      return refusal(
        400,
        {
          error: `Max. ${Number(rule.defaultDays)} Tage für "${rule.name}" (beantragt: ${days})`,
        },
        "SPECIAL_RULE_DAYS",
      );
    }
  }

  // Issue #467: price + insert are serialised per employee. The estimate above was read
  // without a lock, so two concurrent requests for the same ISO week each priced the week in
  // full. Under the Employee row lock the price is read AGAIN (it now sees every request the
  // previous writer committed) and that price is the one stored. A price that went UP in
  // between (an earlier request was withdrawn meanwhile) is not silently stored — it was
  // validated against the lower estimate — the caller retries.
  const created = await app.prisma.$transaction(async (tx) => {
    await lockEmployeeForLeavePricing(tx, tenantId, employeeId);
    const locked = await resolveLeaveDays(
      tx,
      employeeId,
      tenantId,
      start,
      end,
      body.halfDay,
      holidays,
      { mode: "request", leaveTypeCode: body.type },
    );
    if (locked.days > days) return null;
    const row = await tx.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        specialLeaveRuleId: body.specialLeaveRuleId ?? null,
        startDate: start,
        endDate: end,
        days: locked.days,
        halfDay: body.halfDay,
        note: body.note,
      },
      include: {
        leaveType: true,
        employee: { select: { firstName: true, lastName: true } },
      },
    });
    // Issue #835 (D-835-12): the caller's write rides in the same locked transaction as the
    // insert; a throw here rolls the create back.
    await hooks?.inTransaction?.(tx, { id: row.id });
    return { row, days: locked.days };
  });
  if (!created) {
    return refusal(
      409,
      {
        error: "Die Urlaubstage haben sich gerade geändert — bitte erneut versuchen.",
        code: "LEAVE_PRICE_CHANGED",
      },
      "PRICE_CHANGED",
    );
  }
  const request = created.row;
  const pricedDays = created.days;

  await app.audit({
    userId: input.actorUserId,
    action: "CREATE",
    entity: "LeaveRequest",
    entityId: request.id,
    newValue: {
      type: body.type,
      startDate: body.startDate,
      endDate: body.endDate,
      days: pricedDays,
      ...(isOnBehalfOf && {
        source: "MANAGER_CREATED",
        // Issue #539 (D-13): no actorRole on new rows (the actor is the row's userId); existing
        // rows keep theirs - the audit log is append-only.
        targetEmployeeId: employeeId,
      }),
      // Issue #835 (D-835-13): a caller-supplied marker (e.g. the planner takeover) goes last;
      // without it no key is added.
      ...(input.auditExtra ?? {}),
    },
  });

  // Issue #835 (D-835-12/P-10): the planner takeover that approves in the same run passes
  // `notifyApprovers: false`, so approvers are not pinged once per wish; a plain call notifies.
  if (input.notifyApprovers !== false) {
    // ── Benachrichtigung: Manager über neuen Antrag informieren ──
    // Issue #200: title and phrase both come from the single LEAVE_TYPE_DEFS mapping and are
    // display text only (ADR 0001, never compared). The mail subject is deliberately neutral
    // while the in-app title is type-specific (owner decision 2026-09-15).
    const typeDef = LEAVE_TYPE_DEFS[body.type];
    // Phase 75b Plan 10 (#75), D-16: holders of leave-request:approve replace the legacy A,M
    // role predicate — the recorded recipient set is unchanged (docs/permissions.md §
    // Empfängersuchen).
    const leaveRequestApproveHolderIds = await userIdsHoldingPermission(
      app.prisma,
      tenantId,
      "leave-request:approve:ZUGEWIESEN",
    );
    // Phase 91b Plan 09 (Issue #91), D-17: narrow the tenant-wide holder list to holders whose
    // OWN reach covers the request's own employee — Stammsalon-only (D-10), Stichtag = the
    // request's own startDate (the affected period, not "today").
    const scopedLeaveRequestApproveHolderIds = await resolveScopedHolderIds(
      app.prisma,
      tenantId,
      leaveRequestApproveHolderIds,
      "leave-request:approve:ZUGEWIESEN",
      (reach) =>
        isStammsalonScopeMatch(app.prisma, tenantId, reach, request.employeeId, request.startDate),
    );
    const managers = await app.prisma.user.findMany({
      where: {
        id: { in: scopedLeaveRequestApproveHolderIds },
        isActive: true,
        employee: { tenantId: tenantId },
      },
      select: { id: true },
    });
    for (const mgr of managers) {
      await app.notify({
        userId: mgr.id,
        type: "LEAVE_REQUEST",
        title: typeDef.notificationTitle,
        message: `${request.employee.firstName} ${request.employee.lastName} ${typeDef.requestPhrase} (${body.startDate} – ${body.endDate})`,
        // Manager-facing: link to the approval surface (/team/leave honors ?request=),
        // NOT /leave (which only shows the recipient's OWN requests).
        link: `/team/leave?request=${request.id}`,
        tenantId,
        relatedType: "LeaveRequest",
        relatedId: request.id,
        emailSubject: LEAVE_REQUEST_EMAIL_SUBJECT,
      });
    }
  }

  return { ok: true, request, pricedDays };
}

/**
 * Automatically carries over the previous year's unused vacation days into the current year as
 * Resturlaub — unless that has already happened. Called lazily on every leave request and
 * account read.
 *
 * Issue #445 (D-04): a missing current-year row used to be created here with a hard-coded
 * `totalDays: 0` — now `ensureRegularVacationEntitlement()` creates (or heals) it with the
 * regular yearly entitlement instead, through the same wrapper `recalculateCarryOver()` uses.
 */
export async function autoCarryOver(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  year: number,
): Promise<void> {
  const prevYear = year - 1;

  // Fetch the previous year's entitlement.
  const prev = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: prevYear } },
  });
  if (!prev) return;

  // Issue #445 (D-14): the effective (FIFO) remainder — an expired, untaken carry never
  // returns the following year.
  const remaining = await carryOverRemainder(prisma, prev, tenantId);
  if (remaining <= 0) return;

  // Already carried over? -> abort (idempotent).
  const alreadyCarried = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });
  if (alreadyCarried && Number(alreadyCarried.carriedOverDays) > 0) return;

  // Expiry deadline from TenantConfig.
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId } });
  const deadlineDay = config?.carryOverDeadlineDay ?? 31;
  const deadlineMonth = config?.carryOverDeadlineMonth ?? 3;
  const deadline = new Date(year, deadlineMonth - 1, deadlineDay, 23, 59, 59);

  const { entitlement: cur } = await ensureRegularVacationEntitlement(
    prisma,
    employeeId,
    tenantId,
    year,
    leaveTypeId,
    REGULAR_ENTITLEMENT_REASON_ROLLOVER,
  );

  // Phase 104 (D-19), generalised by Issue #445 (D-16/D-17): see recalculateCarryOver — same
  // documented-reason deadline protection.
  const deadlineProtected = preserveCarryOverDeadline(cur);
  await prisma.leaveEntitlement.update({
    where: { id: cur.id },
    data: deadlineProtected
      ? { carriedOverDays: remaining }
      : { carriedOverDays: remaining, carryOverDeadline: deadline },
  });
  if (daysDiffer(Number(cur.carriedOverDays), remaining)) {
    await writeEntitlementAudit(prisma, {
      action: "UPDATE",
      entityId: cur.id,
      oldValue: { carriedOverDays: Number(cur.carriedOverDays) },
      newValue: { carriedOverDays: remaining, reason: CARRY_OVER_RECALC_REASON },
    });
  }
}
/**
 * Issue #468 (D-01) — the shared Überstundenausgleich negative-balance gate, lifted out of
 * `POST /requests` so the PENDING edit (`PATCH /requests/:id`) can run the SAME check instead of
 * the gap D-01 found (an employee widening a still-PENDING request could pass the limit the
 * initial POST already enforced). Logic is byte-identical to the original POST-only gate —
 * tolerance chain, confirmed carry-over, zero-tolerance fail-safe fallback — only the needed
 * amount is now a caller-supplied minutes figure (from {@link scheduledLeaveMinutes}) rather than
 * recomputed here.
 *
 * Phase 100 (OTC-01/OTC-02, D-00a/D-00b) — availability also includes the configured
 * `maxNegativeBalanceMinutes` TOLERANCE, resolved through the SAME precedence chain overtime.ts
 * uses (loadNegativeBalanceTolerance, negative-balance-tolerance.ts): per-employee WorkSchedule
 * override > tenant default > null. D-00b: for THIS booking gate, an unconfigured (`null`) value
 * means a tolerance of ZERO — the opposite of the schema comment's "unbegrenzt" ALERTING reading
 * that `isNegativeLimitExceeded` uses elsewhere — so with nothing configured this gate stays
 * byte-identical to pre-Phase-100. D-02: the catch branch below applies ZERO tolerance regardless
 * of what is configured — a read failure must never be MORE generous than the normal path. D-04:
 * the comparison itself happens in MINUTES; hours only appear in the response body/rejection copy.
 *
 * Returns `null` when the request is affordable, otherwise the 400 response body.
 */
export async function overtimeCompBalanceRejection(
  app: FastifyInstance,
  employeeId: string,
  tenantId: string,
  neededMinutes: number,
): Promise<{ error: string; available: number; requested: number; tolerance: number } | null> {
  const { toleranceMinutes } = await loadNegativeBalanceTolerance(app.prisma, employeeId, tenantId);

  let availableMinutes: number;
  let appliedToleranceMinutes: number;
  try {
    const confirmed = await getConfirmedCarryOver(app.prisma, employeeId, tenantId);
    appliedToleranceMinutes = toleranceMinutes;
    availableMinutes = confirmed.minutes + appliedToleranceMinutes;
  } catch (err) {
    app.log.warn(
      { err, employeeId },
      "OVERTIME_COMP balance gate: getConfirmedCarryOver failed, falling back to stored OvertimeAccount.balanceHours",
    );
    // D-02: fail-safe applies ZERO tolerance — a broken read path must never be more
    // permissive than the normal path.
    appliedToleranceMinutes = 0;
    const account = await getOvertimeAccount(app.prisma, employeeId, tenantId);
    availableMinutes = account ? Math.round(Number(account.balanceHours) * 60) : 0;
  }

  if (neededMinutes > availableMinutes) {
    // OTC-06 / D-14: names the applied tolerance when one was applied; the
    // "(inkl. … erlaubtem Minus)" clause is omitted entirely at tolerance 0 so an unconfigured
    // tenant sees the plain pre-Phase-100 message (100-UI-SPEC.md "Rejection copy").
    const toleranceClause =
      appliedToleranceMinutes > 0
        ? ` (inkl. ${formatMinutesHM(appliedToleranceMinutes)} Std. erlaubtem Minus)`
        : "";
    return {
      error:
        `Nicht genug Überstunden: verfügbar ${formatMinutesHM(availableMinutes)} Std.` +
        `${toleranceClause}, benötigt ${formatMinutesHM(neededMinutes)} Std.`,
      available: +(availableMinutes / 60).toFixed(2),
      requested: +(neededMinutes / 60).toFixed(2),
      tolerance: +(appliedToleranceMinutes / 60).toFixed(2),
    };
  }
  return null;
}
