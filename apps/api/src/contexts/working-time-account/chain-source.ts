/**
 * Issue #696 — where the account chain (`computeAccountChain`, overtime-balance.ts) reads its
 * inputs from. The chain's arithmetic is written once; only the READS differ:
 *
 *  - `querySource`        - one person, queried on demand. This is what the live saldo and the
 *                           single `openMonthCarryInMinutes` always did, query for query.
 *  - `loadChainSources`   - many persons of one tenant, every collection read ONCE for all of them
 *                           and handed out per person. The chain then filters in memory with the
 *                           same bounds the queries carried, so the figures are identical (pinned
 *                           by `open-month-carry-bulk-696.test.ts`).
 *
 * Nothing here computes a saldo and nothing writes. A person whose data would make the in-memory
 * answer ambiguous (two schedules with the same `validFrom`, two active opening balances) gets the
 * query source, whose answer is the single read's by construction.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import {
  getAbsencesOverlapping,
  getActiveLeaveOverlapping,
  loadBsSlotOverrides,
  loadBsSlotOverridesForMany,
} from "../absence";
import { holidaysAtWorkLocation } from "../platform";
import { getShiftsInRange } from "../scheduling";
import {
  defaultScheduleFromTenantConfig,
  getEffectiveSchedule,
  getValidWorkedEntriesInRange,
  getWorkedEntriesInRange,
} from "../time-tracking";
import { getCarryOverBase } from "./carry-over-base";
import { getConfirmedCarryOver, type ConfirmedCarryOver } from "./confirmed-saldo";
import { dateStrInTz, getTenantTimezone, monthRangeUtc } from "./timezone";

export type ChainEmployee = {
  tenantId: string;
  hireDate: Date;
  exitDate: Date | null;
  isTimeTrackingExempt: boolean;
  breakOver6hOverride: number | null;
  breakOver9hOverride: number | null;
};
export type ChainTenantConfig = Prisma.TenantConfigGetPayload<object>;
export type ChainSchedule = Awaited<ReturnType<typeof getEffectiveSchedule>>;
export type ChainEntry = Awaited<ReturnType<typeof getValidWorkedEntriesInRange>>[number];
export type ChainShift = Awaited<ReturnType<typeof getShiftsInRange>>[number];
export type ChainLeave = Awaited<ReturnType<typeof getActiveLeaveOverlapping>>[number];
export type ChainAbsence = Awaited<ReturnType<typeof getAbsencesOverlapping>>[number];
export type ChainBsOverrides = Awaited<ReturnType<typeof loadBsSlotOverrides>>;

export interface ChainSource {
  employee(): Promise<ChainEmployee | null>;
  timezone(tenantId: string): Promise<string>;
  /** The schedule valid at `date` (default: now), the tenant-default fallback otherwise. */
  scheduleAt(date?: Date): Promise<ChainSchedule>;
  /** The stored schedule row valid at `date`, `null` when there is none (no fallback). */
  scheduleRowAt(date: Date): Promise<Prisma.WorkScheduleGetPayload<object> | null>;
  /** The latest closed month (optionally only those starting before `periodStartBefore`). */
  confirmedCarryOver(
    tenantId: string,
    options: { periodStartBefore?: Date },
  ): Promise<ConfirmedCarryOver>;
  tenantConfig(tenantId: string): Promise<ChainTenantConfig | null>;
  /** T1: closed, valid WORK entries with `from <= date <= to`. */
  validEntries(tenantId: string, from: Date, to: Date): Promise<ChainEntry[]>;
  /**
   * The holiday dates (tenant-local YYYY-MM-DD) at the person's work location over the calendar
   * years of `[rangeStart, effectiveEnd]`; empty when the tenant has no active salon (fail-soft,
   * see the call site's comment in `computeAccountChain`).
   */
  holidayDates(
    app: FastifyInstance,
    tenantId: string,
    employeeId: string,
    rangeStart: Date,
    effectiveEnd: Date,
  ): Promise<Set<string>>;
  /**
   * The holiday dates between two tenant-local days at the person's work location (the month core's
   * window). Unlike `holidayDates` it does not swallow a refusal: a tenant without an active salon
   * throws, as the month core always did.
   */
  holidayDatesBetween(
    tenantId: string,
    employeeId: string,
    entriesFrom: Date,
    entriesTo: Date,
    fromDay: string,
    toDay: string,
  ): Promise<Set<string>>;
  shifts(tenantId: string, from: Date, to: Date): Promise<ChainShift[]>;
  leave(tenantId: string, from: Date, to: Date): Promise<ChainLeave[]>;
  absences(tenantId: string, from: Date, to: Date): Promise<ChainAbsence[]>;
  /** The chain head (`getCarryOverBase`): the last close's carry, else the OpeningBalance. */
  carryOverBase(prevSnapshot: { carryOver: number } | null): Promise<number>;
  bsSlotOverrides(referenceDate: Date): Promise<ChainBsOverrides>;
}

