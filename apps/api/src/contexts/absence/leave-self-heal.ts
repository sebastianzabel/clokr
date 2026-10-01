/**
 * Self-heals LeaveEntitlement.usedDays drift by recomputing from the employee's own
 * (vacation-aware) requests for the entitlement row's year.
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
 *   - Queries against LeaveRequest keep `deletedAt: null` (audit-proof per CLAUDE.md).
 *   - Phase 97 (T2, D-12): a row is "the" vacation entitlement when its LeaveType has
 *     `code === "VACATION"` — identity is the code, never the display name. Because
 *     `@@unique([tenantId, code])` allows at most one VACATION-coded row per tenant, this is
 *     always a single leaveTypeId, not a set; a codeless legacy row (pre-backfill, or a
 *     genuine naming conflict the backfill/sweep script could not resolve) is never absorbed —
 *     it must be swept/backfilled on its own before its requests are counted anywhere. Every
 *     other row aggregates only its own leaveTypeId, exactly as before.
 *   - Idempotent: rows already in sync are NOT updated.
 *   - Mutates rows in place so callers can render the healed value directly.
 *   - § 9 BUrlG credits (Section9Credit, status CONFIRMED) are subtracted from the raw sum;
 *     AU_PENDING and REJECTED credits are ignored.
 *
 * Issue #445 (D-10) — the following three items used to be "out of scope (preserve parity with
 * the pre-refactor implementation)"; they are now IN scope:
 *   - Status set APPROVED + CANCELLATION_REQUESTED, not APPROVED only (CLAUDE.md: leave stays
 *     active and blocks regular time tracking until a cancellation is APPROVED).
 *   - Cross-year leave is attributed to each entitlement YEAR by the chronological-prefix rule
 *     (`countedLeaveDaysWithin`/`leaveDaysWithin`), not dropped by a strict year-bounds filter.
 *   - Every usedDays correction is now audited (`writeEntitlementAudit`, reason "Self-Heal",
 *     `userId: null`) and recomputes the NEXT year's carry-over (`recalculateCarryOver(year + 1,
 *     { createIfMissing: false })` — a read must never create a next-year row, D-11 scenario 5).
 *
 * Issue #445 (D-05, D-10): neither the zero-placeholder heal nor the usedDays heal is imported
 * statically from ./leave-days here — both are injected via `VacationTypeMeta.healZeroPlaceholder`
 * / `VacationTypeMeta.healUsedDays`. leave-days.ts already sits inside the
 * absence/scheduling/time-tracking/working-time-account import cycle Phase 101B measured and
 * capped at 22 modules (`measure-context-boundary-imports.ts --cycles --check 22`); this file is
 * reachable FROM that cycle (absence/index.ts re-exports selfHealUsedDays), so a static import of
 * ./leave-days here would make this file reachable BACK into the cycle too, growing it to 23 and
 * breaking the capped CI gate. Each caller — already holding `ensureRegularVacationEntitlement`
 * and (Task 2) the usedDays-heal function because it imports them for its own call sites — passes
 * both heal functions through the ctx object instead, which carries no static source dependency.
 */
import type { FastifyInstance } from "fastify";
import type { LeaveTypeCode } from "@clokr/db";

/**
 * Minimal row shape the helper needs. Matches against either of:
 *   - prisma.leaveEntitlement.findMany({ include: { leaveType: true } })
 *   - prisma.leaveEntitlement.findMany({ include: { leaveType: true, employee: {...} } })
 *
 * `usedDays` is intentionally typed as `unknown` to accept raw Prisma return
 * values (Decimal | number); the helper coerces with Number() before compare.
 *
 * `totalDays`/`isAutoCalculated` (Issue #445, D-05): both callers pass full Prisma rows that
 * already carry these columns — added so the zero-placeholder heal below can read them.
 */
export type LeaveEntitlementWithType = {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  year: number;
  usedDays: unknown;
  totalDays: unknown;
  isAutoCalculated: boolean;
  leaveType: { id: string; code: LeaveTypeCode | null };
  /**
   * Issue #445 (coordinator deviation from CONTEXT D-05) — set to `true` when this row is a
   * zero placeholder left unhealed because {@link VacationTypeMeta.healZeroPlaceholder} found
   * it ambiguous (a full prior year on record with a different totalDays). Callers surface this
   * as `entitlementWarning` in their response; `undefined`/`false` otherwise.
   */
  needsReview?: boolean;
};

