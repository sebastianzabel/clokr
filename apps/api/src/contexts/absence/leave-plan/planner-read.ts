/**
 * Issue #835 (D-835-09/22) — the live read of a leave plan (the planner).
 *
 * The persons are the plan population (`planPopulation`: Stammsalon in the year, employed in the
 * year, never anonymised), each with the `homeRanges` of the days homed in the plan's salon, the
 * rows read live from the Abwesenheiten facades (GESETZT = effective leave, Absence rows and
 * Betriebsurlaub minus the person's exceptions; BEANTRAGT = PENDING leave), the person's wishes of
 * this plan plus read-only wishes of OTHER open plans that touch the person's days in this salon,
 * and the salon's holidays. The conflict flag marks an unlinked wish over a leave row of the same
 * person. Foreign rows are decided PER PERSON with the calendar's rule (Issue #840, D-840-20): a
 * person the reader may read (`leave-request:read` reach, Stammsalon per day) gets detailed rows —
 * a sick type is shown only on the reader's own rows (Art. 9 DSGVO) — everybody else only a
 * merged `MASKED` / `ABWESEND` row, and a PENDING row of such a person is dropped. `forceNeutral`
 * (`?view=own`, the personal planner) masks every foreign row whatever the reach AND gives every
 * foreign wish the period only (never editable, no request status, refusal, conflict flag or
 * forecast, no limit rule data; E-03, review WR-02). No note, attest,
 * § 9 or document field is ever read into the planner.
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
import { findSalon, holidaysForSalon, resolveSalonInReach, type AccessReach } from "../../platform";
import { getTenantTimezone } from "../../working-time-account";
import { getAbsencesOverlapping } from "../facade/absences";
import { getCalendarLeaveOverlapping } from "../facade/leave-requests";
import { mergeDayRanges } from "../leave-calendar-masking";
import { eachDay } from "../leave-limits/counted-days";
import {
  isPersonVisibleOn,
  isPersonVisibleOnSomeDay,
  readerVisibilityFrom,
} from "../leave-limits/redact";
import { isSickLeaveTypeCode } from "../leave-type";
import { manageCoversFromHomeDays } from "./admission";
import { BLOCKS_PLAN_CLOSE } from "./constants";
import { plannerDayLoad, type PlannerDay } from "./day-load";
import { plannerForecast, type PlannerForecast } from "./forecast";

export type { PlannerDay, PlannerForecast };
import { planPopulation } from "./population";
import { dayOf, dayToDate, deadlinePassed, ownEditLocked, rangesOverlap } from "./wish-rules";

export type PlannerRow = {
  /** `MASKED`: a foreign absence outside the reader's reach — "abwesend", nothing else (#840). */
  kind: "LEAVE" | "ABSENCE" | "COMPANY_SHUTDOWN" | "MASKED";
  state: "GESETZT" | "BEANTRAGT" | "ABWESEND";
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
    /**
     * D-835-38 (WR-01): the active wishes a takeover can still turn into a request or approve, by
     * the takeover's own close rule (`BLOCKS_PLAN_CLOSE`), over EVERY wish of the plan (a wish of a
     * person outside the shown population included). Only for a reader who may take the plan over
     * (`viewer.canManage`); `null` otherwise.
     */
    openWishCount: number | null;
  };
  /** The plan salon (D-840-25): the personal planner draws its closed days from `openingHours`. */
  salon: { id: string; name: string; openingHours: unknown };
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
 * The type code of a DETAILED row of `ownerEmployeeId` (the reader may read the person): the
 * reader's own rows always; a sick code never on a colleague's row (stricter than the calendar,
 * D-835-22); every other code as it is.
 */
