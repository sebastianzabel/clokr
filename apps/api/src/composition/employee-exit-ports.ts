/**
 * Issue #615 (D-15) — composition seam of the employee deactivation routes.
 *
 * `PATCH /api/v1/employees/:id/deactivate` lives in the Unterbau, which must not import a business
 * context (ADR 0002, Entscheidung 9). The one answer it needs from Arbeitszeitkonto - whether a
 * month of the person is already closed - is handed in through this port by the composition root.
 * It owns no model and carries no rule: it only maps the public exports of the context onto the
 * shape the route declares. The refusal itself (409 `MONTH_LOCKED`) is decided in the route.
 *
 * `liveSaldo` (D-10, the deactivate preview) hands over the live account saldo of
 * `GET /overtime/:employeeId`; whether the caller may see it is decided in the route.
 */
import type { Prisma } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import {
  computeOvertimeBalanceBreakdown,
  getClosedMonthsInRange,
  monthRangeUtc,
} from "../contexts/working-time-account";

/** Converted month start (the key shape the closed-month facade expects) of a `YYYY-MM-DD` day. */
function monthStartOfDay(day: string, tz: string): Date {
  const [year, month] = day.split("-").map(Number);
  return monthRangeUtc(year, month, tz).start;
}

export const employeeExitPorts = {
  /**
   * Is any month from the month of `fromDay` up to the month of `toDay` (both tenant-local calendar
   * days, `YYYY-MM-DD`) closed for the person? The closed-month rule itself (#595/#664) stays in
   * the Arbeitszeitkonto facade.
   */
  async closedMonthInRange(
    db: Prisma.TransactionClient,
    employeeId: string,
    tenantId: string,
    fromDay: string,
    toDay: string,
    tz: string,
  ): Promise<boolean> {
    const closed = await getClosedMonthsInRange(
      db,
      [employeeId],
      tenantId,
      monthStartOfDay(fromDay, tz),
      monthStartOfDay(toDay, tz),
    );
    return closed.size > 0;
  },

  /**
   * The live saldo of the person through tenant-local yesterday - the figure `GET /overtime/:employeeId`
   * returns as `balanceHours`, not the stored balance. `null` for a person the account keeps no saldo
   * for (§ 18 ArbZG exempt). Throws when the computation fails; the caller decides what to show.
   */
  async liveSaldo(
    app: FastifyInstance,
    employeeId: string,
  ): Promise<{ totalHours: number } | null> {
    const breakdown = await computeOvertimeBalanceBreakdown(app, employeeId);
    return breakdown === null ? null : { totalHours: breakdown.totalHours };
  },
};
