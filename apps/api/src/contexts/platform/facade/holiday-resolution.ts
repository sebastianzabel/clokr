/**
 * Phase 71b Plan 02 (issue #71, D-04/D-05) — the ONE central holiday resolution in the Unterbau.
 *
 * § 2 EFZG: a statutory holiday applies where the work was, or would have been, performed — NOT a
 * single tenant-wide federal state (`Tenant.federalState`, the pre-71b, legally wrong behaviour a
 * chain with salons in more than one Bundesland exposed). This module is the ONLY place a holiday
 * set is built from `Salon.federalState` and salon-scoped `PublicHoliday` rows; after Phase 71b
 * Plan 07 rewires every reader onto it, `getHolidays()`/`STATE_MAP` (`../holidays`) and the
 * `publicHoliday` Prisma delegate are unreachable from outside `contexts/platform/` (D-05).
 *
 * The Unterbau NEVER reads `TimeEntry` itself (ADR 0001/0002: a shared-kernel context does not
 * depend on a business context) — {@link holidaysAtWorkLocation} takes the caller's already-loaded
 * closed work entries (`WorkLocationEntry`, the shape `getWorkedEntriesInRange` — T2,
 * `contexts/time-tracking/facade/time-entries.ts` — projects to) as plain data, never a query.
 *
 * Both exports are BATCHED — a constant number of queries regardless of employee count or day
 * count (PERF-V1814-01 discipline; several of the 13 readers this feeds are bulk, perf-hardened
 * paths). `holidaysAtWorkLocation` is fail-closed: a day that needs the tenant's default salon
 * when the tenant has no active salon throws (unreachable in production per Phase 64b D-18, which
 * guarantees every tenant has one) rather than silently answering "no holiday". A foreign or
 * unknown `employeeId`/`salonId` never leaks another tenant's data (T-100-09/T-71b-07): it is
 * absent from the result or yields `[]`.
 *
 * OUT OF SCOPE, deliberately: Christmas-Eve/New-Year's-Eve company rules and `SchoolHolidayPeriod`
 * (`federalStateOverride`/BS resolution) stay tenant-wide — this module answers only the STATUTORY
 * holiday question.
 */
import type { Prisma } from "@clokr/db";
import { getHolidays, STATE_MAP, type FederalStateCode } from "../holidays";
import { findDefaultSalon } from "./salons";
import { salonsForDays } from "./salon-assignments";
import { addDays, dateToDay, dayToDate, type CalendarDay } from "../salon-assignment-rules";

/** One statutory holiday of ONE salon on ONE day — {@link holidaysForSalon}'s element shape. A
 * manual `PublicHoliday` row on the same day overrides the computed name (`manualHolidayId` set);
 * a purely computed holiday carries `manualHolidayId: null`. */
export interface SalonHoliday {
  date: CalendarDay;
  name: string;
  manualHolidayId: string | null;
}

/** The shape a caller's closed work entry must project to for {@link holidaysAtWorkLocation} — the
 * exact fields `getWorkedEntriesInRange` (T2) now selects (Phase 71b Plan 02). */
export interface WorkLocationEntry {
  employeeId: string;
  date: Date;
  startTime: Date;
  salonId: string;
}

/** `employeeId -> (calendar day -> holiday name)` — {@link holidaysAtWorkLocation}'s result. An
 * employee absent from this map is a foreign or unknown id (T-100-09 safe); an employee present
 * with an empty inner map simply has no holiday in the requested range. */
export type HolidaysByEmployee = Map<string, Map<CalendarDay, string>>;

/**
 * The private builder both {@link holidaysForSalon} and {@link holidaysAtWorkLocation} call — the
 * two public functions can therefore never drift apart on what counts as "a holiday of this salon
 * on this day". Computes the calculable holidays of `stateCode` for every year `fromDay`'s year
 * through `toDay`'s year touches (year-boundary periods included, matching every existing caller's
 * pre-71b behaviour), filters to `[fromDay, toDay]`, then overlays `manualForSalon` — a manual row
 * on a day REPLACES the computed entry for that day (same day key), never adds a second one.
 * `stateCode` undefined (a salon lookup that already failed) yields only the manual overlay.
 */
