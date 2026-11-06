/**
 * Issue #835 (D-835-13/14/15/17, D-835-35) — the takeover of a leave plan: every active wish
 * becomes a real leave request through the SAME create core as `POST /leave/requests`, and the
 * wishes the taker may approve are approved through the SAME decision core as the review route.
 * Nothing here validates a request itself (D-835-12): a refusal of a core is stored on the wish and
 * listed in the result, the wish stays.
 *
 * Per wish, in deterministic order (person id, start date, wish id), each in its own short
 * transactions — a partial run keeps what succeeded and a re-run never duplicates:
 *   1. the wish is RE-READ at the start of its iteration (gone, removed or linked → skipped); a
 *      linked wish is only handled when its approval was refused earlier (`APPROVAL_…`, D-835-30);
 *   2. the employment window and the Stammsalon are re-checked at takeover time (D-835-24, D-05):
 *      a lapsed one is stored as a refusal on the wish, nothing is created;
 *   3. a wish the taker will approve is pre-checked against the #836 limits with the wish as
 *      candidate (D-835-29): an exceedance without a per-wish reason is stored as
 *      `LEAVE_LIMIT_EXCEPTION_REQUIRED`, nothing is created;
 *   4. `createLeaveRequestCore` creates the request on behalf of the person (actor = the taker,
 *      CREATE audit with `trigger`, `leavePlanId`, `leavePlanWishId`); its `inTransaction` hook
 *      locks the wish row `FOR UPDATE` and links it, so a request is only ever linked to a wish
 *      whose stored dates it equals (a wish moved or removed meanwhile rolls the create back);
 *   5. only a wish the taker may approve (not the taker's own, inside the approve reach) is
 *      approved; any other stays PENDING for a second approver (four-eyes). A re-run retries the
 *      approval only and never approves a deliberately PENDING request.
 * After every create the loop waits until the clock is past the row's `createdAt`, so requests of
 * one run carry strictly increasing `createdAt` in start order (SHIFT_BASED marginal pricing sorts
 * siblings by `createdAt`, D-835-27).
 * The approvals defer the live-saldo recompute (D-835-37): after the loop the stored overtime balance
 * is refreshed ONCE per distinct approved person with a wish starting before the tenant-local today
 * (the live saldo never includes today, #438, and a future leave cannot change it) - reactively, a
 * failure is logged with ids only and never fails the takeover.
 * A last short transaction locks the plan row `FOR UPDATE`, closes the plan when no wish is left
 * open and writes ONE summary audit row with ids and counts only.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { homeSalonsForDays, isStammsalonScopeMatch, type AccessReach } from "../../platform";
import { getTenantTimezone, todayInTz, updateOvertimeAccount } from "../../working-time-account";
import { createLeaveRequestCore } from "../leave-request-create";
import {
  approveLeaveRequestCore,
  leaveDecisionGuard,
  loadLeaveRequestForReview,
  type AuditRequestMeta,
} from "../leave-decision";
import {
  evaluateLeaveLimits,
  LEAVE_LIMIT_EXCEPTION_REQUIRED,
  leaveLimitExceptionRequiredBody,
} from "../leave-limits";
import { isHomedInSalonOnAnyDay } from "../salon-leave-attribution";
import {
  APPROVAL_REFUSAL_PREFIX,
  LEAVE_PLAN_MESSAGES,
  LEAVE_PLAN_TRIGGER,
  LEAVE_PLAN_WISH_NOT_EMPLOYED,
  LEAVE_PLAN_WISH_NOT_IN_SALON,
} from "./constants";
import { dayOf } from "./wish-rules";
import { employedOnEveryWishDay } from "./wish-write";

export type TakeoverPendingReason = "OWN_WISH" | "OUTSIDE_APPROVE_REACH" | "APPROVAL_REFUSED";

export type TakeoverResult = {
  created: Array<{ wishId: string; employeeId: string; leaveRequestId: string }>;
  pending: Array<{
    wishId: string;
    employeeId: string;
    leaveRequestId: string;
    reason: TakeoverPendingReason;
  }>;
  refused: Array<{ wishId: string; employeeId: string; code: string; error: string }>;
  planStatus: "OPEN" | "TAKEN_OVER";
};

const ONE_AND_HALF_MS_NS = 1_500_000n;

/** Thrown by the link hook when the wish is no longer exactly what the request was created from. */
class WishNotLinkable extends Error {
  constructor() {
    super("wish is not linkable");
    this.name = "WishNotLinkable";
  }
}

