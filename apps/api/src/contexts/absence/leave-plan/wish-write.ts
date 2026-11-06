/**
 * Issue #835 (D-835-06/08/24, D-04, D-06) — writing a wish of a leave plan: create, move/resize and
 * soft removal. ONE transaction per write; the wish is a plan entry, never a request, and nothing
 * here counts anywhere until the takeover turns it into one (D-01).
 *
 * Lock order (the same for every wish writer, never reorder): the Employee row first
 * (`lockEmployeeForLeavePricing`, so the overlap check serialises with request creation and with
 * the takeover's locked create transaction), then the plan row `FOR SHARE` (so a takeover flipping
 * the plan waits for in-flight wish writes and a closed plan is seen as closed), then — for a move
 * or removal — the wish row `FOR UPDATE`. The takeover takes employee -> wish and, for the flip,
 * the plan alone, so no cycle exists. A move between the takeover's per-wish read and its create is
 * caught by the takeover's link hook (it compares `startDate`/`endDate`/`halfDay`).
 *
 * Every refusal is returned as data; the route sends `body`. The actor is either the person
 * themself (`OWN`, subject to the deadline lock) or a holder of `leave-plan:manage` whose reach
 * covers the person (`MANAGER`, never locked); the route has decided that before the call.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import type { Prisma, LeavePlanWish } from "@clokr/db";
import { formatInTimeZone } from "date-fns-tz";
import { homeSalonsForDays, isAnonymizedEmployee, isEmployedInPeriod } from "../../platform";
import { dayRangeUtc, getTenantTimezone } from "../../working-time-account";
import { lockEmployeeForLeavePricing } from "../employee-leave-lock";
import { findBlockingLeaveOverlap, LEAVE_OVERLAP_ERROR } from "../leave-overlap";
import { isHomedInSalonOnAnyDay } from "../salon-leave-attribution";
import type { AuditRequestMeta } from "../leave-decision";
import {
  LEAVE_PLAN_CLOSED,
  LEAVE_PLAN_DEADLINE_PASSED,
  LEAVE_PLAN_MESSAGES,
  LEAVE_PLAN_WISH_HALF_DAY_RANGE,
  LEAVE_PLAN_WISH_NOT_EMPLOYED,
  LEAVE_PLAN_WISH_NOT_HOMED,
  LEAVE_PLAN_WISH_OUTSIDE_YEAR,
  LEAVE_PLAN_WISH_OVERLAP,
  LEAVE_PLAN_WISH_OVERLAP_WISH_MESSAGE,
  LEAVE_PLAN_WISH_RANGE,
  LEAVE_PLAN_WISH_TAKEN_OVER,
  PLAN_NOT_FOUND_ERROR,
  WISH_NOT_FOUND_ERROR,
} from "./constants";
import { isWishOverlapExclusion } from "./db-refusals";
import { dayOf, dayToDate, halfDayShapeValid, ownEditLocked, wishInsideYear } from "./wish-rules";

type Db = Prisma.TransactionClient;

export type WishWriteOutcome =
  | { ok: true; wish: LeavePlanWish }
  | { ok: false; statusCode: 400 | 404 | 409; body: { error: string; code?: string } };

/**
 * Who writes. `kind` says which path the route admitted (`OWN`: the person themself; `MANAGER`: a
 * holder of `leave-plan:manage` whose reach covers the person). `isManagerOfPerson` is the answer
 * "the caller's manage reach covers the person" — for an `OWN` write it decides the deadline
 * exemption (a manager editing their own wish is never locked).
 */
export type WishActor = {
  userId: string;
  kind: "OWN" | "MANAGER";
  isManagerOfPerson: boolean;
};

function refused(
  statusCode: 400 | 404 | 409,
  code: string,
  error: string = LEAVE_PLAN_MESSAGES[code] ?? code,
): WishWriteOutcome {
  return { ok: false, statusCode, body: { error, code } };
}

