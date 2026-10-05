/**
 * legacy-shift-based-kernel-pre481.ts
 *
 * Issue #481 (R3) reference fixture — a VERBATIM copy (logic unchanged; renamed with a `legacy`
 * prefix to avoid colliding with the real exports) of `weekLeaveDays`, `halfDayCounts`,
 * `countShiftBasedLeaveDays`, `leaveDaysPerWeek`, `marginalShiftBasedLeaveDays`,
 * `buildHalfShareForWeek`, the `LeaveWeek` type and the private date helpers they need, taken from
 * `apps/api/src/contexts/absence/vacation-calc.ts` at commit 973553f0 (release 1.14.0, the last
 * commit before Phase 481 touched this file) with `git show` — never from the edited file.
 * Source declaration lines: 301, 310, 316, 325, 335, 419, 446, 450, 1055, 1085, 1236, 1308. Doc comments were dropped; code is byte-identical apart
 * from the renames and the added `export` keywords.
 *
 * Purpose: `shift-based-kernel-equivalence-481.test.ts` compares the REAL (Phase-481,
 * segment-aware) kernel against this frozen copy over a generated matrix to prove R3: for a
 * single-contract employee (and for contract rows that change neither the count nor the Angabe,
 * PD-01) every price is identical to pre-481.
 *
 * Never edit this file to make a test pass — it exists to disagree with a regression, not to
 * agree with one. Never imported by production code (`grep -rn "legacy-shift-based-kernel-pre481"
 * apps/api/src --include='*.ts' | grep -v __tests__` must print nothing).
 */