function buildSalonHolidayMap(
  stateCode: FederalStateCode | undefined,
  manualForSalon: Map<CalendarDay, { id: string; name: string }> | undefined,
  fromDay: CalendarDay,
  toDay: CalendarDay,
): Map<CalendarDay, SalonHoliday> {
  const result = new Map<CalendarDay, SalonHoliday>();

  if (stateCode) {
    const fromYear = Number(fromDay.slice(0, 4));
    const toYear = Number(toDay.slice(0, 4));
    for (let year = fromYear; year <= toYear; year++) {
      for (const holiday of getHolidays(year, stateCode)) {
        if (holiday.date >= fromDay && holiday.date <= toDay) {
          result.set(holiday.date, {
            date: holiday.date,
            name: holiday.name,
            manualHolidayId: null,
          });
        }
      }
    }
  }

  if (manualForSalon) {
    for (const [day, manual] of manualForSalon) {
      result.set(day, { date: day, name: manual.name, manualHolidayId: manual.id });
    }
  }

  return result;
}

/** Reads the manual `PublicHoliday` rows of the given salons in `[fromDay, toDay]`, grouped by
 * salon then day — the shared shape {@link buildSalonHolidayMap} overlays onto the computed set.
 * Empty `salonIds` short-circuits with no query. */
async function fetchManualHolidaysBySalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonIds: readonly string[],
  fromDay: CalendarDay,
  toDay: CalendarDay,
): Promise<Map<string, Map<CalendarDay, { id: string; name: string }>>> {
  const result = new Map<string, Map<CalendarDay, { id: string; name: string }>>();
  if (salonIds.length === 0) return result;

  const rows = await db.publicHoliday.findMany({
    where: {
      tenantId,
      salonId: { in: [...salonIds] },
      date: { gte: dayToDate(fromDay), lte: dayToDate(toDay) },
    },
  });
  for (const row of rows) {
    const day = dateToDay(row.date);
    const bySalon = result.get(row.salonId);
    if (bySalon) {
      bySalon.set(day, { id: row.id, name: row.name });
    } else {
      result.set(row.salonId, new Map([[day, { id: row.id, name: row.name }]]));
    }
  }
  return result;
}

/**
 * D-04 function 1: every statutory holiday of ONE salon in `[fromDay, toDay]` — the salon's
 * computed holidays (`Salon.federalState` via `getHolidays`/`STATE_MAP`) UNION its manual
 * `PublicHoliday` rows, sorted by date. A `salonId` belonging to a foreign tenant, or one that does
 * not exist at all, yields `[]` (T-100-09: one code path, byte-identical for both).
 *
 * Exactly ONE `db.salon.findFirst` and (when the salon exists) ONE `db.publicHoliday.findMany`.
 */
