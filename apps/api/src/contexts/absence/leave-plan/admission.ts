/**
 * Issue #835 (D-835-22) — who may read a leave plan, decided in a non-route file so no
 * `EmployeeScope` literal ever sits in the route.
 *
 * A plan is read by a caller whose `leave-request:read` reach contains the plan's salon, or by a
 * person whose own Stammsalon is the plan's salon on a day of the plan year (a team member sees
 * the planner of the own team). Presentation of the planner never widens the reach of the
 * calendar: what a reader sees inside the plan is decided by the read itself.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { Prisma } from "@clokr/db";
import {
  findSalon,
  homeSalonsForDays,
  resolveSalonInReach,
  type AccessReach,
} from "../../platform";
import { isHomedInSalonOnAnyDay } from "../salon-leave-attribution";

type Db = Prisma.TransactionClient;

/**
 * True iff the person's Stammsalon is `salonId` on at least one day of `year` (`homeSalonsForDays`,
 * HOME rows only — a deployment never makes someone a member of a plan).
 */
export async function isOwnStammsalonPlan(
  db: Db,
  tenantId: string,
  selfEmployeeId: string | null,
  salonId: string,
  year: number,
): Promise<boolean> {
  if (selfEmployeeId === null) return false;
  const fromDay = `${year}-01-01`;
  const toDay = `${year}-12-31`;
  const homes = await homeSalonsForDays(db, tenantId, [selfEmployeeId], fromDay, toDay);
  return isHomedInSalonOnAnyDay(homes.get(selfEmployeeId), salonId, fromDay, toDay);
}

/** True iff the caller may read the plan of `salonId` / `year` (reach over the salon, or own Stammsalon). */
export async function canReadPlan(
  db: Db,
  input: {
    tenantId: string;
    readReach: AccessReach;
    selfEmployeeId: string | null;
    salonId: string;
    year: number;
  },
): Promise<boolean> {
  const inReach = await resolveSalonInReach(db, input.tenantId, input.readReach, input.salonId);
  if (inReach.ok && inReach.salonId !== null) return true;
  return isOwnStammsalonPlan(db, input.tenantId, input.selfEmployeeId, input.salonId, input.year);
}

/**
 * The plan years of `salonId` the caller may list (`GET /leave/plans`), or `null` when the salon
 * itself is not admitted. A salon that is unknown, foreign, inactive, or neither inside the caller's
 * `leave-request:read` reach nor the caller's own Stammsalon on a day of any asked year is `null` —
 * the route answers its one `SALON_NOT_FOUND` body for all of them (T-100-09). A caller with reach
 * over the salon may list every year; any other caller only the years in which the salon is their
 * own Stammsalon. `years` are the candidate years (the plan years of the salon, or the one asked).
 */
export async function readablePlanYears(
  db: Db,
  input: {
    tenantId: string;
    readReach: AccessReach;
    selfEmployeeId: string | null;
    salonId: string;
    years: readonly number[];
  },
): Promise<Set<number> | null> {
  const salon = await findSalon(db, input.tenantId, input.salonId);
  if (!salon || !salon.isActive) return null;
  const inReach = await resolveSalonInReach(db, input.tenantId, input.readReach, input.salonId);
  if (inReach.ok && inReach.salonId !== null) return new Set(input.years);
  const years = new Set<number>();
  for (const year of input.years) {
    if (await isOwnStammsalonPlan(db, input.tenantId, input.selfEmployeeId, input.salonId, year)) {
      years.add(year);
    }
  }
  return years.size > 0 ? years : null;
}
