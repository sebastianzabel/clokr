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

/**
 * A person whose login was switched off but who has NO exit date (an old offboarding that never
 * recorded one). Their employment is unbounded, so the month close cannot tell whether a gap day
 * is a forgotten entry or simply after the person left. An anonymised row is never in the
 * population without an exit date, so it cannot be this case.
 */
export function isExitDateMissing(row: {
  exitDate: Date | null;
  user?: { isActive: boolean } | null;
}): boolean {
  return row.exitDate === null && row.user?.isActive === false;
}

export type GapDeferralDecision =
  "CLOSE" | "DEFER_IN_WINDOW" | "DEFER_EXIT_DATE_MISSING" | "DEFER_MANUAL";

/**
 * What the month close does with a month that has gap days - the ONE place the order is stated
 * (the cron and the pre-deploy dry run both call it). In the retro window every month defers;
 * past it, a person without an exit date is NEVER force-closed at 0 h (their gap days are not
 * provably forgotten entries), then the tenant switch decides. Only `CLOSE` writes a snapshot.
 */
export function decideGapMonth(args: {
  gapCount: number;
  pastWindow: boolean;
  closeAllowed: boolean;
  exitDateMissing: boolean;
}): GapDeferralDecision {
  if (args.gapCount === 0) return "CLOSE";
  if (!args.pastWindow) return "DEFER_IN_WINDOW";
  if (args.exitDateMissing) return "DEFER_EXIT_DATE_MISSING";
  if (!args.closeAllowed) return "DEFER_MANUAL";
  return "CLOSE";
}
