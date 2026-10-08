// Issue #80 (D-08/D-11) — the ONE place that decides whether a resolved reach covers the closed
// entries of an employee's day.
//
// A break recorded in the gap between two entries belongs to the DAY, not to one entry (D-03). A
// scoped manager who sees only one of the salons of that day must therefore not be able to write
// to it: he would act on a day whose other half he is not allowed to see. The rule is the same
// "scope over EVERY closed entry of the day" for the day-break routes, the acknowledgement and the
// day check, so it lives here and nowhere else (CLAUDE.md: no reader rebuilds a rule inline).
//
// Per row the decision is `isTimeEntryInScope` (Platform): the entry's own salon, the employee in a
// PERSONS list, or the Stammsalon at the entry's date — Stammsalon and PERSONS semantics included.
// Imports only from the Unterbau (`../platform`).
import type { Prisma } from "@clokr/db";
import { isTimeEntryInScope, type AccessReach } from "../platform";

/** The facts of one closed entry of the day that scope resolution needs. */
export interface DayCoverageRow {
  salonId: string;
  employeeId: string;
  date: Date;
}

/**
 * How much of a day's closed entries the `reach` covers:
 *
 *   - "all"     every row is in scope; a `wholeTenant` reach is always "all", even for a day with no
 *               rows (it can see everything there is)
 *   - "none"    a scoped reach and no row in scope, or a scoped reach and no rows at all
 *   - "partial" some rows are in scope, some are not
 *
 * Callers allow an action on someone else's day only for "all". Fail-closed: a scoped reach never
 * covers a day it cannot see an entry of.
 */
export async function dayCoverage(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
  rows: readonly DayCoverageRow[],
): Promise<"all" | "partial" | "none"> {
  if (reach.kind === "wholeTenant") return "all";
  if (rows.length === 0) return "none";

  let inScope = 0;
  for (const row of rows) {
    if (await isTimeEntryInScope(db, tenantId, reach, row)) inScope++;
  }
  if (inScope === rows.length) return "all";
  return inScope === 0 ? "none" : "partial";
}
