/**
 * Issue #835 (D-835-11/25, AC-6) — the entitlement forecast of one person: how many vacation days
 * would remain if the plan were filed as it stands. Nothing is calculated here that the real
 * request path does not calculate:
 *
 *   forecast = remaining days of the year (the vacation-balance facade, else the read-only regular
 *              entitlement) - the person's PENDING days - the wishes priced like filed requests.
 *
 * The wishes are priced by `resolveLeaveDays()` in start order, each with the earlier wishes as
 * `extraSiblings`, so two wishes in one ISO week of a SHIFT_BASED contract cost what the same two
 * requests would cost when filed one after another. A negative result is a warning for the reader,
 * never a refusal. The read heals or creates no entitlement row: `getVacationBalance` is a read
 * (null without a row) and the COMPUTED basis is `resolveRegularVacationDays`, also read-only.
 *
 * Who may see a forecast is decided by the caller (the planner read): the reader's own row or a
 * person inside the reader's `leave-entitlement:read` reach (D-835-04).
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import { getVacationBalance } from "../facade/vacation-balance";
import { getHolidayMap, resolveLeaveDays, resolveRegularVacationDays } from "../leave-days";
import { dayToDate } from "./wish-rules";

export type PlannerForecast = {
  entitlementBasis: "STORED" | "COMPUTED";
  remainingDays: number;
  pendingDays: number;
  wishDays: number;
  forecastDays: number;
  forecastNegative: boolean;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

export async function plannerForecast(
  db: FastifyInstance["prisma"],
  input: {
    tenantId: string;
    employeeId: string;
    year: number;
    /** All active, not-taken-over wishes of the person in the year, any open plan. */
    wishes: ReadonlyArray<{ id: string; startDay: string; endDay: string; halfDay: boolean }>;
    now: Date;
  },
): Promise<PlannerForecast> {
  const { tenantId, employeeId, year } = input;

  const balance = await getVacationBalance(db, employeeId, tenantId, year, input.now);
  const entitlementBasis = balance ? ("STORED" as const) : ("COMPUTED" as const);
  const remainingDays = balance
    ? balance.remainingDays
    : round2(await resolveRegularVacationDays(db, employeeId, tenantId, year));
  const pendingDays = balance ? balance.pendingDays : 0;

  let wishDays = 0;
  if (input.wishes.length > 0) {
    // Holidays of the person's work locations over the year, exactly as `POST /requests` builds them.
    const holidays = new Set(
      (
        await getHolidayMap(
          db,
          tenantId,
          employeeId,
          dayToDate(`${year}-01-01`),
          dayToDate(`${year}-12-31`),
        )
      ).keys(),
    );
    const ordered = [...input.wishes].sort(
      (a, b) => a.startDay.localeCompare(b.startDay) || a.id.localeCompare(b.id),
    );
    const earlier: Array<{ startDate: Date; endDate: Date; halfDay: boolean }> = [];
    for (const wish of ordered) {
      const startDate = dayToDate(wish.startDay);
      const endDate = dayToDate(wish.endDay);
      const priced = await resolveLeaveDays(
        db,
        employeeId,
        tenantId,
        startDate,
        endDate,
        wish.halfDay,
        holidays,
        { mode: "request", leaveTypeCode: "VACATION", extraSiblings: [...earlier] },
      );
      wishDays += priced.days;
      earlier.push({ startDate, endDate, halfDay: wish.halfDay });
    }
  }

  const forecastDays = round2(remainingDays - pendingDays - wishDays);
  return {
    entitlementBasis,
    remainingDays,
    pendingDays,
    wishDays: round2(wishDays),
    forecastDays,
    forecastNegative: forecastDays < 0,
  };
}
