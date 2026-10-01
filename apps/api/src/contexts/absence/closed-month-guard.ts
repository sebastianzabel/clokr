/**
 * Issue #446 (D-07) — the ONE closed-month check for the four leave transitions that must
 * not touch an already-closed (Monatsabschluss) month: create (POST /requests), approve
 * (PENDING -> APPROVED), approve a cancellation (CANCELLATION_REQUESTED -> CANCELLED), and
 * request a cancellation (APPROVED -> CANCELLATION_REQUESTED).
 *
 * Same signal as `/correct` (`isMonthClosed`, the canonical Monatsabschluss signal), but
 * walked over the WHOLE period rather than a correction delta — every leave transition
 * guarded here concerns the request's full date range, not a partial edit.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts`: importing
 * `../working-time-account` from a file reachable through that index would pull this file
 * into the absence<->working-time-account import cycle (`--cycles --check 22`).
 * `api/leave.ts` is its only importer.
 */
import type { FastifyInstance } from "fastify";
import { getTenantTimezone, isMonthClosed, monthRangeUtc } from "../working-time-account";
import { monthsInRange, type AffectedMonth } from "./correction-lock";

/**
 * Every closed month touched by [start, end] (inclusive UTC-day range), ascending. Never
 * short-circuits on the first hit — D-09 requires the 409 message to name EVERY closed
 * month in a spanning range, not just the first one found.
 */
export async function findClosedMonthsInRange(
  prisma: FastifyInstance["prisma"],
  employeeId: string,
  tenantId: string,
  start: Date,
  end: Date,
): Promise<AffectedMonth[]> {
  const tz = await getTenantTimezone(prisma, tenantId);
  const closed: AffectedMonth[] = [];
  for (const { year, month } of monthsInRange(start, end)) {
    const { start: monthStart } = monthRangeUtc(year, month, tz);
    if (await isMonthClosed(prisma, employeeId, tenantId, monthStart)) {
      closed.push({ year, month });
    }
  }
  return closed;
}
