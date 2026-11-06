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

/**
 * True iff the caller's `leave-plan:manage` reach covers the person on at least one day of
 * `[fromDay, toDay]` (D-835-04): a whole-tenant reach always, a reach naming the person always,
 * otherwise the person's Stammsalon of some day of the range lies in the reach's salons (the
 * any-day form of `isStammsalonScopeMatch`). An empty reach covers nobody. The caller has resolved
 * the person inside the tenant; a miss and an out-of-reach person answer the same 404 body.
 */
export async function manageCoversPersonOnDays(
  db: Db,
  tenantId: string,
  manageReach: AccessReach,
  employeeId: string,
  fromDay: string,
  toDay: string,
): Promise<boolean> {
  if (manageReach.kind === "wholeTenant") return true;
  if (manageReach.employeeIds.includes(employeeId)) return true;
  if (manageReach.salonIds.length === 0) return false;
  const homes = await homeSalonsForDays(db, tenantId, [employeeId], fromDay, toDay);
  const dayMap = homes.get(employeeId);
  if (!dayMap) return false;
  for (const [day, homeSalon] of dayMap) {
    if (
      day >= fromDay &&
      day <= toDay &&
      homeSalon !== null &&
      manageReach.salonIds.includes(homeSalon)
    ) {
      return true;
    }
  }
  return false;
}