export async function holidaysForSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
  fromDay: CalendarDay,
  toDay: CalendarDay,
): Promise<SalonHoliday[]> {
  const salon = await db.salon.findFirst({
    where: { id: salonId, tenantId },
    select: { id: true, federalState: true },
  });
  if (!salon) return [];

  const manualBySalon = await fetchManualHolidaysBySalon(db, tenantId, [salon.id], fromDay, toDay);
  const map = buildSalonHolidayMap(
    STATE_MAP[salon.federalState],
    manualBySalon.get(salon.id),
    fromDay,
    toDay,
  );
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * D-04 function 2: "is day D a holiday for employee E?", answered by WORK LOCATION (§ 2 EFZG) —
 * batched over `employeeIds` and the whole `[fromDay, toDay]` range, per issue #71's own wording
 * ("Feiertage eines Mitarbeiters in einem Zeitraum nach dem Recht am Arbeitsort").
 *
 * Per employee and day, the salon in effect is:
 *   1. the caller-supplied closed work `entries` of that employee on that day — if more than one
 *      (MULTI-ENTRY, #70 not yet decided), the EARLIEST `startTime` wins, as an interim, explicitly
 *      flagged choice (mirrors the pattern already established elsewhere per #69);
 *   2. else `salonsForDays()` (the batched form of #67's `salonForDay`, work-location fallback);
 *   3. else the tenant's default salon (`findDefaultSalon`) — and if THAT does not exist either,
 *      this throws (fail-closed; unreachable in production, Phase 64b D-18 guarantees every tenant
 *      has an active salon).
 *
 * `entries` for employees not in `employeeIds`, or dated outside `[fromDay, toDay]`, are ignored. A
 * foreign or unknown `employeeId` is silently ABSENT from the result (T-100-09/T-71b-07 safe) —
 * `salonsForDays` never returns an entry for someone it could not find in this tenant.
 *
 * Constant query count regardless of employee/day count: ONE `salonsForDays` call (which is itself
 * one `employee.findMany` + one `employeeSalonAssignment.findMany`), at most ONE
 * `findDefaultSalon` call (cached after its first use), ONE `db.salon.findMany` for the distinct
 * salons actually needed, and ONE `db.publicHoliday.findMany` for those same salons.
 */
export async function holidaysAtWorkLocation(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeIds: readonly string[],
  fromDay: CalendarDay,
  toDay: CalendarDay,
  entries: readonly WorkLocationEntry[],
): Promise<HolidaysByEmployee> {
  const result: HolidaysByEmployee = new Map();
  if (employeeIds.length === 0 || fromDay > toDay) return result;

  const idSet = new Set(employeeIds);

  // Group the caller-supplied entries by employee and day, keeping only the earliest start time
  // per day.
  const entriesByEmployeeDay = new Map<string, Map<CalendarDay, WorkLocationEntry>>();
  for (const entry of entries) {
    if (!idSet.has(entry.employeeId)) continue;
    const day = dateToDay(entry.date);
    if (day < fromDay || day > toDay) continue;

    let perEmployee = entriesByEmployeeDay.get(entry.employeeId);
    if (!perEmployee) {
      perEmployee = new Map();
      entriesByEmployeeDay.set(entry.employeeId, perEmployee);
    }
    const existing = perEmployee.get(day);
    // MULTI-ENTRY: several entries of one employee on one day (#70) — the earliest start decides the work location until #70 defines a rule
    if (!existing || entry.startTime.getTime() < existing.startTime.getTime()) {
      perEmployee.set(day, entry);
    }
  }

  // The no-entry fallback, batched for every requested employee at once (ONE query pair).
  const fallbackMap = await salonsForDays(db, tenantId, employeeIds, fromDay, toDay);

  let defaultSalon: { id: string } | null | undefined;
  const salonByEmployeeDay = new Map<string, Map<CalendarDay, string>>();
  const neededSalonIds = new Set<string>();

  for (const employeeId of employeeIds) {
    const perEmployeeFallback = fallbackMap.get(employeeId);
    if (!perEmployeeFallback) continue; // foreign/unknown employeeId — absent from the result

    const perEmployeeEntries = entriesByEmployeeDay.get(employeeId);
    const dayMap = new Map<CalendarDay, string>();

    for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
      const entrySalon = perEmployeeEntries?.get(day)?.salonId;
      let salonId: string;
      if (entrySalon) {
        salonId = entrySalon;
      } else {
        const fallbackSalonId = perEmployeeFallback.get(day) ?? null;
        if (fallbackSalonId) {
          salonId = fallbackSalonId;
        } else {
          if (defaultSalon === undefined) {
            defaultSalon = await findDefaultSalon(db, tenantId);
          }
          if (!defaultSalon) {
            throw new Error(
              `holidaysAtWorkLocation: tenant ${tenantId} has no active salon — every tenant must have one (Phase 64b D-18)`,
            );
          }
          salonId = defaultSalon.id;
        }
      }
      dayMap.set(day, salonId);
      neededSalonIds.add(salonId);
    }
    salonByEmployeeDay.set(employeeId, dayMap);
  }

  if (neededSalonIds.size === 0) return result;

  const salonIdList = [...neededSalonIds];
  const salonRows = await db.salon.findMany({
    where: { tenantId, id: { in: salonIdList } },
    select: { id: true, federalState: true },
  });
  const stateBySalon = new Map(salonRows.map((salon) => [salon.id, STATE_MAP[salon.federalState]]));

  const manualBySalon = await fetchManualHolidaysBySalon(db, tenantId, salonIdList, fromDay, toDay);

  const holidayMapBySalon = new Map<string, Map<CalendarDay, SalonHoliday>>();
  for (const salonId of salonIdList) {
    holidayMapBySalon.set(
      salonId,
      buildSalonHolidayMap(stateBySalon.get(salonId), manualBySalon.get(salonId), fromDay, toDay),
    );
  }

  for (const [employeeId, dayMap] of salonByEmployeeDay) {
    const employeeHolidays = new Map<CalendarDay, string>();
    for (const [day, salonId] of dayMap) {
      const holiday = holidayMapBySalon.get(salonId)?.get(day);
      if (holiday) employeeHolidays.set(day, holiday.name);
    }
    result.set(employeeId, employeeHolidays);
  }

  return result;
}
