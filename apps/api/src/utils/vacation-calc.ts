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
