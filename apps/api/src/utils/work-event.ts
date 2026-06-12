// Phase 77 Plan 02 — single read-path adapter for v1.9+ WorkEvent model.
// Phase 78 Plan 01 — extended with Absence-compat-branch + BS helpers + D-11 Variante B.
//
// Why this exists: pre-refactor, BS-Tag minutes were loaded from `Absence` rows at
// 5 saldo sites (time-entries.ts, overtime.ts, auto-close-month.ts,
// recalculate-snapshots.ts, shifts.ts), each with its own inline
// `type !== "VOCATIONAL_SCHOOL"` + `source !== "PATTERN"` filter dance.
// PITFALLS.md S-1: this divergence caused live vs snapshot drift (documented at
// recalculate-snapshots.ts:262). The adapter is the canonical aggregation: every
// caller passes (employeeId, rangeStart, rangeEnd), gets back resolved
// (workedMinutes, expectedMinutes, coveredDates).
//
// Phase 78 amendment — Compat-routing for the pre-migration coexistence window:
//
//   tenantConfig.workEventModelLive = true  → WorkEvent rows (Phase 77 path,
//                                             pre-resolved workedMinutes/expectedMinutes
//                                             per Phase 63 D-01..D-04 invariant baked
//                                             into row at write time).
//   tenantConfig.workEventModelLive = false → Absence rows of type VOCATIONAL_SCHOOL.
//                                             For each BS date, resolve effective
//                                             schedule type AT THAT DATE (D-12 accept-
//                                             stale) and apply Phase 63 D-01..D-04
//                                             doubling rule inside the adapter — the
//                                             legacy logic moves from 5 inline saldo
//                                             sites → ONE place.
//
// This is the compat-layer-equivalence guarantee: both branches return
// byte-identical { workedMinutes, expectedMinutes, coveredDates } for identical
// scenarios. CONTEXT D-06 / D-08 strict 0-tolerance.
//
// Tenant scoping: adapter does NOT enforce tenant filtering on its own — it
// trusts the caller to pass an `employeeId` scoped to the calling tenant.
// Defense-in-depth lives at the endpoint layer (Phase 79). PITFALLS.md M-3.
// Internally, the adapter resolves tenantConfig via employee.tenantId for the
// compat-routing flag lookup.
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
//   - apps/api/src/utils/arbzg.ts (Phase 78 — 24-week BS source)
//   - apps/api/src/utils/jarbschg.ts (Phase 78 — JArbSchG cap)

import type { PrismaClient } from "@clokr/db";
import { AbsenceType } from "@clokr/db";
import {
  getVocationalSchoolMinutesForDate,
  countBsDaysInIsoWeek as countBsDaysInIsoWeekFromAbsence,
} from "./vocational-school-saldo.js";

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
 * Compat-routed (Phase 78 D-04): reads either WorkEvent rows (post-migration)
 * or Absence rows (legacy) based on `tenant.workEventModelLive`.
 *
 * Half-open range: rangeStart inclusive, rangeEnd exclusive — matches the
 * project's monthRangeUtc() / tenant-TZ boundary convention.
 *
 * Soft-deleted rows (`deletedAt IS NOT NULL`) are excluded unconditionally —
 * the soft-delete contract is hard-coded inside the adapter so no caller can
 * bypass it (CLAUDE.md "Soft delete queries" rule).
 *
 * @param prisma     Prisma client (or test client)
 * @param employeeId Employee whose contribution to aggregate. Tenant-scoping is the
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
  const routing = await resolveCompatRouting(prisma, employeeId);
  if (routing.workEventModelLive) {
    return aggregateWorkEvents(prisma, employeeId, rangeStart, rangeEnd);
  }
  return aggregateLegacyAbsences(prisma, employeeId, rangeStart, rangeEnd, routing);
}

/**
 * Phase 78 D-11 LOCKED default: Variante B max-merge.
 * Phase 83 replaces this constant with a `tenantConfig.combineBsAndWorkOnSameDay`
 * lookup (1-line swap target).
 */
export const VARIANT_B_MAX_MERGE = true;

/**
 * Combine same-day BS pauschal credit with TimeEntry instruction+work per D-11
 * Variante B. Default: max(pauschal, instruction+work) — Azubi gets at least the
 * BS-Tag pauschal, but if real work-day exceeds pauschal, real wins.
 *
 * Phase 83 will swap the constant for a per-tenant config (SUM_CAPPED_BY_ARBZG).
 */
export function combineBsAndWorkOnSameDay(
  pauschalCredit: number,
  instructionMin: number,
  workedMin: number,
): number {
  if (!VARIANT_B_MAX_MERGE) {
    // Phase 83 SUM_CAPPED_BY_ARBZG branch — sum, capped by ArbZG §3 daily 10h.
    return Math.min(pauschalCredit + workedMin, 10 * 60);
  }
  return Math.max(pauschalCredit, instructionMin + workedMin);
}

/**
 * Returns BS minutes attributable to `date` for this employee (compat-routed).
 * Replaces inline `getVocationalSchoolMinutesForDate` calls in saldo paths.
 */