const PLAN_NOT_FOUND_OUTCOME: WishWriteOutcome = {
  ok: false,
  statusCode: 404,
  body: { error: PLAN_NOT_FOUND_ERROR },
};
const WISH_NOT_FOUND_OUTCOME: WishWriteOutcome = {
  ok: false,
  statusCode: 404,
  body: { error: WISH_NOT_FOUND_ERROR },
};

/** Plan columns the wish rules need, read under the plan row lock. */
type LockedPlan = {
  id: string;
  status: string;
  salonId: string;
  year: number;
  deadline: Date | null;
};

/** Wish columns read under the wish row lock. */
type LockedWish = {
  id: string;
  employeeId: string;
  startDate: Date;
  endDate: Date;
  halfDay: boolean;
  deletedAt: Date | null;
  leaveRequestId: string | null;
};

/**
 * True iff the wish lies completely inside the person's employment and the person is not
 * anonymised (D-835-24). Employment is one interval, so the first and the last wish day imply every
 * day between; each day is judged as the tenant-local day's instants (`Employee.hireDate`/`exitDate`
 * are `@db.Timestamptz`). Reused by the takeover before every create.
 */
export async function employedOnEveryWishDay(
  db: Db,
  tenantId: string,
  employeeId: string,
  startDay: string,
  endDay: string,
): Promise<boolean> {
  const employee = await db.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { hireDate: true, exitDate: true, firstName: true, lastName: true },
  });
  if (!employee || isAnonymizedEmployee(employee)) return false;
  const tz = await getTenantTimezone(db, tenantId);
  const first = dayRangeUtc(startDay, tz);
  const last = dayRangeUtc(endDay, tz);
  return (
    isEmployedInPeriod(employee, first.start, first.end) &&
    isEmployedInPeriod(employee, last.start, last.end)
  );
}

/** Locks the plan row `FOR SHARE` inside the transaction; `null` when it is not of the tenant. */
async function lockPlanShared(
  tx: Db,
  tenantId: string,
  planId: string,
): Promise<LockedPlan | null> {
  const locked = await tx.$queryRaw<
    LockedPlan[]
  >`SELECT "id", "status", "salonId", "year", "deadline" FROM "LeavePlan" WHERE "id" = ${planId} AND "tenantId" = ${tenantId} FOR SHARE`;
  return locked[0] ?? null;
}

