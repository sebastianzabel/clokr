// Issue #613 — the ONE place the population of a period report is spelled.
//
// Imports only the Prisma type and the anonymisation leaf, so `contexts/platform/index.ts` can
// re-export it without pulling any business context into the Unterbau (ADR 0002).

import type { Prisma } from "@clokr/db";
import { NOT_ANONYMIZED_EMPLOYEE_WHERE } from "./employee-anonymization-filter";

/**
 * Issue #256 (Befund 2), lifted here by Issue #613: who belongs in a report for [start, end]?
 *
 * The answer is "whoever was employed at some point DURING that period" — never
 * "whoever is employed today". The previous predicate (`exitDate: null` plus
 * `user.isActive`) answered the second question, so a correction run for July, made
 * after a September exit, silently dropped that person and every one of their hours
 * from the file. Nothing in the file said so.
 *
 * Both date bounds are INCLUSIVE:
 *   - `hireDate` is the first working day, so `hireDate <= end` means at least one day
 *     of the period falls inside the employment.
 *   - `exitDate` is the last working day (close-employee-month.ts, D-03), so
 *     `exitDate >= start` means the employment still reached into the period.
 *     `exitDate: null` = still employed, which always overlaps.
 *
 * `user.isActive` is deliberately NOT part of this predicate. It is a LOGIN state —
 * flipped by deactivation, by lockout and by DSGVO anonymisation — and says nothing
 * about whether a person was employed in the period. The measured case was an
 * employee on Elternzeit whose login had been switched off: 31 days of Elternzeit that
 * the Lohnbüro must see, withheld because they could not sign in.
 *
 * Both bounds are INSTANTS (`Employee.hireDate` / `exitDate` are `@db.Timestamptz`): pass
 * `monthRangeUtc` / `weekRangeUtc` / `dayRangeUtc` instants, never `monthDateRange` dates
 * (CLAUDE.md, Issue #493).
 *
 * This is the employment core. DATEV reads it alone (§ 41 EStG: the Lohnkonto of a month of
 * employment stays complete); every report, status and overview reads
 * {@link reportPopulationWhere}.
 */
export function employedInPeriodWhere(start: Date, end: Date) {
  return {
    hireDate: { lte: end },
    OR: [{ exitDate: null }, { exitDate: { gte: start } }],
  };
}

/**
 * Issue #613 (owner decision 16.10.2026): the population of every period report, status and
 * overview — employed in the period AND never anonymised. `user.isActive` never decides.
 *
 * The sentinel clause stays while anonymised rows without an exit date can exist (#614 sets the
 * exit date from its release on; existing rows are only listed, not backfilled). DATEV reads the
 * core alone ({@link employedInPeriodWhere}, § 41 EStG).
 *
 * Composition: the result is a single-key `AND` object. Place it as ONE element of the caller's
 * own `AND` array, or spread it only into a `where` that has no `AND` key.
 */
export function reportPopulationWhere(start: Date, end: Date): Prisma.EmployeeWhereInput {
  return { AND: [employedInPeriodWhere(start, end), NOT_ANONYMIZED_EMPLOYEE_WHERE] };
}

/**
 * In-memory twin of {@link employedInPeriodWhere} for callers that already hold the rows. Same
 * inclusive bounds, same instants.
 */
export function isEmployedInPeriod(
  row: { hireDate: Date; exitDate: Date | null },
  start: Date,
  end: Date,
): boolean {
  if (row.hireDate.getTime() > end.getTime()) return false;
  return row.exitDate === null || row.exitDate.getTime() >= start.getTime();
}