export async function getBsMinutesForDate(
  prisma: PrismaClient,
  employeeId: string,
  date: Date,
): Promise<number> {
  const routing = await resolveCompatRouting(prisma, employeeId);
  if (routing.workEventModelLive) {
    const { start, next } = dateRangeUtc(date);
    const row = await prisma.workEvent.findFirst({
      where: {
        employeeId,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        deletedAt: null,
        date: { gte: start, lt: next },
      },
      select: { workedMinutes: true },
    });
    return row?.workedMinutes ?? 0;
  }
  return getVocationalSchoolMinutesForDate(prisma, employeeId, date, {
    vocationalSchoolMinutesPerDay: routing.vocationalSchoolMinutesPerDay,
    vocationalSchoolBlockMinutesPerWeek: routing.vocationalSchoolBlockMinutesPerWeek,
  });
}

/**
 * Counts distinct BS days in the ISO week of `dateInWeek` (compat-routed).
 * Replaces inline `prisma.absence.findMany`/`countBsDaysInIsoWeek` in saldo paths.
 */
export async function countBsDaysInIsoWeek(
  prisma: PrismaClient,
  employeeId: string,
  dateInWeek: Date,
): Promise<number> {
  const routing = await resolveCompatRouting(prisma, employeeId);
  if (routing.workEventModelLive) {
    const { monday, nextMonday } = isoWeekBoundsUtc(dateInWeek);
    const rows = await prisma.workEvent.findMany({
      where: {
        employeeId,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        deletedAt: null,
        date: { gte: monday, lt: nextMonday },
      },
      select: { date: true },
    });
    const uniq = new Set(rows.map((r) => toIsoDate(r.date)));
    return uniq.size;
  }
  return countBsDaysInIsoWeekFromAbsence(prisma, employeeId, dateInWeek);
}

/**
 * Returns true if employee has a BS event on `date` (compat-routed).
 * Soft-delete-aware in both branches.
 */
export async function hasBsOnDate(
  prisma: PrismaClient,
  employeeId: string,
  date: Date,
): Promise<boolean> {
  const routing = await resolveCompatRouting(prisma, employeeId);
  const { start, next } = dateRangeUtc(date);
  if (routing.workEventModelLive) {
    const row = await prisma.workEvent.findFirst({
      where: {
        employeeId,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        deletedAt: null,
        date: { gte: start, lt: next },
      },
      select: { id: true },
    });
    return row !== null;
  }
  const ab = await prisma.absence.findFirst({
    where: {
      employeeId,
      type: AbsenceType.VOCATIONAL_SCHOOL,
      deletedAt: null,
      startDate: { gte: start, lt: next },
    },
    select: { id: true },
  });
  return ab !== null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface CompatRouting {
  workEventModelLive: boolean;
  vocationalSchoolMinutesPerDay: number | null;
  vocationalSchoolBlockMinutesPerWeek: number | null;
  tenantId: string | null;
}

/**
 * Look up the compat-routing flag + BS minute config for an employee. The
 * tenant lookup is internal to the adapter — callers pass employeeId only.
 *
 * Default for missing tenantConfig row: `workEventModelLive=false` — i.e. the
 * Absence-branch (legacy / unmigrated tenant) is used. This matches:
 *   - Prisma schema default (`@default(false)` on TenantConfig.workEventModelLive)
 *   - Phase 80 migration intent (flag is flipped to `true` per-tenant only after
 *     the operator script successfully migrates Absence→WorkEvent rows)
 *
 * The employee-not-found edge case returns `true` because the empty aggregate
 * `{ workedMinutes: 0, expectedMinutes: 0, coveredDates: ∅ }` is short-circuited
 * before any branch logic runs, so the flag value is observationally irrelevant.
 *
 * DO NOT change the missing-tenantConfig default to `true` — that would silently
 * flip every legacy tenant onto an empty WorkEvent table → saldo collapses to
 * zero for any production tenant whose TenantConfig row is missing fields.
 */
async function resolveCompatRouting(
  prisma: PrismaClient,
  employeeId: string,
): Promise<CompatRouting> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  if (!employee) {
    return {
      workEventModelLive: true,
      vocationalSchoolMinutesPerDay: null,
      vocationalSchoolBlockMinutesPerWeek: null,
      tenantId: null,
    };
  }
  const tenantConfig = await prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
    select: {
      workEventModelLive: true,
      vocationalSchoolMinutesPerDay: true,
      vocationalSchoolBlockMinutesPerWeek: true,
    },
  });
  return {
    workEventModelLive: tenantConfig?.workEventModelLive ?? false,
    vocationalSchoolMinutesPerDay: tenantConfig?.vocationalSchoolMinutesPerDay ?? null,
    vocationalSchoolBlockMinutesPerWeek: tenantConfig?.vocationalSchoolBlockMinutesPerWeek ?? null,
    tenantId: employee.tenantId,
  };
}

/**
 * Phase 77 path — flat sum of pre-resolved WorkEvent rows. Phase 63 D-01..D-04
 * invariant is baked into the row at write time.
 */