/** Locks the wish row `FOR UPDATE` by `{ id, planId, tenantId }`; `null` when there is none. */
async function lockWish(
  tx: Db,
  tenantId: string,
  planId: string,
  wishId: string,
): Promise<LockedWish | null> {
  const locked = await tx.$queryRaw<
    LockedWish[]
  >`SELECT "id", "employeeId", "startDate", "endDate", "halfDay", "deletedAt", "leaveRequestId" FROM "LeavePlanWish" WHERE "id" = ${wishId} AND "planId" = ${planId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  return locked[0] ?? null;
}

/**
 * The deadline lock (D-06, D-835-07): refuses an `OWN` write after the deadline when the tenant
 * locks wishes. "Today" is the tenant-local day of `now`; the deadline day itself is still open.
 */
async function deadlineRefusal(
  tx: Db,
  input: { tenantId: string; plan: LockedPlan; actor: WishActor; now: Date },
): Promise<WishWriteOutcome | null> {
  if (input.actor.kind !== "OWN") return null;
  const config = await tx.tenantConfig.findUnique({
    where: { tenantId: input.tenantId },
    select: { leavePlanDeadlineLocksWishes: true },
  });
  const locksWishes = config?.leavePlanDeadlineLocksWishes ?? false;
  if (!locksWishes || input.plan.deadline === null) return null;
  const tz = await getTenantTimezone(tx, input.tenantId);
  const locked = ownEditLocked({
    locksWishes,
    deadlineDay: dayOf(input.plan.deadline),
    todayDay: formatInTimeZone(input.now, tz, "yyyy-MM-dd"),
    actorIsManager: input.actor.isManagerOfPerson,
  });
  return locked ? refused(409, LEAVE_PLAN_DEADLINE_PASSED) : null;
}

/**
 * Every validity rule of a wish that is about to exist with these dates, in the order of the
 * decision record: year -> range -> half-day shape -> homed on a wish day -> employed on every wish
 * day -> deadline lock -> blocking request overlap -> overlap with another active wish. `null` =
 * valid. `excludeWishId` keeps a wish that is being moved from colliding with itself.
 */
async function validateWishRules(
  tx: Db,
  input: {
    tenantId: string;
    plan: LockedPlan;
    employeeId: string;
    startDay: string;
    endDay: string;
    halfDay: boolean;
    actor: WishActor;
    now: Date;
    excludeWishId?: string;
  },
): Promise<WishWriteOutcome | null> {
  const { tenantId, plan, employeeId, startDay, endDay, halfDay } = input;

  if (!wishInsideYear(startDay, endDay, plan.year)) {
    return refused(400, LEAVE_PLAN_WISH_OUTSIDE_YEAR);
  }
  if (startDay > endDay) return refused(400, LEAVE_PLAN_WISH_RANGE);
  if (!halfDayShapeValid(startDay, endDay, halfDay)) {
    return refused(400, LEAVE_PLAN_WISH_HALF_DAY_RANGE);
  }

  // D-05: the person must be homed in the plan's salon on at least one day of the wish — the
  // same per-day Stammsalon attribution as the leave filters (`filterLeaveRowsToHomeSalon`).
  const homes = await homeSalonsForDays(tx, tenantId, [employeeId], startDay, endDay);
  if (!isHomedInSalonOnAnyDay(homes.get(employeeId), plan.salonId, startDay, endDay)) {
    return refused(400, LEAVE_PLAN_WISH_NOT_HOMED);
  }

  if (!(await employedOnEveryWishDay(tx, tenantId, employeeId, startDay, endDay))) {
    return refused(400, LEAVE_PLAN_WISH_NOT_EMPLOYED);
  }

  const locked = await deadlineRefusal(tx, { tenantId, plan, actor: input.actor, now: input.now });
  if (locked) return locked;

  // Parity with the request a wish becomes: the SAME blocking set as `POST /leave/requests`.
  // A Berufsschule Absence, a Betriebsurlaub and a holiday are deliberately NOT part of it.
  const overlap = await findBlockingLeaveOverlap(tx, {
    employeeId,
    start: dayToDate(startDay),
    end: dayToDate(endDay),
    isSickRequest: false,
  });
  if (overlap) return refused(409, LEAVE_PLAN_WISH_OVERLAP, LEAVE_OVERLAP_ERROR);

  // Another active, not-taken-over wish of the person in ANY open plan (D-835-06). A wish that was
  // taken over is a request now and is covered by the check above.
  const otherWish = await tx.leavePlanWish.findFirst({
    where: {
      tenantId,
      employeeId,
      deletedAt: null,
      leaveRequestId: null,
      startDate: { lte: dayToDate(endDay) },
      endDate: { gte: dayToDate(startDay) },
      plan: { status: "OPEN" },
      ...(input.excludeWishId !== undefined ? { id: { not: input.excludeWishId } } : {}),
    },
    select: { id: true },
  });
  if (otherWish) return refused(409, LEAVE_PLAN_WISH_OVERLAP, LEAVE_PLAN_WISH_OVERLAP_WISH_MESSAGE);

  return null;
}

/** A racing writer that slipped past the application check meets the exclusion constraint: same answer. */
function mapOverlapExclusion(write: Promise<WishWriteOutcome>): Promise<WishWriteOutcome> {
  return write.catch((err: unknown): WishWriteOutcome => {
    if (isWishOverlapExclusion(err)) {
      return refused(409, LEAVE_PLAN_WISH_OVERLAP, LEAVE_PLAN_WISH_OVERLAP_WISH_MESSAGE);
    }
    throw err;
  });
}

/** The audit values of a wish: ids and calendar days only (no free text exists on a wish). */
function wishValues(wish: {
  planId: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
}) {
  return {
    planId: wish.planId,
    employeeId: wish.employeeId,
    startDate: wish.startDate,
    endDate: wish.endDate,
    halfDay: wish.halfDay,
  };
}

/** Adds a wish to a plan for `employeeId`; the caller has authorised the actor for that person. */
export async function createWish(
  app: FastifyInstance,
  input: {
    tenantId: string;
    planId: string;
    employeeId: string;
    actor: WishActor;
    now: Date;
    startDay: string;
    endDay: string;
    halfDay: boolean;
    request: AuditRequestMeta;
  },
): Promise<WishWriteOutcome> {
  const { tenantId, planId, employeeId, startDay, endDay, halfDay, actor } = input;

  const write = app.prisma.$transaction(async (tx): Promise<WishWriteOutcome> => {
    await lockEmployeeForLeavePricing(tx, tenantId, employeeId);
    const plan = await lockPlanShared(tx, tenantId, planId);
    if (!plan) return PLAN_NOT_FOUND_OUTCOME;
    if (plan.status !== "OPEN") return refused(409, LEAVE_PLAN_CLOSED);

    const invalid = await validateWishRules(tx, {
      tenantId,
      plan,
      employeeId,
      startDay,
      endDay,
      halfDay,
      actor,
      now: input.now,
    });
    if (invalid) return invalid;

    const wish = await tx.leavePlanWish.create({
      data: {
        tenantId,
        planId,
        employeeId,
        startDate: dayToDate(startDay),
        endDate: dayToDate(endDay),
        halfDay,
        createdByUserId: actor.userId,
      },
    });
    await app.audit({
      userId: actor.userId,
      action: "CREATE",
      entity: "LeavePlanWish",
      entityId: wish.id,
      newValue: wishValues({ planId, employeeId, startDate: startDay, endDate: endDay, halfDay }),
      request: input.request,
      tx,
    });
    return { ok: true, wish };
  });
  return mapOverlapExclusion(write);
}

/**
 * Moves and/or resizes a wish (any of `startDay`, `endDay`, `halfDay`; the others keep their stored
 * value) and re-runs every rule for the new dates. A taken-over wish is a request now: 409.
 */
export async function updateWish(
  app: FastifyInstance,
  input: {
    tenantId: string;
    planId: string;
    wishId: string;
    actor: WishActor;
    now: Date;
    startDay?: string;
    endDay?: string;
    halfDay?: boolean;
    request: AuditRequestMeta;
  },
): Promise<WishWriteOutcome> {
  const { tenantId, planId, wishId, actor } = input;

  const write = app.prisma.$transaction(async (tx): Promise<WishWriteOutcome> => {
    // The person is needed for the employee lock, which must come first: read it unlocked, then
    // re-read the wish under its lock and require the same person.
    const preread = await tx.leavePlanWish.findFirst({
      where: { id: wishId, planId, tenantId, deletedAt: null },
      select: { employeeId: true },
    });
    if (!preread) return WISH_NOT_FOUND_OUTCOME;

    await lockEmployeeForLeavePricing(tx, tenantId, preread.employeeId);
    const plan = await lockPlanShared(tx, tenantId, planId);
    if (!plan) return PLAN_NOT_FOUND_OUTCOME;
    const wish = await lockWish(tx, tenantId, planId, wishId);
    if (!wish || wish.deletedAt !== null || wish.employeeId !== preread.employeeId) {
      return WISH_NOT_FOUND_OUTCOME;
    }
    if (plan.status !== "OPEN") return refused(409, LEAVE_PLAN_CLOSED);
    if (wish.leaveRequestId !== null) return refused(409, LEAVE_PLAN_WISH_TAKEN_OVER);

    const oldStart = dayOf(wish.startDate);
    const oldEnd = dayOf(wish.endDate);
    const startDay = input.startDay ?? oldStart;
    const endDay = input.endDay ?? oldEnd;
    const halfDay = input.halfDay ?? wish.halfDay;
    // Nothing changes: write and audit nothing (precedent: an unchanged deadline).
    if (startDay === oldStart && endDay === oldEnd && halfDay === wish.halfDay) {
      const current = await tx.leavePlanWish.findFirst({ where: { id: wishId, tenantId } });
      return current ? { ok: true, wish: current } : WISH_NOT_FOUND_OUTCOME;
    }

    const invalid = await validateWishRules(tx, {
      tenantId,
      plan,
      employeeId: wish.employeeId,
      startDay,
      endDay,
      halfDay,
      actor,
      now: input.now,
      excludeWishId: wishId,
    });
    if (invalid) return invalid;

    const updated = await tx.leavePlanWish.update({
      where: { id: wishId, tenantId },
      data: { startDate: dayToDate(startDay), endDate: dayToDate(endDay), halfDay },
    });
    await app.audit({
      userId: actor.userId,
      action: "UPDATE",
      entity: "LeavePlanWish",
      entityId: wishId,
      oldValue: wishValues({
        planId,
        employeeId: wish.employeeId,
        startDate: oldStart,
        endDate: oldEnd,
        halfDay: wish.halfDay,
      }),
      newValue: wishValues({
        planId,
        employeeId: wish.employeeId,
        startDate: startDay,
        endDate: endDay,
        halfDay,
      }),
      request: input.request,
      tx,
    });
    return { ok: true, wish: updated };
  });
  return mapOverlapExclusion(write);
}

/**
 * Removes a wish softly (`deletedAt`, `deletedByUserId`; the row stays, § 147 AO). A wish that was
 * already linked to a request may be removed — its request is untouched. The deadline lock applies
 * to an `OWN` removal exactly as to a create or a move.
 */
export async function removeWish(
  app: FastifyInstance,
  input: {
    tenantId: string;
    planId: string;
    wishId: string;
    actor: WishActor;
    now: Date;
    request: AuditRequestMeta;
  },
): Promise<WishWriteOutcome> {
  const { tenantId, planId, wishId, actor } = input;

  return app.prisma.$transaction(async (tx): Promise<WishWriteOutcome> => {
    const preread = await tx.leavePlanWish.findFirst({
      where: { id: wishId, planId, tenantId, deletedAt: null },
      select: { employeeId: true },
    });
    if (!preread) return WISH_NOT_FOUND_OUTCOME;

    await lockEmployeeForLeavePricing(tx, tenantId, preread.employeeId);
    const plan = await lockPlanShared(tx, tenantId, planId);
    if (!plan) return PLAN_NOT_FOUND_OUTCOME;
    const wish = await lockWish(tx, tenantId, planId, wishId);
    if (!wish || wish.deletedAt !== null || wish.employeeId !== preread.employeeId) {
      return WISH_NOT_FOUND_OUTCOME;
    }
    if (plan.status !== "OPEN") return refused(409, LEAVE_PLAN_CLOSED);

    const locked = await deadlineRefusal(tx, { tenantId, plan, actor, now: input.now });
    if (locked) return locked;

    const removed = await tx.leavePlanWish.update({
      where: { id: wishId, tenantId },
      data: { deletedAt: input.now, deletedByUserId: actor.userId },
    });
    await app.audit({
      userId: actor.userId,
      action: "DELETE",
      entity: "LeavePlanWish",
      entityId: wishId,
      oldValue: wishValues({
        planId,
        employeeId: wish.employeeId,
        startDate: dayOf(wish.startDate),
        endDate: dayOf(wish.endDate),
        halfDay: wish.halfDay,
      }),
      request: input.request,
      tx,
    });
    return { ok: true, wish: removed };
  });
}
