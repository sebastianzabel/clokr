import type { Prisma } from "@clokr/db";
import {
  resolveStammsalonScopedEmployeeIds,
  isStammsalonScopeMatch,
  type AccessReach,
} from "../contexts/platform";
import {
  monthRangeUtc,
  monthDateRange,
  dateStrInTz,
  todayInTz,
} from "../contexts/working-time-account";

// Issue #679 — the one place the composition layer decides ON WHICH CALENDAR DAY a person's
// Stammsalon reach is judged for a month-bound read. Owner decision 17.10.2026: a person who left
// inside the month is judged on the exit day, everyone else on the last day of the month (the same
// Stichtag rule as the Saldenübersicht #613 and the Monatsexport salon filter #542). The Stammsalon
// resolution itself (`contexts/platform/scope-filter.ts`) is unchanged and always receives a
// tenant-local CALENDAR day (UTC-midnight Date, HOME validity is @db.Date, #493), never an instant.
// Issue #714 generalises the month rule to a period: for a person whose exit lies inside the period
// the exit day, else the last calendar day of the period's last month. A single month is the period
// from = to, so every single-month caller keeps its exact behaviour.
// This module carries no business rule of its own: it only picks the day and delegates.

/** Tenant-local calendar day (UTC-midnight Date) of "today" for a reach lookup. */
export function reachToday(tz: string): Date {
  return todayInTz(tz);
}

/** A calendar month, as the period route and the single-month callers name it. */
export type ReachMonth = { year: number; month: number };

/**
 * The calendar day a person's reach is judged on for the period `from`..`to` (Issue #714, the
 * period generalisation of the month rule): the tenant-local exit day when `exitDate` lies inside
 * the period (from the start of the `from` month to the end of the `to` month), else the last
 * calendar day of the `to` month. For `from` = `to` this is exactly the month rule of #679.
 */
export function periodReachDay(
  exitDate: Date | null,
  from: ReachMonth,
  to: ReachMonth,
  tz: string,
): Date {
  const { start } = monthRangeUtc(from.year, from.month, tz);
  const { end } = monthRangeUtc(to.year, to.month, tz);
  const { lastDay } = monthDateRange(to.year, to.month, tz);
  if (exitDate !== null && exitDate >= start && exitDate <= end) {
    return new Date(`${dateStrInTz(exitDate, tz)}T00:00:00Z`);
  }
  return lastDay;
}

/**
 * The calendar day a person's reach is judged on for month `y`/`m`: the tenant-local exit day when
 * `exitDate` lies inside the month, else the month's last calendar day.
 */
export function monthReachDay(exitDate: Date | null, y: number, m: number, tz: string): Date {
  return periodReachDay(exitDate, { year: y, month: m }, { year: y, month: m }, tz);
}

/**
 * List mode over a period (Issue #714): every person in `reach` for the period `from`..`to`, each
 * judged on their own reach day ({@link periodReachDay}). `wholeTenant` -> `"all"` without a query.
 */
export async function resolvePeriodReachIds(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
  from: ReachMonth,
  to: ReachMonth,
  tz: string,
): Promise<"all" | string[]> {
  if (reach.kind === "wholeTenant") return "all";
  const { start } = monthRangeUtc(from.year, from.month, tz);
  const { end } = monthRangeUtc(to.year, to.month, tz);
  const { lastDay } = monthDateRange(to.year, to.month, tz);
  const homeOn = async (calendarDay: Date): Promise<Set<string>> => {
    const ids = await resolveStammsalonScopedEmployeeIds(db, tenantId, reach, calendarDay);
    return new Set(ids === "all" ? [] : ids);
  };

  const leavers = await db.employee.findMany({
    where: { tenantId, exitDate: { gte: start, lte: end } },
    select: { id: true, exitDate: true },
  });
  const leaverIds = new Set(leavers.map((l) => l.id));
  const members = new Set<string>();
  for (const id of await homeOn(lastDay)) {
    if (!leaverIds.has(id)) members.add(id);
  }
  const byExitDay = new Map<string, string[]>();
  for (const leaver of leavers) {
    const exitDay = dateStrInTz(leaver.exitDate as Date, tz);
    byExitDay.set(exitDay, [...(byExitDay.get(exitDay) ?? []), leaver.id]);
  }
  for (const [exitDay, ids] of byExitDay) {
    const home = await homeOn(new Date(`${exitDay}T00:00:00Z`));
    for (const id of ids) if (home.has(id)) members.add(id);
  }
  return [...members];
}

/**
 * List mode: every person in `reach` for month `y`/`m`, each judged on their own reach day
 * ({@link monthReachDay}). `wholeTenant` -> `"all"` without a query.
 */
export async function resolveMonthReachIds(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
  y: number,
  m: number,
  tz: string,
): Promise<"all" | string[]> {
  return resolvePeriodReachIds(
    db,
    tenantId,
    reach,
    { year: y, month: m },
    { year: y, month: m },
    tz,
  );
}

/** Single-row mode of {@link resolveMonthReachIds}: is `employeeId` in `reach` for month `y`/`m`? */
export async function isMonthReachMatch(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
  employeeId: string,
  y: number,
  m: number,
  tz: string,
): Promise<boolean> {
  if (reach.kind === "wholeTenant") return true;
  const person = await db.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { exitDate: true },
  });
  const day = monthReachDay(person?.exitDate ?? null, y, m, tz);
  return isStammsalonScopeMatch(db, tenantId, reach, employeeId, day);
}
