/**
 * legacy-shift-based-kernel-pre436.ts
 *
 * Phase 436, D-05 reference fixture — a VERBATIM copy (logic unchanged; renamed to avoid
 * colliding with the real exports) of `weekLeaveDays`, `countShiftBasedLeaveDays`,
 * `leaveDaysPerWeek`, `buildHalfShareForWeek` and the date helpers they need, taken from
 * `apps/api/src/contexts/absence/vacation-calc.ts` at commit a8e4d4b5 (the last commit before
 * Phase 436 touched this file).
 *
 * Purpose: `shift-based-kernel-equivalence-436.test.ts` compares the REAL (Phase-436-refactored)
 * kernel against this frozen copy over a generated matrix, with an empty `usualWorkDays` list, to
 * prove D-05 ("without an Angabe, results are identical to pre-436") over more cases than any
 * hand-written example list could cover.
 *
 * Never edit this file to make a test pass — it exists to disagree with a regression, not to
 * agree with one. Never imported by production code (enforced by this plan's acceptance
 * criteria: `grep -rn "legacy-shift-based-kernel-pre436" apps/api/src --include='*.ts' | grep -v
 * __tests__` must print nothing).
 */

function legacyMondayOfWeekUtc(d: Date): Date {
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

function legacyUtcMidnight(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function legacyAddUtcDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

function legacyToDateStrUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function legacyWeekLeaveDays(
  moSaDaysInFragment: number,
  moSaHolidaysInFragment: number,
  isWhole: boolean,
  contractWorkDaysPerWeek: number,
): number {
  if (isWhole) {
    return Math.max(0, contractWorkDaysPerWeek - moSaHolidaysInFragment);
  }
  return Math.max(
    0,
    Math.min(moSaDaysInFragment, contractWorkDaysPerWeek) - moSaHolidaysInFragment,
  );
}

export function legacyCountShiftBasedLeaveDays(
  start: Date,
  end: Date,
  halfDay: boolean,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
): { days: number; provisional: boolean } {
  if (halfDay) return { days: 0.5, provisional: false };

  const s = legacyUtcMidnight(start);
  const e = legacyUtcMidnight(end);

  let totalDays = 0;

  let weekMonday = legacyMondayOfWeekUtc(s);
  while (weekMonday.getTime() <= e.getTime()) {
    const weekSaturday = legacyAddUtcDays(weekMonday, 5);
    const weekSunday = legacyAddUtcDays(weekMonday, 6);
    const isWhole = weekMonday.getTime() >= s.getTime() && weekSaturday.getTime() <= e.getTime();

    const fragStart = weekMonday.getTime() > s.getTime() ? weekMonday : s;
    const fragEnd = weekSunday.getTime() < e.getTime() ? weekSunday : e;

    let moSaDaysInFragment = 0;
    let moSaHolidaysInFragment = 0;
    for (let d = fragStart; d.getTime() <= fragEnd.getTime(); d = legacyAddUtcDays(d, 1)) {
      if (d.getUTCDay() === 0) continue; // Sunday is never a Werktag (§ 3 Abs. 2 BUrlG)
      moSaDaysInFragment++;
      if (holidays.has(legacyToDateStrUtc(d))) moSaHolidaysInFragment++;
    }

    totalDays += legacyWeekLeaveDays(
      moSaDaysInFragment,
      moSaHolidaysInFragment,
      isWhole,
      contractWorkDaysPerWeek,
    );

    weekMonday = legacyAddUtcDays(weekMonday, 7);
  }

  return { days: totalDays, provisional: false };
}

export type LegacyLeaveWeek = {
  weekMonday: string;
  days: number;
  dayShares: Map<string, number>;
};

export function legacyLeaveDaysPerWeek(
  rows: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
): LegacyLeaveWeek[] {
  if (rows.length === 0) return [];

  let minStart = legacyUtcMidnight(rows[0].startDate);
  let maxEnd = legacyUtcMidnight(rows[0].endDate);
  for (const row of rows) {
    const s = legacyUtcMidnight(row.startDate);
    const e = legacyUtcMidnight(row.endDate);
    if (s.getTime() < minStart.getTime()) minStart = s;
    if (e.getTime() > maxEnd.getTime()) maxEnd = e;
  }

  const result: LegacyLeaveWeek[] = [];

  let weekMonday = legacyMondayOfWeekUtc(minStart);
  const lastMonday = legacyMondayOfWeekUtc(maxEnd);
  while (weekMonday.getTime() <= lastMonday.getTime()) {
    const weekSunday = legacyAddUtcDays(weekMonday, 6);

    const fullDayUnion = new Set<string>();
    for (const row of rows) {
      if (row.halfDay) continue;
      const s = legacyUtcMidnight(row.startDate);
      const e = legacyUtcMidnight(row.endDate);
      const fragStart = weekMonday.getTime() > s.getTime() ? weekMonday : s;
      const fragEnd = weekSunday.getTime() < e.getTime() ? weekSunday : e;
      for (let d = fragStart; d.getTime() <= fragEnd.getTime(); d = legacyAddUtcDays(d, 1)) {
        if (d.getUTCDay() === 0) continue; // Sunday is never a Werktag (§ 3 Abs. 2 BUrlG)
        fullDayUnion.add(legacyToDateStrUtc(d));
      }
    }

    if (fullDayUnion.size === 0) {
      const halfOnly = legacyBuildHalfShareForWeek(rows, weekMonday, weekSunday, fullDayUnion);
      if (halfOnly.size > 0) {
        const days = Array.from(halfOnly.values()).reduce((a, b) => a + b, 0);
        const capped = Math.min(days, contractWorkDaysPerWeek);
        const scale = days > 0 ? capped / days : 0;
        const dayShares = new Map<string, number>();
        for (const [date, share] of halfOnly) dayShares.set(date, share * scale);
        if (capped > 0)
          result.push({ weekMonday: legacyToDateStrUtc(weekMonday), days: capped, dayShares });
      }
      weekMonday = legacyAddUtcDays(weekMonday, 7);
      continue;
    }

    let isWhole = true;
    for (let i = 0; i < 6; i++) {
      if (!fullDayUnion.has(legacyToDateStrUtc(legacyAddUtcDays(weekMonday, i)))) {
        isWhole = false;
        break;
      }
    }

    let moSaHolidaysInFragment = 0;
    for (const date of fullDayUnion) {
      if (holidays.has(date)) moSaHolidaysInFragment++;
    }
    const moSaDaysInFragment = fullDayUnion.size;

    const fullDayTotal = legacyWeekLeaveDays(
      moSaDaysInFragment,
      moSaHolidaysInFragment,
      isWhole,
      contractWorkDaysPerWeek,
    );

    const nonHolidayDates = Array.from(fullDayUnion).filter((d) => !holidays.has(d));
    const dayShares = new Map<string, number>();
    if (nonHolidayDates.length > 0) {
      const perDate = fullDayTotal / nonHolidayDates.length;
      for (const date of nonHolidayDates) dayShares.set(date, perDate);
    }

    const halfShare = legacyBuildHalfShareForWeek(rows, weekMonday, weekSunday, fullDayUnion);
    const halfTotal = Array.from(halfShare.values()).reduce((a, b) => a + b, 0);

    let days = fullDayTotal;
    if (halfTotal > 0) {
      const room = Math.max(0, contractWorkDaysPerWeek - fullDayTotal);
      const cappedHalfTotal = Math.min(halfTotal, room);
      const scale = cappedHalfTotal > 0 ? cappedHalfTotal / halfTotal : 0;
      for (const [date, share] of halfShare) {
        const scaled = share * scale;
        if (scaled > 0) dayShares.set(date, (dayShares.get(date) ?? 0) + scaled);
      }
      days = Math.min(fullDayTotal + halfTotal, contractWorkDaysPerWeek);
    }

    if (days > 0) {
      result.push({ weekMonday: legacyToDateStrUtc(weekMonday), days, dayShares });
    }

    weekMonday = legacyAddUtcDays(weekMonday, 7);
  }

  return result;
}

function legacyBuildHalfShareForWeek(
  rows: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>,
  weekMonday: Date,
  weekSunday: Date,
  fullDayUnion: Set<string>,
): Map<string, number> {
  const halfShare = new Map<string, number>();
  for (const row of rows) {
    if (!row.halfDay) continue;
    const s = legacyUtcMidnight(row.startDate);
    if (s.getTime() < weekMonday.getTime() || s.getTime() > weekSunday.getTime()) continue;
    const dateStr = legacyToDateStrUtc(s);
    if (fullDayUnion.has(dateStr)) continue;
    halfShare.set(dateStr, 0.5);
  }
  return halfShare;
}
