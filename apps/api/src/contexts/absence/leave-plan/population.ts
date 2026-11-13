/**
 * Issue #835 (D-835-05, D-835-22) — the population of a salon's leave plan: who belongs to it.
 *
 * A person belongs to the plan of salon S and year Y when their Stammsalon (HOME assignment rows
 * only, never an Einsatzsalon) is S on at least one day of Y AND they are employed at some point
 * of Y and were never anonymised (`reportPopulationWhere`, Issue #613, with INSTANT bounds from the
 * tenant-local first and last day of the year). The membership is ONE rule: the facade answers the
 * ids, the Unterbau population rule filters them; nothing here counts leave and no figure leaves
 * this file (the planner read, the wish rules and the notification all start from this list).
 *
 * `homeByPerson` carries the Stammsalon per calendar day of the year for every listed person, from
 * `homeSalonsForDays`, so a caller can tell a person who is only homed in S from July from one who
 * is homed there all year.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import {
  employeeIdsHomedInSalonDuring,
  homeSalonsForDays,
  reportPopulationWhere,
} from "../../platform";
import { dayRangeUtc, getTenantTimezone } from "../../working-time-account";

export type PlanPerson = {
  id: string;
  firstName: string;
  lastName: string;
  userId: string | null;
  hireDate: Date;
  exitDate: Date | null;
};

export type PlanPopulation = {
  persons: PlanPerson[];
  /** Per listed person: the Stammsalon id (or null) of every calendar day of the plan year. */
  homeByPerson: Map<string, Map<string, string | null>>;
};

/** The persons of the plan of `salonId` / `year`, ordered last name, first name, id. */
export async function planPopulation(
  db: FastifyInstance["prisma"],
  tenantId: string,
  salonId: string,
  year: number,
): Promise<PlanPopulation> {
  const firstDay = `${year}-01-01`;
  const lastDay = `${year}-12-31`;

  const ids = await employeeIdsHomedInSalonDuring(db, tenantId, salonId, firstDay, lastDay);
  if (ids.length === 0) return { persons: [], homeByPerson: new Map() };

  const timezone = await getTenantTimezone(db, tenantId);
  const start = dayRangeUtc(firstDay, timezone).start;
  const end = dayRangeUtc(lastDay, timezone).end;

  const persons = await db.employee.findMany({
    where: {
      tenantId,
      id: { in: ids },
      AND: [reportPopulationWhere(start, end)],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      userId: true,
      hireDate: true,
      exitDate: true,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
  });

  const homeByPerson = await homeSalonsForDays(
    db,
    tenantId,
    persons.map((p) => p.id),
    firstDay,
    lastDay,
  );
  return { persons, homeByPerson };
}
