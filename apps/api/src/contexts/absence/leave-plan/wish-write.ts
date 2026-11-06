/**
 * Issue #835 (D-835-06/08) — writing a wish of a leave plan. ONE transaction per write; the wish
 * is a plan entry, never a request, and nothing here counts anywhere until the takeover turns it
 * into one (D-01).
 *
 * Lock order (the same for every wish writer): the Employee row first
 * (`lockEmployeeForLeavePricing`, so the overlap check serialises with request creation), then the
 * plan row `FOR SHARE` (so a takeover flipping the plan waits for in-flight wish writes and a
 * closed plan is seen as closed). Every refusal is returned as data; the route sends `body`.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import type { LeavePlanWish } from "@clokr/db";
import { homeSalonsForDays } from "../../platform";
import { lockEmployeeForLeavePricing } from "../employee-leave-lock";
import { findBlockingLeaveOverlap, LEAVE_OVERLAP_ERROR } from "../leave-overlap";
import { isHomedInSalonOnAnyDay } from "../salon-leave-attribution";
import type { AuditRequestMeta } from "../leave-decision";
import {
  LEAVE_PLAN_CLOSED,
  LEAVE_PLAN_MESSAGES,
  LEAVE_PLAN_WISH_HALF_DAY_RANGE,
  LEAVE_PLAN_WISH_NOT_HOMED,
  LEAVE_PLAN_WISH_OUTSIDE_YEAR,
  LEAVE_PLAN_WISH_OVERLAP,
  LEAVE_PLAN_WISH_OVERLAP_WISH_MESSAGE,
  PLAN_NOT_FOUND_ERROR,
} from "./constants";
import { isWishOverlapExclusion } from "./db-refusals";
import { dayToDate, halfDayShapeValid, wishInsideYear } from "./wish-rules";

export type WishWriteOutcome =
  | { ok: true; wish: LeavePlanWish }
  | { ok: false; statusCode: 400 | 404 | 409; body: { error: string; code?: string } };

function refused(
  statusCode: 400 | 404 | 409,
  code: string,
  error: string = LEAVE_PLAN_MESSAGES[code] ?? code,
): WishWriteOutcome {
  return { ok: false, statusCode, body: { error, code } };
}

/** Plan columns the wish rules need, read under the plan row lock. */
type LockedPlan = { id: string; status: string; salonId: string; year: number };

/** Adds a wish to a plan for `employeeId`; the caller has authorised the actor for that person. */
export async function createWish(
  app: FastifyInstance,
  input: {
    tenantId: string;
    planId: string;
    employeeId: string;
    actorUserId: string;
    startDay: string;
    endDay: string;
    halfDay: boolean;
    request: AuditRequestMeta;
  },
): Promise<WishWriteOutcome> {
  const { tenantId, planId, employeeId, startDay, endDay, halfDay } = input;

  const write = app.prisma.$transaction(async (tx): Promise<WishWriteOutcome> => {
    await lockEmployeeForLeavePricing(tx, tenantId, employeeId);

    const locked = await tx.$queryRaw<
      LockedPlan[]
    >`SELECT "id", "status", "salonId", "year" FROM "LeavePlan" WHERE "id" = ${planId} AND "tenantId" = ${tenantId} FOR SHARE`;
    const plan = locked[0];
    if (!plan) {
      return { ok: false, statusCode: 404, body: { error: PLAN_NOT_FOUND_ERROR } };
    }
    if (plan.status !== "OPEN") return refused(409, LEAVE_PLAN_CLOSED);

    if (!wishInsideYear(startDay, endDay, plan.year)) {
      return refused(400, LEAVE_PLAN_WISH_OUTSIDE_YEAR);
    }
    if (!halfDayShapeValid(startDay, endDay, halfDay)) {
      return refused(400, LEAVE_PLAN_WISH_HALF_DAY_RANGE);
    }

    // D-05: the person must be homed in the plan's salon on at least one day of the wish — the
    // same per-day Stammsalon attribution as the leave filters (`filterLeaveRowsToHomeSalon`).
    const homes = await homeSalonsForDays(tx, tenantId, [employeeId], startDay, endDay);
    if (!isHomedInSalonOnAnyDay(homes.get(employeeId), plan.salonId, startDay, endDay)) {
      return refused(400, LEAVE_PLAN_WISH_NOT_HOMED);
    }

    // Parity with the request a wish becomes: the SAME blocking set as `POST /leave/requests`.
    const overlap = await findBlockingLeaveOverlap(tx, {
      employeeId,
      start: dayToDate(startDay),
      end: dayToDate(endDay),
      isSickRequest: false,
    });
    if (overlap) return refused(409, LEAVE_PLAN_WISH_OVERLAP, LEAVE_OVERLAP_ERROR);

    const wish = await tx.leavePlanWish.create({
      data: {
        tenantId,
        planId,
        employeeId,
        startDate: dayToDate(startDay),
        endDate: dayToDate(endDay),
        halfDay,
        createdByUserId: input.actorUserId,
      },
    });
    await app.audit({
      userId: input.actorUserId,
      action: "CREATE",
      entity: "LeavePlanWish",
      entityId: wish.id,
      newValue: { planId, employeeId, startDate: startDay, endDate: endDay, halfDay },
      request: input.request,
      tx,
    });
    return { ok: true, wish };
  });
  // A racing writer that slipped past the application check meets the exclusion constraint
  // `LeavePlanWish_no_overlap_active`: same answer as the check. Anything else rethrows.
  return write.catch((err: unknown): WishWriteOutcome => {
    if (isWishOverlapExclusion(err)) {
      return refused(409, LEAVE_PLAN_WISH_OVERLAP, LEAVE_PLAN_WISH_OVERLAP_WISH_MESSAGE);
    }
    throw err;
  });
}