export type VacationTypeMeta = {
  /** The tenant's VACATION LeaveType id, at most one per `@@unique([tenantId, code])`. Kept as
   *  an array so the aggregation shape below (typeIds: string[]) is unchanged. */
  vacationTypeIds: string[];
  /**
   * Phase 104 review (IN-03): carried so selfHealUsedDays() can pass a tenant scope into the
   * injected heal functions below without changing every call site's signature.
   */
  tenantId: string;
  /**
   * Issue #445 (D-05) — heals a zero-placeholder VACATION row in place, injected by the caller
   * (bound to `ensureRegularVacationEntitlement` + `REGULAR_ENTITLEMENT_REASON_SELF_HEAL`,
   * both already imported there) so this file carries no static import of `./leave-days` — see
   * the module docblock above. Omitted entirely only by a caller that genuinely never wants the
   * heal; every current caller (GET /leave/entitlements, GET /reports/leave-overview) sets it.
   */
  healZeroPlaceholder?: (
    prisma: FastifyInstance["prisma"],
    employeeId: string,
    tenantId: string,
    year: number,
    leaveTypeId: string,
  ) => Promise<{ entitlement: { totalDays: unknown }; healed: boolean; needsReview?: boolean }>;
  /**
   * Issue #445 (D-10) — heals `row.usedDays` in place for one entitlement row, per the
   * chronological-prefix rule (countedLeaveDaysWithin/leaveDaysWithin), auditing the change and
   * recomputing the NEXT year's carry-over with `createIfMissing: false`. Injected by the caller
   * (bound to `healEntitlementUsedDays` in `./leave-days`, already imported there for its own
   * call sites) for the same import-cycle reason as `healZeroPlaceholder` above. Omitted only by
   * a caller that genuinely never wants the usedDays heal; every current caller (GET
   * /leave/entitlements, GET /reports/leave-overview) sets it.
   */
  healUsedDays?: (
    prisma: FastifyInstance["prisma"],
    row: { id: string; employeeId: string; leaveTypeId: string; year: number; usedDays: unknown },
    leaveTypeIds: string[],
    tenantId: string,
  ) => Promise<{ usedDays: number; changed: boolean }>;
};

/**
 * Resolve the tenant's VACATION-coded LeaveType id.
 *
 * This MUST be called once per request (NOT per row) — calling it inside the
 * row loop would issue O(rows) queries against LeaveType for no reason.
 */
export async function loadVacationTypeMeta(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
): Promise<VacationTypeMeta> {
  const rows = await prisma.leaveType.findMany({
    where: { tenantId, code: "VACATION" },
    select: { id: true },
  });
  return { vacationTypeIds: rows.map((r) => r.id), tenantId };
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
  const { vacationTypeIds, tenantId, healZeroPlaceholder, healUsedDays } = ctx;

  for (const row of rows) {
    const isVacation = row.leaveType.code === "VACATION";

    // Issue #445 (D-05): heal a zero placeholder read-time, for every VACATION row this
    // self-heal walks (GET /entitlements, GET /reports/leave-overview). The actual heal
    // function is injected by the caller (see VacationTypeMeta.healZeroPlaceholder) to keep
    // this file out of the leave-days.ts import cycle.
    if (
      isVacation &&
      Number(row.totalDays) === 0 &&
      row.isAutoCalculated !== true &&
      healZeroPlaceholder
    ) {
      const healResult = await healZeroPlaceholder(
        prisma,
        row.employeeId,
        tenantId,
        row.year,
        row.leaveTypeId,
      );
      if (healResult.healed) {
        Object.assign(row, {
          totalDays: healResult.entitlement.totalDays,
          isAutoCalculated: true,
        });
      } else if (healResult.needsReview) {
        Object.assign(row, { needsReview: true });
      }
    }

    // Issue #445 (D-10): the usedDays heal itself — chronological cross-year attribution,
    // CANCELLATION_REQUESTED counted, § 9 credit attribution, audit, next-year carry
    // recompute. Injected via VacationTypeMeta.healUsedDays (see module docblock for why).
    if (!healUsedDays) continue;
    const typeIds = isVacation ? vacationTypeIds : [row.leaveTypeId];
    const healResult = await healUsedDays(
      prisma,
      {
        id: row.id,
        employeeId: row.employeeId,
        leaveTypeId: row.leaveTypeId,
        year: row.year,
        usedDays: row.usedDays,
      },
      typeIds,
      tenantId,
    );
    if (healResult.changed) {
      (row as unknown as { usedDays: number }).usedDays = healResult.usedDays;
    }
  }
}