/**
 * What the database compares a bound against on a `@db.Date` column: Prisma casts the instant to
 * its UTC date part (see `periodStartWindow`, snapshot-period.ts). The in-memory filters below use
 * the same cast, so they keep exactly the rows the single queries keep - including the previous
 * local day that an instant month bound takes in (Issue #493).
 */
function dayOf(instant: Date): Date {
  return new Date(`${instant.toISOString().slice(0, 10)}T00:00:00Z`);
}

/** The calendar-year window the chain resolves holidays for (full years, see its call site). */
function holidayWindow(rangeStart: Date, effectiveEnd: Date): { fromDay: string; toDay: string } {
  return {
    fromDay: `${rangeStart.getUTCFullYear()}-01-01`,
    toDay: `${effectiveEnd.getUTCFullYear()}-12-31`,
  };
}

// ── One person, queried on demand (the behaviour before Issue #696, unchanged) ───────────────

export function querySource(app: FastifyInstance, employeeId: string): ChainSource {
  const scope = (tenantId: string) => ({ kind: "employee" as const, employeeId, tenantId });
  return {
    employee: () =>
      app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: {
          tenantId: true,
          hireDate: true,
          exitDate: true, // Issue #447 (D-12) — clamps the live window at the exit date
          isTimeTrackingExempt: true, // Phase 76.7 (D-04, SALDO-V19-04)
          breakOver6hOverride: true, // v1.8.9 — SHIFT_BASED netto saldo
          breakOver9hOverride: true, // v1.8.9 — SHIFT_BASED netto saldo
        },
      }),
    timezone: (tenantId) => getTenantTimezone(app.prisma, tenantId),
    scheduleAt: (date) => getEffectiveSchedule(app, employeeId, date),
    scheduleRowAt: (date) =>
      app.prisma.workSchedule.findFirst({
        where: { employeeId, validFrom: { lte: date } },
        orderBy: { validFrom: "desc" },
      }),
    holidayDatesBetween: async (tenantId, id, entriesFrom, entriesTo, fromDay, toDay) => {
      const workLocationEntries = await getWorkedEntriesInRange(
        app.prisma,
        scope(tenantId),
        entriesFrom,
        entriesTo,
      );
      const byEmployee = await holidaysAtWorkLocation(
        app.prisma,
        tenantId,
        [id],
        fromDay,
        toDay,
        workLocationEntries,
      );
      return new Set<string>(byEmployee.get(id)?.keys() ?? []);
    },
    confirmedCarryOver: (tenantId, options) =>
      getConfirmedCarryOver(app.prisma, employeeId, tenantId, options),
    tenantConfig: (tenantId) => app.prisma.tenantConfig.findUnique({ where: { tenantId } }),
    validEntries: (tenantId, from, to) =>
      getValidWorkedEntriesInRange(app.prisma, scope(tenantId), from, to),
    holidayDates: async (appInstance, tenantId, id, rangeStart, effectiveEnd) => {
      const { fromDay, toDay } = holidayWindow(rangeStart, effectiveEnd);
      const workLocationEntries = await getWorkedEntriesInRange(
        app.prisma,
        scope(tenantId),
        new Date(`${fromDay}T00:00:00Z`),
        new Date(`${toDay}T00:00:00Z`),
      );
      // This function has NO surrounding try/catch at many of its ~20 call sites - it must not
      // itself become a new way for an UNRELATED write to 500. The resolver is fail-closed when a
      // tenant has no active salon at all; degrade to "no work-location holiday resolvable".
      try {
        const byEmployee = await holidaysAtWorkLocation(
          app.prisma,
          tenantId,
          [id],
          fromDay,
          toDay,
          workLocationEntries,
        );
        return new Set<string>(byEmployee.get(id)?.keys() ?? []);
      } catch (err) {
        appInstance.log.warn(
          { err, employeeId: id },
          "computeOvertimeBalanceBreakdown: holidaysAtWorkLocation failed (tenant likely has no active salon) — continuing with no work-location holidays for this window",
        );
        return new Set<string>();
      }
    },
    shifts: (tenantId, from, to) => getShiftsInRange(app.prisma, scope(tenantId), from, to),
    leave: (tenantId, from, to) => getActiveLeaveOverlapping(app.prisma, scope(tenantId), from, to),
    absences: (tenantId, from, to) => getAbsencesOverlapping(app.prisma, scope(tenantId), from, to),
    carryOverBase: (prev) => getCarryOverBase(app.prisma, employeeId, prev),
    bsSlotOverrides: (referenceDate) => loadBsSlotOverrides(app.prisma, employeeId, referenceDate),
  };
}