export function legacyMondayOfWeekUtc(d: Date): Date {
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

export function legacyUtcMidnight(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

export function legacyAddUtcDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

export function legacyToDateStrUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function legacyDowOfDateStr(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
}

export function legacyWeekLeaveDays(
  requestedDates: string[],
  isWhole: boolean,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
  usualWorkDays: readonly number[] = [],
): { days: number; countedDates: string[] } {
  if (isWhole) {
    const countedDates = requestedDates.filter((d) => legacyDowOfDateStr(d) !== 0);
    const holidayCount = countedDates.filter((d) => holidays.has(d)).length;
    return { days: Math.max(0, contractWorkDaysPerWeek - holidayCount), countedDates };
  }

  const countedDates =
    usualWorkDays.length === 0
      ? requestedDates.filter((d) => legacyDowOfDateStr(d) !== 0)
      : requestedDates.filter((d) => usualWorkDays.includes(legacyDowOfDateStr(d)));
  const holidayCount = countedDates.filter((d) => holidays.has(d)).length;
  const days = Math.max(0, Math.min(countedDates.length, contractWorkDaysPerWeek) - holidayCount);
  return { days, countedDates };
}

export function legacyHalfDayCounts(dow: number, usualWorkDays: readonly number[]): boolean {
  return usualWorkDays.length === 0 || usualWorkDays.includes(dow);
}

export function legacyCountShiftBasedLeaveDays(
  start: Date,
  end: Date,
  halfDay: boolean,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
  usualWorkDays: readonly number[] = [],
): { days: number; provisional: boolean } {
  if (halfDay) {
    const counts = legacyHalfDayCounts(legacyUtcMidnight(start).getUTCDay(), usualWorkDays);
    return { days: counts ? 0.5 : 0, provisional: false };
  }

  const s = legacyUtcMidnight(start);
  const e = legacyUtcMidnight(end);

  let totalDays = 0;

  let weekMonday = legacyMondayOfWeekUtc(s);
  while (weekMonday.getTime() <= e.getTime()) {
    const weekSaturday = legacyAddUtcDays(weekMonday, 5);
    const weekSunday = legacyAddUtcDays(weekMonday, 6);
    // D-07: "whole" is decided on the Mo-Sat span only — Sunday is not a Werktag, so a Mo-Sa
    // request already covers the whole working week.
    const isWhole = weekMonday.getTime() >= s.getTime() && weekSaturday.getTime() <= e.getTime();

    const fragStart = weekMonday.getTime() > s.getTime() ? weekMonday : s;
    const fragEnd = weekSunday.getTime() < e.getTime() ? weekSunday : e;

    const requestedDates: string[] = [];
    for (let d = fragStart; d.getTime() <= fragEnd.getTime(); d = legacyAddUtcDays(d, 1)) {
      requestedDates.push(legacyToDateStrUtc(d));
    }

    totalDays += legacyWeekLeaveDays(
      requestedDates,
      isWhole,
      contractWorkDaysPerWeek,
      holidays,
      usualWorkDays,
    ).days;

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
  usualWorkDays: readonly number[] = [],
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

    // Union of full-day dates this week across ALL full-day rows (halfDay falsy). Sunday is
    // included in the union only when `usualWorkDays` names it a usual day (Phase 436, D-03) —
    // with an empty list this stays the pre-436 unconditional Sunday exclusion (§ 3 Abs. 2
    // BUrlG). The WHOLE-week test below only ever looks at the six Mo-Sat dates, so this change
    // cannot affect whole-week detection either way.
    const fullDayUnion = new Set<string>();
    for (const row of rows) {
      if (row.halfDay) continue;
      const s = legacyUtcMidnight(row.startDate);
      const e = legacyUtcMidnight(row.endDate);
      const fragStart = weekMonday.getTime() > s.getTime() ? weekMonday : s;
      const fragEnd = weekSunday.getTime() < e.getTime() ? weekSunday : e;
      for (let d = fragStart; d.getTime() <= fragEnd.getTime(); d = legacyAddUtcDays(d, 1)) {
        if (d.getUTCDay() === 0 && !usualWorkDays.includes(0)) continue;
        fullDayUnion.add(legacyToDateStrUtc(d));
      }
    }

    if (fullDayUnion.size === 0) {
      // No full-day leave touches this week — check for half-day-only contribution below before
      // moving on (a week can be half-day-only).
      const halfOnly = legacyBuildHalfShareForWeek(
        rows,
        weekMonday,
        weekSunday,
        fullDayUnion,
        usualWorkDays,
      );
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

    // Whole-ness generalises to the union: a week is WHOLE when all six Mo-Sat dates are members
    // of fullDayUnion (equivalent to legacyCountShiftBasedLeaveDays's single-row test when there is
    // exactly one row; correctly extends it to several adjoining rows covering a whole week).
    let isWhole = true;
    for (let i = 0; i < 6; i++) {
      if (!fullDayUnion.has(legacyToDateStrUtc(legacyAddUtcDays(weekMonday, i)))) {
        isWhole = false;
        break;
      }
    }

    // Phase 436 (D-03, plan 03): the Angabe is threaded into the same kernel — with an empty
    // list legacyWeekLeaveDays()'s fragment branch behaves byte-identically to the pre-436 kernel.
    const { days: fullDayTotal, countedDates } = legacyWeekLeaveDays(
      Array.from(fullDayUnion),
      isWhole,
      contractWorkDaysPerWeek,
      holidays,
      usualWorkDays,
    );

    // Distribute the full-day total UNIFORMLY over the non-holiday counted dates — holiday dates
    // get share 0.
    const nonHolidayDates = countedDates.filter((d) => !holidays.has(d));
    const dayShares = new Map<string, number>();
    if (nonHolidayDates.length > 0) {
      const perDate = fullDayTotal / nonHolidayDates.length;
      for (const date of nonHolidayDates) dayShares.set(date, perDate);
    }

    // Half-day contribution: +0.5 per distinct date (a full-day row on the same date always
    // wins — OPEN-01, so legacyBuildHalfShareForWeek skips dates already in fullDayUnion).
    const halfShare = legacyBuildHalfShareForWeek(
      rows,
      weekMonday,
      weekSunday,
      fullDayUnion,
      usualWorkDays,
    );
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

export function legacyMarginalShiftBasedLeaveDays(
  request: { startDate: Date; endDate: Date; halfDay: boolean },
  others: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>,
  contractWorkDaysPerWeek: number,
  holidays: Set<string>,
  usualWorkDays: readonly number[],
): number {
  if (others.length === 0) {
    return legacyCountShiftBasedLeaveDays(
      request.startDate,
      request.endDate,
      request.halfDay,
      contractWorkDaysPerWeek,
      holidays,
      usualWorkDays,
    ).days;
  }

  const sumDays = (weeks: LegacyLeaveWeek[]): number => weeks.reduce((acc, w) => acc + w.days, 0);

  const withRequest = sumDays(
    legacyLeaveDaysPerWeek([...others, request], contractWorkDaysPerWeek, holidays, usualWorkDays),
  );
  const withoutRequest = sumDays(
    legacyLeaveDaysPerWeek(others, contractWorkDaysPerWeek, holidays, usualWorkDays),
  );

  return Math.max(0, withRequest - withoutRequest);
}

export function legacyBuildHalfShareForWeek(
  rows: Array<{ startDate: Date; endDate: Date; halfDay?: boolean }>,
  weekMonday: Date,
  weekSunday: Date,
  fullDayUnion: Set<string>,
  usualWorkDays: readonly number[] = [],
): Map<string, number> {
  const halfShare = new Map<string, number>();
  for (const row of rows) {
    if (!row.halfDay) continue;
    const s = legacyUtcMidnight(row.startDate);
    if (s.getTime() < weekMonday.getTime() || s.getTime() > weekSunday.getTime()) continue;
    if (!legacyHalfDayCounts(s.getUTCDay(), usualWorkDays)) continue; // Phase 436 (D-03, Task 2)
    const dateStr = legacyToDateStrUtc(s);
    if (fullDayUnion.has(dateStr)) continue;
    halfShare.set(dateStr, 0.5);
  }
  return halfShare;
}
