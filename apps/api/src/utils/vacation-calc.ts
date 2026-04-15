/**
 * Pro-rata vacation calculation for part-time employees.
 * Formula (BUrlG): (employee work days/week ÷ full-time days/week) × base vacation days
 * Result rounded to nearest 0.5 (German standard).
 */

export interface ScheduleForCalc {
  mondayHours: number;
  tuesdayHours: number;
  wednesdayHours: number;
  thursdayHours: number;
  fridayHours: number;
  saturdayHours: number;
  sundayHours: number;
}

/** Count how many days per week an employee actually works (hours > 0). */
export function countWorkDaysPerWeek(schedule: ScheduleForCalc): number {
  const days = [
    schedule.mondayHours,
    schedule.tuesdayHours,
    schedule.wednesdayHours,
    schedule.thursdayHours,
    schedule.fridayHours,
    schedule.saturdayHours,
    schedule.sundayHours,
  ];
  return days.filter((h) => Number(h) > 0).length;
}

/**
 * Calculate pro-rata vacation days for a part-time employee.
 * @param schedule - Employee's work schedule
 * @param fullTimeWorkDays - Reference full-time work days per week (typically 5)
 * @param baseVacationDays - Full-time vacation entitlement (e.g. 30)
 * @returns Vacation days rounded to nearest 0.5
 */
export function calculatePartTimeVacation(
  schedule: ScheduleForCalc,
  fullTimeWorkDays: number,
  baseVacationDays: number,
): number {
  const employeeWorkDays = countWorkDaysPerWeek(schedule);

  if (employeeWorkDays === 0 || fullTimeWorkDays === 0) return 0;
  if (employeeWorkDays >= fullTimeWorkDays) return baseVacationDays;

  const raw = (employeeWorkDays / fullTimeWorkDays) * baseVacationDays;
  // Round to nearest 0.5 (German standard: always round UP to nearest 0.5)
  return Math.ceil(raw * 2) / 2;
}

/**
 * Calculate statutory minimum vacation days per § 3 BUrlG.
 * Formula: Arbeitstage/Woche × 4
 * (24 Werktage based on 6-day week, pro-rata for fewer days)
 */
export function calculateStatutoryMinimum(workDaysPerWeek: number): number {
  return workDaysPerWeek * 4;
}

/**
 * Calculate how many work days fall in each year for a cross-year date range.
 * Only counts Mon-Fri (or configured work days) and excludes holidays.
 */
export function splitDaysAcrossYears(
  startDate: Date,
  endDate: Date,
  halfDay: boolean,
  holidays: Set<string>,
): { year1Days: number; year2Days: number; year1: number; year2: number } {
  const year1 = startDate.getFullYear();
  const year2 = endDate.getFullYear();

  if (year1 === year2) {
    // No split needed
    return {
      year1Days: countWorkDaysInRange(startDate, endDate, halfDay, holidays),
      year2Days: 0,
      year1,
      year2,
    };
  }

  // Year boundary: Dec 31 → Jan 1
  const year1End = new Date(year1, 11, 31); // Dec 31
  const year2Start = new Date(year2, 0, 1); // Jan 1

  const year1Days = countWorkDaysInRange(startDate, year1End, false, holidays);
  const year2Days = countWorkDaysInRange(year2Start, endDate, false, holidays);

  // If halfDay: apply to the shorter portion
  if (halfDay) {
    if (year1Days <= year2Days) {
      return { year1Days: Math.max(0, year1Days - 0.5), year2Days, year1, year2 };
    } else {
      return { year1Days, year2Days: Math.max(0, year2Days - 0.5), year1, year2 };
    }
  }

  return { year1Days, year2Days, year1, year2 };
}

/**
 * Calculate pro-rata vacation entitlement for an employee leaving mid-year.
 * Formula (BUrlG § 5 Abs. 2): baseDays × (volleBeschäftigungsmonate / 12), rounded UP to nearest 0.5.
 *
 * "Volle Beschäftigungsmonate": a month counts as full ONLY if the exitDate is on or after
 * the LAST DAY of that month. E.g., Jun 30 → 6 full months; Jun 29 → 5.
 *
 * @param baseDays - Full-year vacation entitlement (may already be part-time adjusted)
 * @param year - The calendar year to calculate for
 * @param exitDate - The employee's last working day
 * @returns Pro-rata entitlement rounded UP to nearest 0.5; or baseDays if exitDate is in future year
 */
export function calculateProRataVacation(baseDays: number, year: number, exitDate: Date): number {
  if (!Number.isFinite(baseDays) || baseDays <= 0) return 0;

  const exitYear = exitDate.getFullYear();

  // Employee leaves after this year → full entitlement for this year
  if (exitYear > year) return baseDays;

  // Employee already left before this year → no entitlement
  if (exitYear < year) return 0;

  // § 5 Abs. 2 BUrlG: Beschäftigung in der zweiten Jahreshälfte → voller Urlaubsanspruch
  if (exitDate.getMonth() >= 6) return baseDays;

  // Count volle Beschäftigungsmonate: month is full only if exitDate >= last day of that month
  let monthsWorked = 0;
  for (let month = 0; month < 12; month++) {
    // Last day of the month (day 0 of next month)
    const lastDayOfMonth = new Date(year, month + 1, 0);
    if (exitDate >= lastDayOfMonth) {
      monthsWorked++;
    }
  }
  monthsWorked = Math.min(monthsWorked, 12);

  const raw = (baseDays * monthsWorked) / 12;
  // Round UP to nearest 0.5
  return Math.ceil(raw * 2) / 2;
}

/** Count work days (Mon-Fri, excluding holidays) in a date range. */
function countWorkDaysInRange(
  start: Date,
  end: Date,
  halfDay: boolean,
  holidays: Set<string>,
): number {
  let count = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  while (current <= endDate) {
    const dow = current.getDay();
    const dateStr = current.toISOString().split("T")[0];
    if (dow !== 0 && dow !== 6 && !holidays.has(dateStr)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return halfDay ? Math.max(0, count - 0.5) : count;
}