// ── Many persons of one tenant, every collection read once ───────────────────────────────────

/** One (person, month) whose carry-in is asked for - the window the loader must cover. */
export type ChainRequest = { employeeId: string; year: number; month: number };

type ScheduleRow = Prisma.WorkScheduleGetPayload<object>;
type SnapshotRow = { employeeId: string; periodStart: Date; periodEnd: Date; carryOver: number };

/**
 * Sources for `requests` of ONE tenant. A person whose bulk answer could differ from the single
 * read's gets the query source instead (still correct, just not bulk). Returns an empty map for no
 * request. Closed months are only READ (their stored carry), never rewritten.
 */
export async function loadChainSources(
  app: FastifyInstance,
  tenantId: string,
  requests: readonly ChainRequest[],
): Promise<Map<string, ChainSource>> {
  const sources = new Map<string, ChainSource>();
  if (requests.length === 0) return sources;
  const employeeIds = [...new Set(requests.map((r) => r.employeeId))];
  const tz = await getTenantTimezone(app.prisma, tenantId);
  const todayStr = dateStrInTz(new Date(), tz);
  const fallbackToQuery = (id: string) => sources.set(id, querySource(app, id));

  const [employees, tenantConfig, schedules, snapshots, openingBalances] = await Promise.all([
    app.prisma.employee.findMany({
      where: { id: { in: employeeIds }, tenantId },
      select: {
        id: true,
        tenantId: true,
        hireDate: true,
        exitDate: true,
        isTimeTrackingExempt: true,
        breakOver6hOverride: true,
        breakOver9hOverride: true,
      },
    }),
    app.prisma.tenantConfig.findUnique({ where: { tenantId } }),
    app.prisma.workSchedule.findMany({
      where: { employeeId: { in: employeeIds }, employee: { tenantId } },
      orderBy: { validFrom: "desc" },
    }),
    app.prisma.saldoSnapshot.findMany({
      where: {
        employeeId: { in: employeeIds },
        employee: { tenantId },
        periodType: "MONTHLY",
        superseded: false,
      },
      orderBy: { periodStart: "desc" },
      select: { employeeId: true, periodStart: true, periodEnd: true, carryOver: true },
    }),
    app.prisma.openingBalance.findMany({
      where: { employeeId: { in: employeeIds }, employee: { tenantId }, superseded: false },
      select: { employeeId: true, minutes: true },
    }),
  ]);

  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const group = <T extends { employeeId: string }>(rows: readonly T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      const list = map.get(row.employeeId) ?? [];
      list.push(row);
      map.set(row.employeeId, list);
    }
    return map;
  };
  const schedulesBy = group<ScheduleRow>(schedules);
  const snapshotsBy = group<SnapshotRow>(snapshots);
  const openingBy = group(openingBalances);

  // Persons whose in-memory answer is not provably the single read's: query source.
  const bulkIds: string[] = [];
  for (const id of employeeIds) {
    const emp = employeeById.get(id);
    const list = schedulesBy.get(id) ?? [];
    const tied = list.some(
      (s, i) => i > 0 && s.validFrom.getTime() === list[i - 1]!.validFrom.getTime(),
    );
    const snapList = snapshotsBy.get(id) ?? [];
    const tiedSnapshots = snapList.some(
      (s, i) => i > 0 && s.periodStart.getTime() === snapList[i - 1]!.periodStart.getTime(),
    );
    if (!emp || tied || tiedSnapshots || (openingBy.get(id)?.length ?? 0) > 1) fallbackToQuery(id);
    else bulkIds.push(id);
  }
  if (bulkIds.length === 0) return sources;

  // The widest window any bulk person's chain can read: from the earliest chain start (the day after
  // the closed month before the request's month, else the hire day) to the end of today's month
  // (the roster/leave horizon of a chain at Stichtag today; later Stichtage are the same bound).
  const startOf = (id: string, r: ChainRequest): Date => {
    const emp = employeeById.get(id)!;
    const monthFirst = `${r.year}-${String(r.month).padStart(2, "0")}-01`;
    const virtualToday = monthFirst < todayStr ? monthFirst : todayStr;
    const bound = monthRangeUtc(
      Number(virtualToday.slice(0, 4)),
      Number(virtualToday.slice(5, 7)),
      tz,
    ).start;
    const closed = (snapshotsBy.get(id) ?? []).find((s) => s.periodStart < dayOf(bound));
    return closed
      ? new Date(dateStrInTz(new Date(closed.periodEnd.getTime() + 86400000), tz) + "T00:00:00Z")
      : new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z");
  };
  let from = new Date(`${todayStr}T00:00:00Z`);
  const bulkSet = new Set(bulkIds);
  for (const r of requests) {
    if (!bulkSet.has(r.employeeId)) continue;
    const s = startOf(r.employeeId, r);
    if (s < from) from = s;
  }
  const horizon = monthRangeUtc(Number(todayStr.slice(0, 4)), Number(todayStr.slice(5, 7)), tz).end;
  // The month core (`computeMonthSaldo`) of a requested month reads from that month's first day and
  // up to its end INSTANT (leave and absences compare instants, Issue #493), so the window covers it.
  let horizonInstant = horizon;
  for (const r of requests) {
    if (!bulkSet.has(r.employeeId)) continue;
    const { start, end } = monthRangeUtc(r.year, r.month, tz);
    const firstDay = new Date(dateStrInTz(start, tz) + "T00:00:00Z");
    if (firstDay < from) from = firstDay;
    if (end > horizonInstant) horizonInstant = end;
  }
  const horizonDay = horizonInstant;
  // Requests for months after today still chain through today only (virtualToday = today), so the
  // horizon above covers them.
  const scopeAll = { kind: "employees" as const, employeeIds: bulkIds, tenantId };

  const [validEntries, workEntries, leave, absences, shifts, bsResolvers] = await Promise.all([
    getValidWorkedEntriesInRange(app.prisma, scopeAll, from, horizonDay),
    // The work-location rows start at Jan 1 of the window's first year, like the single chain's.
    getWorkedEntriesInRange(
      app.prisma,
      scopeAll,
      new Date(`${from.getUTCFullYear()}-01-01T00:00:00Z`),
      horizonDay,
    ),
    getActiveLeaveOverlapping(app.prisma, scopeAll, from, horizonDay),
    getAbsencesOverlapping(app.prisma, scopeAll, from, horizonDay),
    // Every bulk person: the month core reads shifts whatever the schedule type is.
    getShiftsInRange(app.prisma, scopeAll, from, horizonDay),
    loadBsSlotOverridesForMany(app.prisma, bulkIds),
  ]);

  // Holidays at the work location of every day, ONE batched resolver call over the full calendar
  // years of the window (the chain filters to its own months).
  const fromDay = `${from.getUTCFullYear()}-01-01`;
  const toDay = `${horizonDay.getUTCFullYear()}-12-31`;
  let holidays: Awaited<ReturnType<typeof holidaysAtWorkLocation>>;
  try {
    holidays = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      bulkIds,
      fromDay,
      toDay,
      workEntries,
    );
  } catch {
    // The resolver refuses (a day without any resolvable salon). Which person it concerns, and
    // whether the single read degrades or throws, is the single read's business: ask it per person.
    for (const id of bulkIds) fallbackToQuery(id);
    return sources;
  }

  const validBy = group(validEntries);
  const leaveBy = group(leave);
  const absencesBy = group(absences);
  const shiftsBy = group(shifts);

  for (const id of bulkIds) {
    const emp = employeeById.get(id)!;
    const scheduleList = schedulesBy.get(id) ?? [];
    const snaps = snapshotsBy.get(id) ?? [];
    const myValid = validBy.get(id) ?? [];
    const myLeave = leaveBy.get(id) ?? [];
    const myAbsences = absencesBy.get(id) ?? [];
    const myShifts = shiftsBy.get(id) ?? [];
    const bs = bsResolvers.get(id);
    const opening = openingBy.get(id)?.[0]?.minutes ?? 0;
    sources.set(id, {
      employee: async () => emp,
      timezone: async () => tz,
      scheduleRowAt: async (date) => scheduleList.find((s) => s.validFrom <= date) ?? null,
      holidayDatesBetween: async (_tenant, _id, _from, _to, fromDayStr, toDayStr) => {
        const days = holidays.get(id);
        return new Set<string>(
          [...(days?.keys() ?? [])].filter((d) => d >= fromDayStr && d <= toDayStr),
        );
      },
      scheduleAt: async (date) => {
        const target = date ?? new Date();
        return (
          scheduleList.find((s) => s.validFrom <= target) ??
          defaultScheduleFromTenantConfig(tenantConfig)
        );
      },
      confirmedCarryOver: async (_tenant, options) => {
        const before = options.periodStartBefore;
        const hit = snaps.find((s) => (before ? s.periodStart < dayOf(before) : true));
        return hit
          ? { minutes: hit.carryOver, hasClosedMonth: true, periodEnd: hit.periodEnd }
          : { minutes: 0, hasClosedMonth: false, periodEnd: null };
      },
      tenantConfig: async () => tenantConfig,
      validEntries: async (_tenant, f, t) =>
        myValid.filter((e) => e.date >= dayOf(f) && e.date <= dayOf(t)),
      holidayDates: async () => new Set<string>(holidays.get(id)?.keys() ?? []),
      shifts: async (_tenant, f, t) =>
        myShifts.filter((s) => s.date >= dayOf(f) && s.date <= dayOf(t)),
      leave: async (_tenant, f, t) =>
        myLeave.filter((l) => l.startDate <= dayOf(t) && l.endDate >= dayOf(f)),
      absences: async (_tenant, f, t) =>
        myAbsences.filter((a) => a.startDate <= dayOf(t) && a.endDate >= dayOf(f)),
      carryOverBase: async (prev) => (prev ? prev.carryOver : opening),
      bsSlotOverrides: async (ref) =>
        bs
          ? bs(ref)
          : { employeeSlots: null, patternSlots: null, patternUnterrichtsMinutenByDow: null },
    });
  }
  return sources;
}
