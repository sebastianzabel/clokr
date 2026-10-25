// Issue #668 — the ONE place the population of the month close is spelled.
//
// The auto-close cron (`plugins/auto-close-month.ts`) and the deferred close
// (`deferred-month-close.ts`) select persons by EMPLOYMENT, never by login state (owner decision
// 19.10.2026, follow-up of #613). `user.isActive` is a login state (deactivation, lockout, DSGVO
// anonymisation) and says nothing about whether a payroll month has to be closed.
//
// Why the employment CORE and not `reportPopulationWhere` (which drops anonymised persons): the
// Lohnkonto of a month of employment stays complete (§ 41 EStG, same reasoning as DATEV, see
// `employedInPeriodWhere`). A person anonymised AFTER leaving still has open months up to the exit
// day that must be closed. One guard remains: an anonymised row WITHOUT an exit date (a legacy row
// from before #614, still listed by scripts/audit-614-anonymized-employment.ts) has an unbounded
// employment and would be snapshotted every month forever - it is not closed, exactly as before.

import type { Prisma } from "@clokr/db";
import {
  NOT_ANONYMIZED_EMPLOYEE_WHERE,
  employedInPeriodWhere,
  isAnonymizedEmployee,
  isEmployedInPeriod,
} from "../platform";

/** Prisma filter: employed during [start, end] (instants), anonymised only with a bounded employment. */
export function monthClosePopulationWhere(start: Date, end: Date): Prisma.EmployeeWhereInput {
  return {
    AND: [
      employedInPeriodWhere(start, end),
      { OR: [NOT_ANONYMIZED_EMPLOYEE_WHERE, { exitDate: { not: null } }] },
    ],
  };
}

/** In-memory twin of {@link monthClosePopulationWhere} for rows already loaded. */
export function isInMonthClosePopulation(
  row: { firstName: string; lastName: string; hireDate: Date; exitDate: Date | null },
  start: Date,
  end: Date,
): boolean {
  if (isAnonymizedEmployee(row) && row.exitDate === null) return false;
  return isEmployedInPeriod(row, start, end);
}
