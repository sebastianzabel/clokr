/**
 * Issue #835 (D-835-09/22) — the live read of a leave plan (the planner).
 *
 * Tracer scope (835-03): the final DTO shape with `persons` built from the owners of the plan's
 * active wishes, each with its wishes, and empty `rows`, `dayLoad`, `holidays` and `forecast:
 * null`. The rows (gesetzt / beantragt / Absence / Betriebsurlaub), the population, the conflict
 * flag, the day load and the forecast arrive in 835-06 WITHOUT a change of this shape.
 *
 * Everything is read live and nothing is copied: a wish never counts anywhere until it is a
 * request (D-01).
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import type { LeavePlan, LeavePlanWish } from "@clokr/db";
import { formatInTimeZone } from "date-fns-tz";
import type { AccessReach } from "../../platform";
import { getTenantTimezone } from "../../working-time-account";
import { dayOf } from "./wish-rules";

export type PlannerRow = {
  kind: "LEAVE" | "ABSENCE" | "COMPANY_SHUTDOWN";
  state: "GESETZT" | "BEANTRAGT";
  startDate: string;
  endDate: string;
  halfDay: boolean;
  typeCode: string | null;
};

export type PlannerWish = {
  id: string;
  planId: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  foreignPlan: boolean;
  conflict: boolean;
  leaveRequestId: string | null;
  leaveRequestStatus: string | null;
  refusalCode: string | null;
  refusalMessage: string | null;
  editable: boolean;
  createdAt: string;
};

export type PlannerForecast = {
  entitlementBasis: "STORED" | "COMPUTED";
  remainingDays: number;
  pendingDays: number;
  wishDays: number;
  forecastDays: number;
  forecastNegative: boolean;
};

export type PlannerPerson = {
  employeeId: string;
  firstName: string;
  lastName: string;
  homeRanges: Array<{ from: string; to: string }>;
  rows: PlannerRow[];
  wishes: PlannerWish[];
  forecast: PlannerForecast | null;
};

export type PlannerDay = {
  day: string;
  count: number;
  limits: Array<{
    ruleId: string;
    ruleName: string | null;
    groupKey: string;
    max: number;
    count: number;
    exceeded: boolean;
  }> | null;
};

export type PlannerReadDto = {
  plan: {
    id: string;
    salonId: string;
    year: number;
    deadline: string | null;
    status: "OPEN" | "TAKEN_OVER";
    openedAt: string;
    takenOverAt: string | null;
    deadlinePassed: boolean;
    deadlineLocksWishes: boolean;
    partiallyTakenOver: boolean;
  };
  viewer: {
    employeeId: string | null;
    canManage: boolean;
    canWishOwn: boolean;
    ownEditLocked: boolean;
  };
  persons: PlannerPerson[];
  holidays: Array<{ date: string; name: string }>;
  dayLoad: PlannerDay[];
};

/** The stored plan as the open route answers it. */
export type PlanDto = {
  id: string;
  salonId: string;
  year: number;
  deadline: string | null;
  status: "OPEN" | "TAKEN_OVER";
  openedAt: string;
  takenOverAt: string | null;
};

export function toPlanDto(plan: LeavePlan): PlanDto {
  return {
    id: plan.id,
    salonId: plan.salonId,
    year: plan.year,
    deadline: plan.deadline ? dayOf(plan.deadline) : null,
    status: plan.status,
    openedAt: plan.openedAt.toISOString(),
    takenOverAt: plan.takenOverAt ? plan.takenOverAt.toISOString() : null,
  };
}

/** A wish as the planner shows it; `leaveRequestStatus` is the status of the linked request, if any. */
export function toPlannerWish(
  wish: LeavePlanWish,
  context: { planStatus: "OPEN" | "TAKEN_OVER"; leaveRequestStatus?: string | null },
): PlannerWish {
  return {
    id: wish.id,
    planId: wish.planId,
    startDate: dayOf(wish.startDate),
    endDate: dayOf(wish.endDate),
    halfDay: wish.halfDay,
    foreignPlan: false,
    conflict: false,
    leaveRequestId: wish.leaveRequestId,
    leaveRequestStatus: context.leaveRequestStatus ?? null,
    refusalCode: wish.refusalCode,
    refusalMessage: wish.refusalMessage,
    editable: context.planStatus === "OPEN" && wish.leaveRequestId === null,
    createdAt: wish.createdAt.toISOString(),
  };
}

