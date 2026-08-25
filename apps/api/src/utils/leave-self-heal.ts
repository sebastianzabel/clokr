/**
 * Self-heals LeaveEntitlement.usedDays drift by recomputing from
 * Σ approved LeaveRequest.days for each entitlement row.
 *
 * Background: Bulk-import scripts and historical migrations have produced
 * rows where LeaveEntitlement.usedDays diverged from the actual sum of
 * approved LeaveRequest.days. GET /entitlements/:employeeId (leave page)
 * has self-healed this on every load since v1.4; GET /reports/leave-overview
 * did not, which caused the report to display stale wrong numbers
 * (a-tenant tenant, 2026-05-27 incident).
 *
 * This helper is now the single source of truth for the heal logic.
 *
 * Invariants:
 *   - Queries against LeaveRequest keep `deletedAt: null` AND `status: "APPROVED"`
 *     (audit-proof per CLAUDE.md).
 *   - Vacation rows aggregate across the canonical leaveType plus any
 *     LEGACY_ALIASES.VACATION (e.g. "Jahresurlaub"); non-vacation rows
 *     aggregate only their own leaveTypeId.
 *   - Idempotent: rows already in sync are NOT updated.
 *   - Mutates rows in place so callers can render the healed value directly.
 *   - § 9 BUrlG credits (Section9Credit, status CONFIRMED) are subtracted from the raw sum;
 *     AU_PENDING and REJECTED credits are ignored.
 *
 * Out of scope (preserve parity with the pre-refactor implementation):
 *   - app.audit() for the heal mutation (pre-existing gap, separate ticket).
 *   - Cross-year leave (the year-bounds filter matches the existing code).
 *   - Calling recalculateCarryOver(year + 1) — the existing self-heal does
 *     not do this and we keep parity.
 */
import type { FastifyInstance } from "fastify";
import { sumConfirmedSection9DaysByRequest } from "./section9-credit-days";

/**
 * Minimal row shape the helper needs. Matches against either of:
 *   - prisma.leaveEntitlement.findMany({ include: { leaveType: true } })
 *   - prisma.leaveEntitlement.findMany({ include: { leaveType: true, employee: {...} } })
 *
 * `usedDays` is intentionally typed as `unknown` to accept raw Prisma return
 * values (Decimal | number); the helper coerces with Number() before compare.
 */
export type LeaveEntitlementWithType = {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  year: number;
  usedDays: unknown;
  leaveType: { id: string; name: string };
};

export type VacationTypeMeta = {
  vacationNames: string[];
  allVacTypeIds: string[];
  /**
   * Phase 104 review (IN-03): carried so selfHealUsedDays() can pass a tenant scope into
   * sumConfirmedSection9DaysByRequest() without changing every call site's signature.
   */
  tenantId: string;
};

/**
 * Resolve the set of LeaveType IDs that all represent "Urlaub" for a tenant,
 * including legacy seed names that may still exist in older tenants.
 *
 * This MUST be called once per request (NOT per row) — calling it inside the
 * row loop would issue O(rows) queries against LeaveType for no reason.
 */
export async function loadVacationTypeMeta(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
): Promise<VacationTypeMeta> {
  // Canonical + legacy vacation names. Kept inline (not imported from
  // routes/leave.ts) so this utility has no upward dependency on a route file.
  const vacationNames = ["Urlaub", "Jahresurlaub", "Urlaub (Jahresurlaub)"];
  const rows = await prisma.leaveType.findMany({
    where: { tenantId, name: { in: vacationNames } },
    select: { id: true },
  });
  return { vacationNames, allVacTypeIds: rows.map((r) => r.id), tenantId };
}

/**
 * Walk `rows` and update LeaveEntitlement.usedDays where it diverges from
 * Σ approved LeaveRequest.days for the same employee + year + (vacation-aware) leaveTypeId set.
 *
 * Mutates each `row.usedDays` in place when a heal occurs.
 */
export async function selfHealUsedDays(
  prisma: FastifyInstance["prisma"],
  rows: LeaveEntitlementWithType[],
  ctx: VacationTypeMeta,
): Promise<void> {
  const { vacationNames, allVacTypeIds, tenantId } = ctx;

  for (const row of rows) {
    const isVacation = vacationNames.includes(row.leaveType.name);
    const typeIds = isVacation ? allVacTypeIds : [row.leaveTypeId];
    const yearStart = new Date(`${row.year}-01-01T00:00:00Z`);
    const yearEnd = new Date(`${row.year}-12-31T23:59:59Z`);

    const approved = await prisma.leaveRequest.findMany({
      where: {
        employeeId: row.employeeId,
        deletedAt: null,
        leaveTypeId: { in: typeIds },
        status: "APPROVED",
        startDate: { gte: yearStart },
        endDate: { lte: yearEnd },
      },
    });
    // Phase 104 (Pitfall 2): subtract confirmed § 9 BUrlG credits. D-05 never touches
    // LeaveRequest.days, so the raw sum below is the PRE-credit figure — writing it back
    // would silently erase the credit on the next page load (leave.ts:2103) or report
    // load (reports.ts:708). Attaching the subtraction to the SAME request set that was
    // just summed keeps the existing year-bounds semantics intact (including the
    // documented cross-year out-of-scope note above) — no separate year attribution.
    const rawUsed = approved.reduce((s, r) => s + Number(r.days), 0);
    const section9Credited = await sumConfirmedSection9DaysByRequest(
      prisma,
      approved.map((r) => r.id),
      tenantId,
    );
    const actualUsed = Math.max(0, rawUsed - section9Credited);

    if (Number(row.usedDays) !== actualUsed) {
      await prisma.leaveEntitlement.update({
        where: { id: row.id },
        data: { usedDays: actualUsed },
      });
      (row as unknown as { usedDays: number }).usedDays = actualUsed;
    }
  }
}
