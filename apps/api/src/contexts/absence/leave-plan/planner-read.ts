/**
 * Issue #835 (D-835-09/22) — the live read of a leave plan (the planner).
 *
 * The persons are the plan population (`planPopulation`: Stammsalon in the year, employed in the
 * year, never anonymised), each with the `homeRanges` of the days homed in the plan's salon, the
 * rows read live from the Abwesenheiten facades (GESETZT = effective leave, Absence rows and
 * Betriebsurlaub minus the person's exceptions; BEANTRAGT = PENDING leave), the person's wishes of
 * this plan plus read-only wishes of OTHER open plans that touch the person's days in this salon,
 * and the salon's holidays. The conflict flag marks an unlinked wish over a leave row of the same
 * person. Types are masked with the calendar's rule (`canSeeLeaveType`) and a sick type is shown
 * only on the reader's own rows (Art. 9 DSGVO); no note, attest, § 9 or document field is ever
 * read into the planner.
 *
 * Everything is read live and nothing is copied: a wish never counts anywhere until it is a
 * request (D-01), and approving a request moves it from beantragt to gesetzt in the next read
 * without any write here.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import type { LeavePlan, LeavePlanWish } from "@clokr/db";
import { formatInTimeZone } from "date-fns-tz";
import { holidaysForSalon, resolveSalonInReach, type AccessReach } from "../../platform";
import { getTenantTimezone } from "../../working-time-account";
import { getAbsencesOverlapping } from "../facade/absences";
import { getCalendarLeaveOverlapping } from "../facade/leave-requests";
import { canSeeLeaveType } from "../leave-calendar-visibility";
import { eachDay } from "../leave-limits/counted-days";
import { isPersonVisibleOn, readerVisibilityFrom } from "../leave-limits/redact";
import { isSickLeaveTypeCode } from "../leave-type";
import { manageCoversFromHomeDays } from "./admission";
import { plannerDayLoad, type PlannerDay } from "./day-load";
import { plannerForecast, type PlannerForecast } from "./forecast";

export type { PlannerDay, PlannerForecast };
import { planPopulation } from "./population";
import { dayOf, dayToDate, deadlinePassed, ownEditLocked, rangesOverlap } from "./wish-rules";

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

export type PlannerPerson = {
  employeeId: string;
  firstName: string;
  lastName: string;
  homeRanges: Array<{ from: string; to: string }>;
  rows: PlannerRow[];
  wishes: PlannerWish[];
  forecast: PlannerForecast | null;
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

/** Contiguous day ranges of the year on which the person's Stammsalon is `salonId`. */
function homeRangesIn(
  homeByDay: ReadonlyMap<string, string | null> | undefined,
  salonId: string,
  days: readonly string[],
): Array<{ from: string; to: string }> {
  const ranges: Array<{ from: string; to: string }> = [];
  let open: { from: string; to: string } | null = null;
  for (const day of days) {
    if ((homeByDay?.get(day) ?? null) === salonId) {
      if (open) open.to = day;
      else {
        open = { from: day, to: day };
        ranges.push(open);
      }
    } else {
      open = null;
    }
  }
  return ranges;
}

/**
 * The type code a reader may see on a row of `ownerEmployeeId`: the reader's own rows always; a
 * sick code never on a colleague's row (stricter than the calendar, D-835-22); every other code by
 * the calendar rule `canSeeLeaveType` (`leave-request:read:ZUGEWIESEN` computed once per request).
 */
function maskedTypeCode(
  code: string | null,
  isOwn: boolean,
  canSeeAllTypes: boolean,
): string | null {
  if (code === null) return null;
  if (isOwn) return code;
  if (isSickLeaveTypeCode(code as Parameters<typeof isSickLeaveTypeCode>[0])) return null;
  return canSeeLeaveType(isOwn, canSeeAllTypes) ? code : null;
}