export async function readPlanner(
  app: FastifyInstance,
  input: {
    tenantId: string;
    plan: LeavePlan;
    viewer: {
      userId: string;
      employeeId: string | null;
      canManage: boolean;
      canSeeAllTypes: boolean;
      /** Whether the caller may file requests of their own (`leave-request:create:EIGENE`). */
      canCreateOwn?: boolean;
      entitlementReach: AccessReach;
      manageReach: AccessReach;
      approveReach: AccessReach;
    };
    now: Date;
  },
): Promise<PlannerReadDto> {
  const { tenantId, plan, viewer, now } = input;

  const wishes = await app.prisma.leavePlanWish.findMany({
    where: { planId: plan.id, tenantId, deletedAt: null },
    orderBy: [{ employeeId: "asc" }, { startDate: "asc" }, { id: "asc" }],
  });

  const employeeIds = [...new Set(wishes.map((w) => w.employeeId))];
  const employees = employeeIds.length
    ? await app.prisma.employee.findMany({
        where: { id: { in: employeeIds }, tenantId },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const requestIds = wishes.flatMap((w) => (w.leaveRequestId ? [w.leaveRequestId] : []));
  const requests = requestIds.length
    ? await app.prisma.leaveRequest.findMany({
        where: { id: { in: requestIds }, employee: { tenantId } },
        select: { id: true, status: true },
      })
    : [];
  const statusOf = new Map(requests.map((r) => [r.id, r.status]));

  const planStatus = plan.status;
  const persons: PlannerPerson[] = employees
    .map((employee) => ({
      employeeId: employee.id,
      firstName: employee.firstName,
      lastName: employee.lastName,
      homeRanges: [],
      rows: [],
      wishes: wishes
        .filter((w) => w.employeeId === employee.id)
        .map((w) =>
          toPlannerWish(w, {
            planStatus,
            leaveRequestStatus: w.leaveRequestId ? (statusOf.get(w.leaveRequestId) ?? null) : null,
          }),
        ),
      forecast: null,
    }))
    .sort(
      (a, b) =>
        a.lastName.localeCompare(b.lastName) ||
        a.firstName.localeCompare(b.firstName) ||
        a.employeeId.localeCompare(b.employeeId),
    );

  const config = await app.prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { leavePlanDeadlineLocksWishes: true },
  });
  const deadlineLocksWishes = config?.leavePlanDeadlineLocksWishes ?? false;
  const timezone = await getTenantTimezone(app.prisma, tenantId);
  const todayLocal = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const deadlineDay = plan.deadline ? dayOf(plan.deadline) : null;
  const deadlinePassed = deadlineDay !== null && todayLocal > deadlineDay;

  return {
    plan: {
      id: plan.id,
      salonId: plan.salonId,
      year: plan.year,
      deadline: deadlineDay,
      status: planStatus,
      openedAt: plan.openedAt.toISOString(),
      takenOverAt: plan.takenOverAt ? plan.takenOverAt.toISOString() : null,
      deadlinePassed,
      deadlineLocksWishes,
      partiallyTakenOver: planStatus === "OPEN" && wishes.some((w) => w.leaveRequestId !== null),
    },
    viewer: {
      employeeId: viewer.employeeId,
      canManage: viewer.canManage,
      canWishOwn:
        planStatus === "OPEN" && viewer.employeeId !== null && viewer.canCreateOwn !== false,
      ownEditLocked: deadlineLocksWishes && deadlinePassed && !viewer.canManage,
    },
    persons,
    holidays: [],
    dayLoad: [],
  };
}