type LockedWish = {
  id: string;
  startDate: Date;
  endDate: Date;
  halfDay: boolean;
  deletedAt: Date | null;
  leaveRequestId: string | null;
};

type CreateStep =
  { kind: "created"; leaveRequestId: string } | { kind: "refused" } | { kind: "changed" };

type StoredWish = {
  id: string;
  employeeId: string;
  startDate: Date;
  endDate: Date;
  halfDay: boolean;
  leaveRequestId: string | null;
  refusalCode: string | null;
};

export async function takeOverLeavePlan(
  app: FastifyInstance,
  input: {
    tenantId: string;
    planId: string;
    taker: { userId: string; employeeId: string | null; approveReach: AccessReach };
    /** wishId → reason of the limit exception the taker grants for that wish. */
    limitExceptions: ReadonlyMap<string, string>;
    request: AuditRequestMeta;
  },
): Promise<TakeoverResult> {
  const { tenantId, planId, taker } = input;
  const result: TakeoverResult = { created: [], pending: [], refused: [], planStatus: "OPEN" };
  let skippedCount = 0;
  /** Persons with an approved wish that starts before today: their stored balance is refreshed. */
  const refreshEmployeeIds = new Set<string>();
  const today = todayInTz(await getTenantTimezone(app.prisma, tenantId));

  const plan = await app.prisma.leavePlan.findFirstOrThrow({
    where: { id: planId, tenantId },
    select: { salonId: true },
  });

  // Unlinked wishes, plus linked ones whose approval was refused earlier (retry of the approval
  // only, D-835-30). A linked wish without a refusal is a deliberate four-eyes PENDING request.
  const wishIds = await app.prisma.leavePlanWish.findMany({
    where: {
      planId,
      tenantId,
      deletedAt: null,
      OR: [{ leaveRequestId: null }, { refusalCode: { startsWith: APPROVAL_REFUSAL_PREFIX } }],
    },
    orderBy: [{ employeeId: "asc" }, { startDate: "asc" }, { id: "asc" }],
    select: { id: true },
  });

  /** Reads the active wish as stored NOW; `null` when it is gone or removed. */
  async function readWish(id: string): Promise<StoredWish | null> {
    return app.prisma.leavePlanWish.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true,
        employeeId: true,
        startDate: true,
        endDate: true,
        halfDay: true,
        leaveRequestId: true,
        refusalCode: true,
      },
    });
  }

  /** Reads the wish as stored NOW; `null` when it is gone, removed or already linked. */
  async function readOpenWish(id: string): Promise<StoredWish | null> {
    const wish = await readWish(id);
    return wish && wish.leaveRequestId === null ? wish : null;
  }

  /**
   * Resolves once at least 1.5 ms of MONOTONIC time have passed since `since` (taken right after a
   * create returned). `createdAt` is stamped by the application clock inside the create, so the
   * next create then carries a stamp at least one full millisecond later and the stamps stay
   * strictly increasing after the ms truncation. A monotonic clock, not `Date.now()`: it cannot be
   * rewound or frozen (a test that fakes `Date` must not hang this loop). A poll on `setImmediate`,
   * no fixed sleep.
   */
  async function waitOneTick(since: bigint): Promise<void> {
    while (process.hrtime.bigint() - since < ONE_AND_HALF_MS_NS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Clears the refusal of a wish (a later success supersedes an earlier stored refusal). */
  async function clearRefusal(wishId: string): Promise<void> {
    await app.prisma.leavePlanWish.updateMany({
      where: { id: wishId, tenantId },
      data: { refusalCode: null, refusalMessage: null, refusedAt: null },
    });
  }

  /** Stores a refusal on the wish and lists it in the result; nothing is created. */
  async function refuse(wish: StoredWish, code: string, error: string): Promise<void> {
    await storeRefusal(wish.id, code, error);
    result.refused.push({ wishId: wish.id, employeeId: wish.employeeId, code, error });
  }

  /** True iff the taker may approve this person's request at `startDate` (never their own). */
  async function takerMayApprove(employeeId: string, startDate: Date): Promise<boolean> {
    return (
      taker.employeeId !== employeeId &&
      (await isStammsalonScopeMatch(
        app.prisma,
        tenantId,
        taker.approveReach,
        employeeId,
        startDate,
      ))
    );
  }

  /** Stores a refusal of a core on the wish (system text only, never person-authored). */
  async function storeRefusal(wishId: string, code: string, message: string): Promise<void> {
    await app.prisma.leavePlanWish.updateMany({
      where: { id: wishId, tenantId },
      data: { refusalCode: code, refusalMessage: message, refusedAt: new Date() },
    });
  }

  /**
   * The create step for one wish: the new request id, `refused` when the create core refused
   * (stored on the wish), or `changed` when the wish moved or vanished under the create.
   */
  async function createFor(wish: StoredWish, willApprove: boolean): Promise<CreateStep> {
    const startDay = dayOf(wish.startDate);
    const endDay = dayOf(wish.endDate);
    const linkHook = async (tx: Prisma.TransactionClient, row: { id: string }) => {
      const rows = await tx.$queryRaw<
        LockedWish[]
      >`SELECT "id", "startDate", "endDate", "halfDay", "deletedAt", "leaveRequestId" FROM "LeavePlanWish" WHERE "id" = ${wish.id} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const stored = rows[0];
      if (
        !stored ||
        stored.deletedAt !== null ||
        stored.leaveRequestId !== null ||
        dayOf(stored.startDate) !== startDay ||
        dayOf(stored.endDate) !== endDay ||
        stored.halfDay !== wish.halfDay
      ) {
        throw new WishNotLinkable();
      }
      await tx.leavePlanWish.updateMany({
        where: { id: wish.id, tenantId },
        data: {
          leaveRequestId: row.id,
          takenOverAt: new Date(),
          refusalCode: null,
          refusalMessage: null,
          refusedAt: null,
        },
      });
    };

    try {
      const created = await createLeaveRequestCore(
        app,
        {
          tenantId,
          employeeId: wish.employeeId,
          actorUserId: taker.userId,
          body: { type: "VACATION", startDate: startDay, endDate: endDay, halfDay: wish.halfDay },
          isOnBehalfOf: wish.employeeId !== taker.employeeId,
          auditExtra: {
            trigger: LEAVE_PLAN_TRIGGER,
            leavePlanId: planId,
            leavePlanWishId: wish.id,
          },
          // D-835-35: a request the taker approves in this run does not ping every approver.
          notifyApprovers: !willApprove,
        },
        { inTransaction: linkHook },
      );
      if (!created.ok) {
        await refuse(wish, created.reason, created.body.error);
        return { kind: "refused" };
      }
      // D-835-27: the next create of this run must be stamped strictly after this row's createdAt.
      await waitOneTick(process.hrtime.bigint());
      return { kind: "created", leaveRequestId: created.request.id };
    } catch (error) {
      if (error instanceof WishNotLinkable) return { kind: "changed" };
      throw error;
    }
  }

  /** Approves the just created request as the taker; the refusal (reason + text), or null. */
  async function approveFor(
    leaveRequestId: string,
    exceptionReason: string | undefined,
  ): Promise<{ reason: string; error: string } | null> {
    const existing = await loadLeaveRequestForReview(app, leaveRequestId);
    if (!existing) return { reason: "NOT_DECIDABLE", error: "Antrag nicht gefunden" };
    const guard = await leaveDecisionGuard(app, { existing, reviewerUserId: taker.userId });
    if (guard) return { reason: guard.reason, error: guard.body.error };
    const decided = await approveLeaveRequestCore(app, {
      existing,
      reviewerUserId: taker.userId,
      ...(exceptionReason ? { limitException: { reason: exceptionReason } } : {}),
      // D-835-37: the stored balance is refreshed once per person after the loop.
      deferOvertimeRecompute: true,
      request: input.request,
    });
    return decided.ok ? null : { reason: decided.reason, error: decided.body.error };
  }

  /**
   * Approves the request of a wish; a refusal is stored as `APPROVAL_<reason>` (the request stays
   * PENDING and the next run retries), a success clears every stored refusal of the wish.
   */
  async function approveWish(
    wish: StoredWish,
    leaveRequestId: string,
    exceptionReason: string | undefined,
  ): Promise<void> {
    const refusal = await approveFor(leaveRequestId, exceptionReason);
    if (refusal) {
      await storeRefusal(wish.id, `${APPROVAL_REFUSAL_PREFIX}${refusal.reason}`, refusal.error);
      result.pending.push({
        wishId: wish.id,
        employeeId: wish.employeeId,
        leaveRequestId,
        reason: "APPROVAL_REFUSED",
      });
      return;
    }
    await clearRefusal(wish.id);
    if (wish.startDate.getTime() < today.getTime()) refreshEmployeeIds.add(wish.employeeId);
    result.created.push({ wishId: wish.id, employeeId: wish.employeeId, leaveRequestId });
  }

  /**
   * A linked wish whose earlier approval was refused: approves the SAME request again, when it is
   * still PENDING and the taker may approve it. No second request, no new pre-check (the approval
   * core re-checks the limits fail-closed). A linked wish without an `APPROVAL_…` refusal is never
   * selected here — a deliberate four-eyes PENDING request is not auto-approved.
   */
  async function retryApproval(wish: StoredWish): Promise<void> {
    if (!wish.leaveRequestId || !wish.refusalCode?.startsWith(APPROVAL_REFUSAL_PREFIX)) return;
    const request = await loadLeaveRequestForReview(app, wish.leaveRequestId);
    if (!request || request.employee.tenantId !== tenantId) return;
    if (request.status !== "PENDING") {
      // Decided by someone else meanwhile: the stored refusal is obsolete and must not keep the
      // plan open.
      await clearRefusal(wish.id);
      return;
    }
    if (!(await takerMayApprove(request.employeeId, request.startDate))) return;
    await approveWish(wish, request.id, input.limitExceptions.get(wish.id));
  }

  for (const { id } of wishIds) {
    // The wish is re-read at the start of its iteration: the values used below are the values as
    // stored now, and the link hook proves they are still the stored ones when the request exists.
    const stored = await readWish(id);
    if (!stored) continue;

    if (stored.leaveRequestId !== null) {
      await retryApproval(stored);
      continue;
    }
    let wish: StoredWish | null = stored;
    const startDay = dayOf(wish.startDate);
    const endDay = dayOf(wish.endDate);

    // D-835-24: the employment window may have lapsed since the wish was entered.
    if (!(await employedOnEveryWishDay(app.prisma, tenantId, wish.employeeId, startDay, endDay))) {
      await refuse(
        wish,
        LEAVE_PLAN_WISH_NOT_EMPLOYED,
        LEAVE_PLAN_MESSAGES[LEAVE_PLAN_WISH_NOT_EMPLOYED] ?? LEAVE_PLAN_WISH_NOT_EMPLOYED,
      );
      continue;
    }

    // D-05: the person must still be homed in the plan's salon on a day of the wish.
    const homes = await homeSalonsForDays(
      app.prisma,
      tenantId,
      [wish.employeeId],
      startDay,
      endDay,
    );
    if (!isHomedInSalonOnAnyDay(homes.get(wish.employeeId), plan.salonId, startDay, endDay)) {
      await refuse(
        wish,
        LEAVE_PLAN_WISH_NOT_IN_SALON,
        LEAVE_PLAN_MESSAGES[LEAVE_PLAN_WISH_NOT_IN_SALON] ?? LEAVE_PLAN_WISH_NOT_IN_SALON,
      );
      continue;
    }

    const willApprove = await takerMayApprove(wish.employeeId, wish.startDate);

    // D-835-29: a wish that is approved at once is pre-checked against the #836 limits with the
    // wish as candidate; a wish that stays PENDING gets no pre-check (the approver decides later).
    const exceptionReason = input.limitExceptions.get(wish.id);
    if (willApprove && exceptionReason === undefined) {
      const limits = await evaluateLeaveLimits(app.prisma, tenantId, {
        candidates: [
          {
            requestId: null,
            employeeId: wish.employeeId,
            typeCode: "VACATION",
            startDay,
            endDay,
          },
        ],
        excludeRequestIds: [],
      });
      if (limits.exceedances.length > 0) {
        await refuse(
          wish,
          LEAVE_LIMIT_EXCEPTION_REQUIRED,
          leaveLimitExceptionRequiredBody([]).error,
        );
        continue;
      }
    }

    let step = await createFor(wish, willApprove);
    if (step.kind === "changed") {
      // Moved, removed or linked meanwhile: retry ONCE with the fresh values, else skip this run.
      wish = await readOpenWish(id);
      step = wish ? await createFor(wish, willApprove) : step;
      if (step.kind === "changed") {
        skippedCount += 1;
        continue;
      }
    }
    if (step.kind === "refused" || !wish) continue;

    const leaveRequestId = step.leaveRequestId;
    if (!willApprove) {
      result.pending.push({
        wishId: wish.id,
        employeeId: wish.employeeId,
        leaveRequestId,
        reason: taker.employeeId === wish.employeeId ? "OWN_WISH" : "OUTSIDE_APPROVE_REACH",
      });
      continue;
    }
    await approveWish(wish, leaveRequestId, exceptionReason);
  }

  // D-835-37: refresh the stored overtime balance once per person whose approved leave can have
  // moved the live saldo (reactive: a failure is logged and never fails the takeover).
  for (const employeeId of refreshEmployeeIds) {
    try {
      await updateOvertimeAccount(app, employeeId);
    } catch (err) {
      app.log.warn({ err, employeeId }, "Failed to refresh the overtime balance after a takeover");
    }
  }

  // D-835-15/D-835-30: the plan closes only when no active wish is left without a request or with
  // a request whose approval was refused (a re-run can still fix that).
  result.planStatus = await app.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "LeavePlan" WHERE "id" = ${planId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const stillOpen = await tx.leavePlanWish.count({
      where: {
        planId,
        tenantId,
        deletedAt: null,
        OR: [{ leaveRequestId: null }, { refusalCode: { startsWith: APPROVAL_REFUSAL_PREFIX } }],
      },
    });
    let planStatus: TakeoverResult["planStatus"] = "OPEN";
    if (stillOpen === 0) {
      const closed = await tx.leavePlan.updateMany({
        where: { id: planId, tenantId, status: "OPEN" },
        data: { status: "TAKEN_OVER", takenOverAt: new Date(), takenOverByUserId: taker.userId },
      });
      if (closed.count > 0) {
        planStatus = "TAKEN_OVER";
      } else {
        // A concurrent run closed the plan first: report what is stored, not what this run did.
        const current = await tx.leavePlan.findFirst({
          where: { id: planId, tenantId },
          select: { status: true },
        });
        planStatus = current?.status ?? "OPEN";
      }
    }
    // Ids and counts only — no free text (D-835-08).
    await app.audit({
      userId: taker.userId,
      action: "LEAVE_PLAN_TAKEN_OVER",
      entity: "LeavePlan",
      entityId: planId,
      newValue: {
        createdWishIds: result.created.map((c) => c.wishId),
        pendingWishIds: result.pending.map((p) => p.wishId),
        refusedWishIds: result.refused.map((r) => r.wishId),
        createdCount: result.created.length,
        pendingCount: result.pending.length,
        refusedCount: result.refused.length,
        skippedCount,
        planStatus,
      },
      request: input.request,
      tx,
    });
    return planStatus;
  });

  // D-835-18: the announcement is obsolete once the plan is closed (reactive, after the commit).
  if (result.planStatus === "TAKEN_OVER") {
    try {
      await app.dismissByRelated("LeavePlan", planId, "LEAVE_PLAN_OPENED");
    } catch (err) {
      app.log.warn({ err, planId }, "Failed to dismiss the leave plan announcements");
    }
  }

  return result;
}