async function aggregateWorkEvents(
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

/**
 * Phase 78 compat path — reads Absence rows of type VOCATIONAL_SCHOOL and
 * applies Phase 63 D-01..D-04 doubling rule per BS date. Per-BS-date schedule
 * resolution (D-12 accept-stale) decides whether expectedMinutes is doubled.
 */
async function aggregateLegacyAbsences(
  prisma: PrismaClient,
  employeeId: string,
  rangeStart: Date,
  rangeEnd: Date,
  routing: CompatRouting,
): Promise<WorkEventAggregate> {
  // Find all BS absences whose startDate falls in [rangeStart, rangeEnd).
  // Absences span [startDate, endDate] inclusive (block weeks), so we also
  // need to walk each multi-day absence and credit each in-range date.
  const bsAbsences = await prisma.absence.findMany({
    where: {
      employeeId,
      deletedAt: null,
      type: AbsenceType.VOCATIONAL_SCHOOL,
      // Overlap with [rangeStart, rangeEnd): endDate >= rangeStart AND startDate < rangeEnd
      startDate: { lt: rangeEnd },
      endDate: { gte: rangeStart },
    },
    select: { startDate: true, endDate: true },
  });

  let workedMinutes = 0;
  let expectedMinutes = 0;
  const coveredDates = new Set<string>();

  const tenantConfigSlice = {
    vocationalSchoolMinutesPerDay: routing.vocationalSchoolMinutesPerDay,
    vocationalSchoolBlockMinutesPerWeek: routing.vocationalSchoolBlockMinutesPerWeek,
  };

  for (const ab of bsAbsences) {
    // Clamp to range; iterate each day inclusive of endDate.
    const start = ab.startDate < rangeStart ? rangeStart : ab.startDate;
    const stopExclusive = rangeEnd; // [rangeStart, rangeEnd)
    const cur = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 0, 0, 0, 0),
    );
    // Walk days while cur is within absence AND cur < rangeEnd.
    while (cur < stopExclusive && cur <= ab.endDate) {
      const iso = toIsoDate(cur);
      if (!coveredDates.has(iso)) {
        const bsMin = await getVocationalSchoolMinutesForDate(
          prisma,
          employeeId,
          cur,
          tenantConfigSlice,
        );
        if (bsMin > 0) {
          workedMinutes += bsMin;
          const scheduleType = await resolveScheduleTypeAt(prisma, employeeId, cur);
          // Phase 63 D-01..D-04 + legacy semantic: every Soll-bearing schedule
          // doubles (FIXED_SCHEDULE, FLEXTIME, SHIFT_BASED). Only MONTHLY_HOURS
          // skips the expected-side add (D-04 — pure tracking, no Soll).
          if (scheduleType !== "MONTHLY_HOURS") {
            expectedMinutes += bsMin;
          }
          coveredDates.add(iso);
        }
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  return { workedMinutes, expectedMinutes, coveredDates };
}

/**
 * Resolve the ScheduleType active for an employee AT a specific date (D-12
 * accept-stale per BS-date). Mirrors `getEffectiveSchedule` from
 * apps/api/src/routes/time-entries.ts but lives here to avoid a circular import.
 *
 * Falls back to "FIXED_SCHEDULE" if no WorkSchedule exists (matches the route
 * helper's default-schedule branch).
 */
async function resolveScheduleTypeAt(
  prisma: PrismaClient,
  employeeId: string,
  date: Date,
): Promise<"FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED"> {
  const schedule = await prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: date } },
    orderBy: { validFrom: "desc" },
    select: { type: true },
  });
  return schedule?.type ?? "FIXED_SCHEDULE";
}

/** YYYY-MM-DD of a Date in UTC (WorkEvent.date is `@db.Date` — UTC midnight). */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the UTC midnight (00:00:00.000) and the next UTC midnight for the
 * calendar date of `date`. Returns [start, next) for a half-open range query.
 */
function dateRangeUtc(date: Date): { start: Date; next: Date } {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
  const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, next };
}

/**
 * Compute the Monday 00:00:00.000 UTC and the next Monday 00:00:00.000 UTC for
 * the ISO week containing `dateInWeek`. Returns [monday, nextMonday).
 *
 * Mirrors apps/api/src/utils/vocational-school-saldo.ts isoWeekBoundsUtc.
 */
function isoWeekBoundsUtc(dateInWeek: Date): { monday: Date; nextMonday: Date } {
  const d = new Date(
    Date.UTC(dateInWeek.getUTCFullYear(), dateInWeek.getUTCMonth(), dateInWeek.getUTCDate()),
  );
  const dayOfWeek = d.getUTCDay(); // 0 = Sun ... 6 = Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // 0 = Mon ... 6 = Sun
  const monday = new Date(d.getTime());
  monday.setUTCDate(d.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);
  const nextMonday = new Date(monday.getTime());
  nextMonday.setUTCDate(monday.getUTCDate() + 7);
  return { monday, nextMonday };
}
