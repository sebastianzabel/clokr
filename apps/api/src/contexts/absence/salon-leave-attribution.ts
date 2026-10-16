/**
 * Issue #558 (D-02/D-08) — the ONE place that decides whether a leave request, an imposed absence
 * or a § 9 case belongs to a salon.
 *
 * An absence follows the employee's Stammsalon PER DAY (`homeSalonsForDays`, HOME rows only — never
 * a deployment, never the salon of a time entry). A row is kept when that Stammsalon equals the
 * salon on at least one day of the row's range clipped to the caller's window, so a row spanning a
 * Stammsalon change appears under both salons (the documented #84 D-04 behaviour). A person
 * without any HOME row is attributable to no salon and their rows are dropped.
 *
 * Extracted from the dashboard's `team-upcoming-leave` (#84) because the rule belongs to the
 * Abwesenheiten context, not to the composition layer (CLAUDE.md, ADR 0002 Entscheidung 9); the
 * dashboard and the leave reads of the team pages both call it, so there is no second attribution
 * rule that could drift.
 */
import type { Prisma } from "@clokr/db";
import { homeSalonsForDays } from "../platform";

/** The shape the attribution needs; `startDate`/`endDate` are the `@db.Date` columns. */
export interface SalonAttributableRow {
  employeeId: string;
  startDate: Date;
  endDate: Date;
}

/**
 * True iff some day in `[fromDay, toDay]` maps to `salonId` in the employee's per-day Stammsalon
 * map. An undefined map (no entry for the employee) is false; days outside the range never count.
 * Days are `YYYY-MM-DD` strings, compared lexicographically.
 */
export function isHomedInSalonOnAnyDay(
  dayMap: ReadonlyMap<string, string | null> | undefined,
  salonId: string,
  fromDay: string,
  toDay: string,
): boolean {
  if (!dayMap) return false;
  for (const [day, homeSalon] of dayMap) {
    if (day >= fromDay && day <= toDay && homeSalon === salonId) return true;
  }
  return false;
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Keeps the rows whose employee is homed in `salonId` on at least one day of the row's own range,
 * clipped to the optional `window` (calendar-day strings, inclusive): from = later of the row's
 * start day and `window.fromDay`, to = earlier of its end day and `window.toDay`. A row whose
 * clipped range is empty is dropped. The input order of the kept rows is preserved.
 *
 * The surviving rows are bucketed by the calendar year of their clipped start and each bucket
 * issues ONE `homeSalonsForDays` call over its own span. This bounds the size of the day maps for
 * unbounded lists (`/teamcal` loads every effective request, the iCal feed has no window) — never
 * one map over a multi-year span.
 */
export async function filterLeaveRowsToHomeSalon<T extends SalonAttributableRow>(
  db: Prisma.TransactionClient,
  tenantId: string,
  rows: readonly T[],
  salonId: string,
  window: { fromDay?: string; toDay?: string } = {},
): Promise<T[]> {
  if (rows.length === 0) return [];

  interface Clipped {
    row: T;
    from: string;
    to: string;
  }
  const clipped: Clipped[] = [];
  for (const row of rows) {
    const startDay = dayString(row.startDate);
    const endDay = dayString(row.endDate);
    const from =
      window.fromDay !== undefined && window.fromDay > startDay ? window.fromDay : startDay;
    const to = window.toDay !== undefined && window.toDay < endDay ? window.toDay : endDay;
    if (from > to) continue;
    clipped.push({ row, from, to });
  }

  const buckets = new Map<string, Clipped[]>();
  for (const entry of clipped) {
    const year = entry.from.slice(0, 4);
    const bucket = buckets.get(year);
    if (bucket) bucket.push(entry);
    else buckets.set(year, [entry]);
  }

  const kept = new Set<T>();
  for (const bucket of buckets.values()) {
    const minFrom = bucket.reduce((min, e) => (e.from < min ? e.from : min), bucket[0].from);
    const maxTo = bucket.reduce((max, e) => (e.to > max ? e.to : max), bucket[0].to);
    const homeByPerson = await homeSalonsForDays(
      db,
      tenantId,
      Array.from(new Set(bucket.map((e) => e.row.employeeId))),
      minFrom,
      maxTo,
    );
    for (const e of bucket) {
      if (isHomedInSalonOnAnyDay(homeByPerson.get(e.row.employeeId), salonId, e.from, e.to)) {
        kept.add(e.row);
      }
    }
  }

  return rows.filter((row) => kept.has(row));
}
