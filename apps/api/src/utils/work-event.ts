// Phase 77 Plan 02 — single read-path adapter for v1.9+ WorkEvent model.
//
// Why this exists: pre-refactor, BS-Tag minutes were loaded from `Absence` rows at
// 5 saldo sites (time-entries.ts, overtime.ts, auto-close-month.ts,
// recalculate-snapshots.ts, shifts.ts), each with its own inline
// `type !== "VOCATIONAL_SCHOOL"` + `source !== "PATTERN"` filter dance.
// PITFALLS.md S-1: this divergence caused live vs snapshot drift (documented at
// recalculate-snapshots.ts:262). The adapter is the canonical aggregation: every
// caller passes (employeeId, rangeStart, rangeEnd), gets back resolved
// (workedMinutes, expectedMinutes, coveredDates). Phase 63 D-01..D-04 doubling
// invariant is baked into the row (workedMinutes/expectedMinutes resolved at
// write time), so the adapter is a flat sum — no per-call-site recomputation.
//
// Tenant scoping: adapter does NOT enforce tenant filtering on its own — it
// trusts the caller to pass an `employeeId` scoped to the calling tenant.
// Defense-in-depth lives at the endpoint layer (Phase 79). PITFALLS.md M-3.
//
// Type-agnostic: adapter aggregates ALL WorkEvent types (VOCATIONAL_SCHOOL today;
// FIELD_SERVICE / BUSINESS_TRIP / TRAINING / OTHER reserved for Phase 80+).
// Adding a new type is a data-only change — no adapter code path changes.
//
// Consumed by:
//   - apps/api/src/routes/time-entries.ts (Phase 78 — updateOvertimeAccount)
//   - apps/api/src/routes/overtime.ts (Phase 78 — close-month)
//   - apps/api/src/plugins/auto-close-month.ts (Phase 78 — cron snapshot)
//   - apps/api/src/utils/recalculate-snapshots.ts (Phase 78 — closes drift gap)
//   - apps/api/src/routes/shifts.ts (Phase 78 — Soll-Korrelation)

import type { PrismaClient } from "@clokr/db";

export interface WorkEventAggregate {
  /** Σ of workedMinutes across all matching rows. */
  workedMinutes: number;
  /** Σ of expectedMinutes — NULL (MONTHLY_HOURS, Phase 63 D-04) counted as 0. */
  expectedMinutes: number;
  /** ISO date strings (YYYY-MM-DD) for every WorkEvent in range. */
  coveredDates: Set<string>;
}

/**
 * Aggregate WorkEvent contribution for an employee in [rangeStart, rangeEnd).
 *
 * Half-open range: rangeStart inclusive, rangeEnd exclusive — matches the
 * project's monthRangeUtc() / tenant-TZ boundary convention.
 *
 * Soft-deleted rows (`deletedAt IS NOT NULL`) are excluded unconditionally —
 * the soft-delete contract is hard-coded inside the adapter so no caller can
 * bypass it (CLAUDE.md "Soft delete queries" rule).
 *
 * @param prisma     Prisma client (or test client)
 * @param employeeId Employee whose WorkEvents to aggregate. Tenant-scoping is the
 *                   caller's responsibility (PITFALLS.md M-3).
 * @param rangeStart Range start (UTC instant — typically tenant-TZ-anchored start of period)
 * @param rangeEnd   Range end (UTC instant — exclusive)
 * @returns Aggregated worked/expected minutes + set of covered ISO date strings
 */
export async function loadWorkEventsForRange(
  prisma: PrismaClient,
  employeeId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<WorkEventAggregate> {
  const rows = await prisma.workEvent.findMany({
    where: {
      employeeId,
      date: { gte: rangeStart, lt: rangeEnd },
      deletedAt: null,
    },
    select: {
      date: true,
      workedMinutes: true,
      expectedMinutes: true,
    },
  });

  let workedMinutes = 0;
  let expectedMinutes = 0;
  const coveredDates = new Set<string>();

  for (const row of rows) {
    workedMinutes += row.workedMinutes;
    // expectedMinutes is NULL for MONTHLY_HOURS (Phase 63 D-04) — count as 0.
    expectedMinutes += row.expectedMinutes ?? 0;
    coveredDates.add(toIsoDate(row.date));
  }

  return { workedMinutes, expectedMinutes, coveredDates };
}

/** YYYY-MM-DD of a Date in UTC (WorkEvent.date is `@db.Date` — UTC midnight). */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