type StoredPlanWish = LeavePlanWish;

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
  const db = app.prisma;
  const firstDay = `${plan.year}-01-01`;
  const lastDay = `${plan.year}-12-31`;
  const yearDays = eachDay(firstDay, lastDay);

  // ── Population and the plan's own wishes ───────────────────────────────────────────────────
  const population = await planPopulation(db, tenantId, plan.salonId, plan.year);
  const personIds = population.persons.map((p) => p.id);
  const personIdSet = new Set(personIds);

  const ownWishes = await db.leavePlanWish.findMany({
    where: { planId: plan.id, tenantId, deletedAt: null },
    orderBy: [{ employeeId: "asc" }, { startDate: "asc" }, { id: "asc" }],
  });

  // Wishes of the population in OTHER open plans of the year that touch a day homed in this salon
  // (read-only here, `foreignPlan`). An already linked wish is a request row, not a wish.
  const otherWishes: StoredPlanWish[] =
    personIds.length === 0
      ? []
      : await db.leavePlanWish.findMany({
          where: {
            tenantId,
            planId: { not: plan.id },
            deletedAt: null,
            leaveRequestId: null,
            employeeId: { in: personIds },
            plan: { tenantId, year: plan.year, status: "OPEN" },
          },
          orderBy: [{ employeeId: "asc" }, { startDate: "asc" }, { id: "asc" }],
        });
  const touchesSalon = (wish: StoredPlanWish): boolean => {
    const home = population.homeByPerson.get(wish.employeeId);
    if (!home) return false;
    const from = dayOf(wish.startDate);
    const to = dayOf(wish.endDate);
    for (const [day, salonId] of home) {
      if (day >= from && day <= to && salonId === plan.salonId) return true;
    }
    return false;
  };
  const shownOwnWishes = ownWishes.filter((w) => personIdSet.has(w.employeeId));
  const shownForeignWishes = otherWishes.filter(touchesSalon);

  const requestIds = shownOwnWishes.flatMap((w) => (w.leaveRequestId ? [w.leaveRequestId] : []));
  // A soft-deleted linked request is no request any more: its status is not shown (WR-09).
  const requests = requestIds.length
    ? await db.leaveRequest.findMany({
        where: { id: { in: requestIds }, deletedAt: null, employee: { tenantId } },
        select: { id: true, status: true },
      })
    : [];
  const statusOf = new Map(requests.map((r) => [r.id, r.status]));

  // ── Live rows (D-835-09): effective leave and Absence rows are GESETZT, PENDING is BEANTRAGT,
  // the Betriebsurlaub is GESETZT for everybody except the persons named as its exceptions. ──────
  const yearStart = dayToDate(firstDay);
  const yearEnd = dayToDate(lastDay);
  const scope = { kind: "employees" as const, employeeIds: personIds, tenantId };
  const [leaveRows, absenceRows, shutdowns, holidays] =
    personIds.length === 0
      ? [[], [], [], await holidaysForSalon(db, tenantId, plan.salonId, firstDay, lastDay)]
      : await Promise.all([
          getCalendarLeaveOverlapping(db, scope, yearStart, yearEnd),
          getAbsencesOverlapping(db, scope, yearStart, yearEnd),
          db.companyShutdown.findMany({
            where: { tenantId, startDate: { lte: yearEnd }, endDate: { gte: yearStart } },
            select: {
              startDate: true,
              endDate: true,
              exceptions: { select: { employeeId: true } },
            },
          }),
          holidaysForSalon(db, tenantId, plan.salonId, firstDay, lastDay),
        ]);

  const rowsByPerson = new Map<string, PlannerRow[]>();
  const leaveRangesByPerson = new Map<string, Array<{ from: string; to: string }>>();
  const pushRow = (employeeId: string, row: PlannerRow) => {
    const list = rowsByPerson.get(employeeId);
    if (list) list.push(row);
    else rowsByPerson.set(employeeId, [row]);
  };
  for (const r of leaveRows) {
    const isOwn = viewer.employeeId !== null && r.employeeId === viewer.employeeId;
    const startDate = dayOf(r.startDate);
    const endDate = dayOf(r.endDate);
    pushRow(r.employeeId, {
      kind: "LEAVE",
      state: r.status === "PENDING" ? "BEANTRAGT" : "GESETZT",
      startDate,
      endDate,
      halfDay: r.halfDay,
      typeCode: maskedTypeCode(r.leaveType.code, isOwn, viewer.canSeeAllTypes),
    });
    const list = leaveRangesByPerson.get(r.employeeId);
    const range = { from: startDate, to: endDate };
    if (list) list.push(range);
    else leaveRangesByPerson.set(r.employeeId, [range]);
  }
  for (const a of absenceRows) {
    const isOwn = viewer.employeeId !== null && a.employeeId === viewer.employeeId;
    pushRow(a.employeeId, {
      kind: "ABSENCE",
      state: "GESETZT",
      startDate: dayOf(a.startDate),
      endDate: dayOf(a.endDate),
      halfDay: a.halfDay,
      typeCode: maskedTypeCode(a.type, isOwn, viewer.canSeeAllTypes),
    });
  }
  for (const shutdown of shutdowns) {
    const excepted = new Set(shutdown.exceptions.map((e) => e.employeeId));
    for (const id of personIds) {
      if (excepted.has(id)) continue;
      pushRow(id, {
        kind: "COMPANY_SHUTDOWN",
        state: "GESETZT",
        startDate: dayOf(shutdown.startDate),
        endDate: dayOf(shutdown.endDate),
        halfDay: false,
        typeCode: null,
      });
    }
  }

  // ── Viewer, deadline ───────────────────────────────────────────────────────────────────────
  const config = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { leavePlanDeadlineLocksWishes: true },
  });
  const deadlineLocksWishes = config?.leavePlanDeadlineLocksWishes ?? false;
  const timezone = await getTenantTimezone(db, tenantId);
  const todayLocal = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const deadlineDay = plan.deadline ? dayOf(plan.deadline) : null;
  const passed = deadlinePassed(deadlineDay, todayLocal);
  const planStatus = plan.status;

  // ── Wishes as the reader sees them ─────────────────────────────────────────────────────────
  const conflictOf = (wish: StoredPlanWish): boolean => {
    if (wish.leaveRequestId !== null) return false;
    const from = dayOf(wish.startDate);
    const to = dayOf(wish.endDate);
    return (leaveRangesByPerson.get(wish.employeeId) ?? []).some((range) =>
      rangesOverlap(from, to, range.from, range.to),
    );
  };
  // Editable follows the write admission of 835-05: a taken-over wish and a closed plan never; the
  // reader's own wish needs `leave-request:create:EIGENE` and, unless they manage the person, an
  // unlocked deadline; another person's wish needs the manage reach over that person on a wish day.
  const editableOf = (wish: StoredPlanWish): boolean => {
    if (planStatus !== "OPEN" || wish.leaveRequestId !== null || wish.planId !== plan.id) {
      return false;
    }
    const covers = manageCoversFromHomeDays(
      viewer.manageReach,
      wish.employeeId,
      population.homeByPerson.get(wish.employeeId),
      dayOf(wish.startDate),
      dayOf(wish.endDate),
    );
    if (viewer.employeeId !== null && wish.employeeId === viewer.employeeId) {
      if (viewer.canCreateOwn === false) return false;
      return !ownEditLocked({
        locksWishes: deadlineLocksWishes,
        deadlineDay,
        todayDay: todayLocal,
        actorIsManager: covers,
      });
    }
    return covers;
  };
  const plannerWishOf = (wish: StoredPlanWish, foreignPlan: boolean): PlannerWish => ({
    ...toPlannerWish(wish, {
      planStatus,
      leaveRequestStatus: wish.leaveRequestId ? (statusOf.get(wish.leaveRequestId) ?? null) : null,
    }),
    foreignPlan,
    conflict: conflictOf(wish),
    editable: foreignPlan ? false : editableOf(wish),
  });

  const persons: PlannerPerson[] = population.persons.map((person) => ({
    employeeId: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
    homeRanges: homeRangesIn(population.homeByPerson.get(person.id), plan.salonId, yearDays),
    rows: (rowsByPerson.get(person.id) ?? []).sort(
      (a, b) =>
        a.startDate.localeCompare(b.startDate) ||
        a.endDate.localeCompare(b.endDate) ||
        a.kind.localeCompare(b.kind),
    ),
    wishes: [
      ...shownOwnWishes
        .filter((w) => w.employeeId === person.id)
        .map((w) => plannerWishOf(w, false)),
      ...shownForeignWishes
        .filter((w) => w.employeeId === person.id)
        .map((w) => plannerWishOf(w, true)),
    ],
    forecast: null,
  }));

  // ── Day load (D-835-10/31): the limit kernel's count with the active, not-taken-over wishes of
  // the population as candidates; rule data only for a reader with the manage or approve reach. ──
  const candidateWishes = [
    ...(planStatus === "OPEN"
      ? ownWishes.filter((w) => w.leaveRequestId === null && personIdSet.has(w.employeeId))
      : []),
    ...otherWishes,
  ];
  const showLimits = (
    await Promise.all(
      [viewer.manageReach, viewer.approveReach].map((reach) =>
        resolveSalonInReach(db, tenantId, reach, plan.salonId),
      ),
    )
  ).some((salon) => salon.ok && salon.salonId !== null);
  const dayLoad = await plannerDayLoad(db, {
    tenantId,
    salonId: plan.salonId,
    year: plan.year,
    wishes: candidateWishes.map((w) => ({
      employeeId: w.employeeId,
      startDay: dayOf(w.startDate),
      endDay: dayOf(w.endDate),
    })),
    showLimits,
  });

  // ── Forecast (D-835-11/25): only for the reader's own row or a person inside the reader's
  // `leave-entitlement:read` reach; everybody else gets `null` (no new visibility rule, D-835-04). ──
  const entitlementVisibility = readerVisibilityFrom(viewer.entitlementReach, viewer.employeeId);
  const wishesByPerson = new Map<string, typeof candidateWishes>();
  for (const w of candidateWishes) {
    const list = wishesByPerson.get(w.employeeId);
    if (list) list.push(w);
    else wishesByPerson.set(w.employeeId, [w]);
  }
  for (const person of persons) {
    if (!isPersonVisibleOn(entitlementVisibility, person.employeeId, plan.salonId)) continue;
    person.forecast = await plannerForecast(db, {
      tenantId,
      employeeId: person.employeeId,
      year: plan.year,
      wishes: (wishesByPerson.get(person.employeeId) ?? []).map((w) => ({
        id: w.id,
        startDay: dayOf(w.startDate),
        endDay: dayOf(w.endDate),
        halfDay: w.halfDay,
      })),
      now,
    });
  }

  return {
    plan: {
      id: plan.id,
      salonId: plan.salonId,
      year: plan.year,
      deadline: deadlineDay,
      status: planStatus,
      openedAt: plan.openedAt.toISOString(),
      takenOverAt: plan.takenOverAt ? plan.takenOverAt.toISOString() : null,
      deadlinePassed: passed,
      deadlineLocksWishes,
      partiallyTakenOver: planStatus === "OPEN" && ownWishes.some((w) => w.leaveRequestId !== null),
    },
    viewer: {
      employeeId: viewer.employeeId,
      canManage: viewer.canManage,
      canWishOwn:
        planStatus === "OPEN" &&
        viewer.employeeId !== null &&
        personIdSet.has(viewer.employeeId) &&
        viewer.canCreateOwn !== false,
      ownEditLocked: ownEditLocked({
        locksWishes: deadlineLocksWishes,
        deadlineDay,
        todayDay: todayLocal,
        actorIsManager: viewer.canManage,
      }),
    },
    persons,
    holidays: holidays.map((h) => ({ date: h.date, name: h.name })),
    dayLoad,
  };
}