function detailedTypeCode(code: string | null, isOwn: boolean): string | null {
  if (code === null) return null;
  if (isOwn) return code;
  if (isSickLeaveTypeCode(code as Parameters<typeof isSickLeaveTypeCode>[0])) return null;
  return code;
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
      /**
       * Issue #840 (D-840-23): true for the personal planner (`?view=own`) — every foreign row is
       * masked whatever the reader's reach; own rows and wishes stay complete.
       */
      forceNeutral: boolean;
      /** Whether the caller may file requests of their own (`leave-request:create:EIGENE`). */
      canCreateOwn?: boolean;
      entitlementReach: AccessReach;
      manageReach: AccessReach;
      approveReach: AccessReach;
      /**
       * The caller's `leave-request:read` reach (D-835-44): a wish's refusal and the status of its
       * linked request are shown for another person only inside it; the reader's own always.
       */
      readReach: AccessReach;
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
  // Issue #840 (D-840-20): the detail level is decided per person with the calendar's rule — own
  // rows always, a foreign row iff the reader's `leave-request:read` reach covers the person on at
  // least one day of the row (Stammsalon per day); `forceNeutral` takes the foreign branch away.
  const visibility = readerVisibilityFrom(viewer.readReach, viewer.employeeId);
  const isForeign = (employeeId: string): boolean =>
    viewer.employeeId === null || employeeId !== viewer.employeeId;
  const maskedByPerson = new Map<string, Array<{ startDate: string; endDate: string }>>();
  const detailedFor = (employeeId: string, startDate: string, endDate: string): boolean => {
    if (viewer.employeeId !== null && employeeId === viewer.employeeId) return true;
    if (viewer.forceNeutral) return false;
    return isPersonVisibleOnSomeDay(
      visibility,
      employeeId,
      population.homeByPerson.get(employeeId),
      startDate < firstDay ? firstDay : startDate,
      endDate > lastDay ? lastDay : endDate,
    );
  };
  const collectMasked = (employeeId: string, startDate: string, endDate: string) => {
    const list = maskedByPerson.get(employeeId);
    if (list) list.push({ startDate, endDate });
    else maskedByPerson.set(employeeId, [{ startDate, endDate }]);
  };
  for (const r of leaveRows) {
    const isOwn = viewer.employeeId !== null && r.employeeId === viewer.employeeId;
    const startDate = dayOf(r.startDate);
    const endDate = dayOf(r.endDate);
    // The conflict flag reads the unmasked ranges (D-835-44 behaviour, T-840-14 accepted).
    const list = leaveRangesByPerson.get(r.employeeId);
    const range = { from: startDate, to: endDate };
    if (list) list.push(range);
    else leaveRangesByPerson.set(r.employeeId, [range]);
    if (detailedFor(r.employeeId, startDate, endDate)) {
      pushRow(r.employeeId, {
        kind: "LEAVE",
        state: r.status === "PENDING" ? "BEANTRAGT" : "GESETZT",
        startDate,
        endDate,
        halfDay: r.halfDay,
        typeCode: detailedTypeCode(r.leaveType.code, isOwn),
      });
    } else if (r.status !== "PENDING") {
      collectMasked(r.employeeId, startDate, endDate);
    }
  }
  for (const a of absenceRows) {
    const isOwn = viewer.employeeId !== null && a.employeeId === viewer.employeeId;
    const startDate = dayOf(a.startDate);
    const endDate = dayOf(a.endDate);
    if (detailedFor(a.employeeId, startDate, endDate)) {
      pushRow(a.employeeId, {
        kind: "ABSENCE",
        state: "GESETZT",
        startDate,
        endDate,
        halfDay: a.halfDay,
        typeCode: detailedTypeCode(a.type, isOwn),
      });
    } else {
      collectMasked(a.employeeId, startDate, endDate);
    }
  }
  for (const [employeeId, ranges] of maskedByPerson) {
    for (const range of mergeDayRanges(ranges)) {
      pushRow(employeeId, {
        kind: "MASKED",
        state: "ABWESEND",
        startDate: range.startDate,
        endDate: range.endDate,
        halfDay: false,
        typeCode: null,
      });
    }
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
    // The personal planner edits only the caller's own wishes, whatever the manage reach (E-03).
    if (viewer.forceNeutral && isForeign(wish.employeeId)) return false;
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
  // D-835-44 (WR-08): a refusal text can carry entitlement facts („bereits X genutzt“) and the
  // request status shows a REJECTED or CANCELLED request the calendar never shows, so both are
  // served for the reader's own wishes and, for another person, only inside the reader's
  // `leave-request:read` reach over that person (the same per-day Stammsalon rule as `editable`).
  const requestDetailsVisible = (wish: StoredPlanWish): boolean =>
    !isForeign(wish.employeeId) ||
    (!viewer.forceNeutral &&
      manageCoversFromHomeDays(
        viewer.readReach,
        wish.employeeId,
        population.homeByPerson.get(wish.employeeId),
        dayOf(wish.startDate),
        dayOf(wish.endDate),
      ));
  const plannerWishOf = (wish: StoredPlanWish, foreignPlan: boolean): PlannerWish => {
    const visible = requestDetailsVisible(wish);
    const neutralForeign = viewer.forceNeutral && isForeign(wish.employeeId);
    return {
      ...toPlannerWish(wish, {
        planStatus,
        leaveRequestStatus:
          visible && wish.leaveRequestId ? (statusOf.get(wish.leaveRequestId) ?? null) : null,
      }),
      ...(visible ? {} : { refusalCode: null, refusalMessage: null }),
      // The personal planner shows a colleague's wish as a period only: no link to a request (its
      // existence would tell a taken-over wish from an open one), no conflict flag (it reads the
      // colleague's leave days, pending ones included), never editable.
      ...(neutralForeign ? { leaveRequestId: null, halfDay: false } : {}),
      foreignPlan,
      conflict: neutralForeign ? false : conflictOf(wish),
      editable: foreignPlan || neutralForeign ? false : editableOf(wish),
    };
  };

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
  // The personal planner (`view=own`) carries no rule data at all: a rule names groups and limits
  // that describe other people (E-03); the plain per-day count stays.
  const showLimits =
    !viewer.forceNeutral &&
    (
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
    // The personal planner states no forecast for a colleague, whatever the entitlement reach.
    if (viewer.forceNeutral && isForeign(person.employeeId)) continue;
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

  const salon = await findSalon(db, tenantId, plan.salonId);

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
      openWishCount: viewer.canManage
        ? await db.leavePlanWish.count({
            where: { planId: plan.id, tenantId, deletedAt: null, ...BLOCKS_PLAN_CLOSE },
          })
        : null,
    },
    salon: {
      id: plan.salonId,
      name: salon?.name ?? "",
      openingHours: salon?.openingHours ?? null,
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
