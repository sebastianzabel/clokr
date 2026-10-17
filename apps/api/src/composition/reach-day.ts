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
// This module carries no business rule of its own: it only picks the day and delegates.

/** Tenant-local calendar day (UTC-midnight Date) of "today" for a reach lookup. */
export function reachToday(tz: string): Date {
  return todayInTz(tz);
}

/**
 * The calendar day a person's reach is judged on for month `y`/`m`: the tenant-local exit day when
 * `exitDate` lies inside the month, else the month's last calendar day.
 */
export function monthReachDay(exitDate: Date | null, y: number, m: number, tz: string): Date {
  const { start, end } = monthRangeUtc(y, m, tz);
  const { lastDay } = monthDateRange(y, m, tz);
  if (exitDate !== null && exitDate >= start && exitDate <= end) {
    return new Date(`${dateStrInTz(exitDate, tz)}T00:00:00Z`);
  }
  return lastDay;
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
  if (reach.kind === "wholeTenant") return "all";
  const { start, end } = monthRangeUtc(y, m, tz);
  const { lastDay } = monthDateRange(y, m, tz);
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
