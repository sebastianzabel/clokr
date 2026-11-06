/**
 * Issue #835 (D-835-13/14/15/17, D-835-35) — the takeover of a leave plan: every active wish
 * becomes a real leave request through the SAME create core as `POST /leave/requests`, and the
 * wishes the taker may approve are approved through the SAME decision core as the review route.
 * Nothing here validates a request itself (D-835-12): a refusal of a core is stored on the wish and
 * listed in the result, the wish stays.
 *
 * Per wish, in deterministic order (person id, start date, wish id), each in its own short
 * transactions — a partial run keeps what succeeded and a re-run never duplicates:
 *   1. the wish is RE-READ at the start of its iteration (gone, removed or linked → skipped);
 *   2. `createLeaveRequestCore` creates the request on behalf of the person (actor = the taker,
 *      CREATE audit with `trigger`, `leavePlanId`, `leavePlanWishId`); its `inTransaction` hook
 *      locks the wish row `FOR UPDATE` and links it, so a request is only ever linked to a wish
 *      whose stored dates it equals (a wish moved or removed meanwhile rolls the create back);
 *   3. only a wish the taker may approve (not the taker's own, inside the approve reach) is
 *      approved; any other stays PENDING for a second approver (four-eyes).
 * A last short transaction locks the plan row `FOR UPDATE`, closes the plan when no wish is left
 * open and writes ONE summary audit row with ids and counts only.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { isStammsalonScopeMatch, type AccessReach } from "../../platform";
import { createLeaveRequestCore } from "../leave-request-create";
import {
  approveLeaveRequestCore,
  leaveDecisionGuard,
  loadLeaveRequestForReview,
  type AuditRequestMeta,
} from "../leave-decision";
import { APPROVAL_REFUSAL_PREFIX, LEAVE_PLAN_TRIGGER } from "./constants";
import { dayOf } from "./wish-rules";

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
};

export async function takeOverLeavePlan(
  app: FastifyInstance,
  input: {
    tenantId: string;
    planId: string;
    taker: { userId: string; employeeId: string | null; approveReach: AccessReach };
    /** wishId → reason of the limit exception the taker grants for that wish (used from 835-07). */
    limitExceptions: ReadonlyMap<string, string>;
    request: AuditRequestMeta;
  },
): Promise<TakeoverResult> {
  const { tenantId, planId, taker } = input;
  const result: TakeoverResult = { created: [], pending: [], refused: [], planStatus: "OPEN" };
  let skippedCount = 0;

  const wishIds = await app.prisma.leavePlanWish.findMany({
    where: { planId, tenantId, deletedAt: null },
    orderBy: [{ employeeId: "asc" }, { startDate: "asc" }, { id: "asc" }],
    select: { id: true },
  });

  /** Reads the wish as stored NOW; `null` when it is gone, removed or already linked. */
  async function readOpenWish(id: string): Promise<StoredWish | null> {
    const wish = await app.prisma.leavePlanWish.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true,
        employeeId: true,
        startDate: true,
        endDate: true,
        halfDay: true,
        leaveRequestId: true,
      },
    });
    return wish && wish.leaveRequestId === null ? wish : null;
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
        await storeRefusal(wish.id, created.reason, created.body.error);
        result.refused.push({
          wishId: wish.id,
          employeeId: wish.employeeId,
          code: created.reason,
          error: created.body.error,
        });
        return { kind: "refused" };
      }
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
      request: input.request,
    });
    return decided.ok ? null : { reason: decided.reason, error: decided.body.error };
  }

  for (const { id } of wishIds) {
    // The wish is re-read at the start of its iteration: the values used below are the values as
    // stored now, and the link hook proves they are still the stored ones when the request exists.
    let wish = await readOpenWish(id);
    if (!wish) continue;

    const willApprove =
      taker.employeeId !== wish.employeeId &&
      (await isStammsalonScopeMatch(
        app.prisma,
        tenantId,
        taker.approveReach,
        wish.employeeId,
        wish.startDate,
      ));

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

    // Approval through the review route's own guard and core, with the taker as reviewer.
    const refusal = await approveFor(leaveRequestId, input.limitExceptions.get(wish.id));
    if (refusal) {
      await storeRefusal(wish.id, `${APPROVAL_REFUSAL_PREFIX}${refusal.reason}`, refusal.error);
      result.pending.push({
        wishId: wish.id,
        employeeId: wish.employeeId,
        leaveRequestId,
        reason: "APPROVAL_REFUSED",
      });
      continue;
    }
    result.created.push({ wishId: wish.id, employeeId: wish.employeeId, leaveRequestId });
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
      planStatus = closed.count > 0 ? "TAKEN_OVER" : "OPEN";
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
