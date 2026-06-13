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
import { AbsenceType, WorkEventType } from "@clokr/db";
import {
  getVocationalSchoolMinutesForDate,
  countBsDaysInIsoWeek as countBsDaysInIsoWeekFromAbsence,
} from "./vocational-school-saldo.js";
import type { SlotType } from "./bs-slot-resolver.js";

// Phase 83 — Re-export resolver symbols so Plan 04 (operator script) and
// jarbschg.ts can import them from a single adapter entry point.
export type { SlotType } from "./bs-slot-resolver.js";
export { resolveBsTagSlot, buildSlotOverrideHierarchy } from "./bs-slot-resolver.js";
export type {
  WeekContext,
  SlotResolution,
  SlotOverrideHierarchy,
  SlotLayerInputs,
} from "./bs-slot-resolver.js";

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
  const routing = await getRoutingConfig(prisma, employeeId);
  if (routing.workEventModelLive) {
    return aggregateWorkEvents(prisma, employeeId, rangeStart, rangeEnd);
  }
  return aggregateLegacyAbsences(prisma, employeeId, rangeStart, rangeEnd, routing);
}

/**
 * @deprecated Phase 83 — use `combineBsAndWorkOnSameDay(..., slotType)` directly.
 * Retained as `true` so the legacy Absence-branch (workEventModelLive=false)
 * callers that haven't been migrated to slotType-aware calls yet still apply
 * Variante B semantics. The boolean value itself is no longer read inside
 * combineBsAndWorkOnSameDay — slotType parameter drives the branch.
 */
export const VARIANT_B_MAX_MERGE = true;

/**
 * Phase 83 — Slot-type-aware same-day BS + TimeEntry combination (BBIG-V19-05).
 *
 * Pauschal slots (FIRST_LONG_DAY, BLOCK_WEEK): Variante B max-merge so the
 * BS-Tag credit never falls below the legally guaranteed pauschal even if
 * actual instruction+work was shorter. Per BBiG §15 Abs.2 Satz 1.
 *
 * Netto slots (SECOND_LONG_DAY, SHORT_DAY): instruction+work directly — there
 * is no pauschal floor for these slots per BBiG §15 Abs.2 Nr.1.
 *
 * The slotType parameter is optional with FIRST_LONG_DAY default so existing
 * callers (Phase 78 saldo paths not yet migrated to slotType) continue to
 * apply Variante B semantics unchanged. Plan 03 wires explicit slotType in
 * all new resolve paths.
 */
export function combineBsAndWorkOnSameDay(
  pauschalCredit: number,
  instructionMin: number,
  workedMin: number,
  slotType: SlotType = "FIRST_LONG_DAY",
): number {
  if (slotType === "FIRST_LONG_DAY" || slotType === "BLOCK_WEEK") {
    // Pauschal slots: Variante B max-merge — Azubi gets at least the pauschal
    // but actual instruction+work wins if it exceeds the pauschal.
    return Math.max(pauschalCredit, instructionMin + workedMin);
  }
  // SECOND_LONG_DAY, SHORT_DAY: netto sum — no pauschal floor (per BBiG §15 Abs.2 Nr.1)
  return instructionMin + workedMin;
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
  const routing = await getRoutingConfig(prisma, employeeId);
  if (routing.workEventModelLive) {
    const { start, next } = dateRangeUtc(date);
    const row = await prisma.workEvent.findFirst({
      where: {
        employeeId,
        // WR-01 (Phase 79 review): WorkEvent.type is a WorkEventType column
        // at the Prisma layer. Filter with the typed enum that matches the
        // column to avoid a silent break the day either enum's literal value
        // diverges (both currently share the string "VOCATIONAL_SCHOOL").
        type: WorkEventType.VOCATIONAL_SCHOOL,
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
  const routing = await getRoutingConfig(prisma, employeeId);
  if (routing.workEventModelLive) {
    const { monday, nextMonday } = isoWeekBoundsUtc(dateInWeek);
    const rows = await prisma.workEvent.findMany({
      where: {
        employeeId,
        // WR-01 (Phase 79 review): typed-enum match — see getBsMinutesForDate.
        type: WorkEventType.VOCATIONAL_SCHOOL,
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
  const routing = await getRoutingConfig(prisma, employeeId);
  const { start, next } = dateRangeUtc(date);
  if (routing.workEventModelLive) {
    const row = await prisma.workEvent.findFirst({
      where: {
        employeeId,
        // WR-01 (Phase 79 review): typed-enum match — see getBsMinutesForDate.
        type: WorkEventType.VOCATIONAL_SCHOOL,
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

// ── Compat routing helpers (REVISION W6: promoted to public export) ─────────

// ── Tenant-level workEventModelLive cache (WR-02, Phase 79 review) ─────────
// Mirrors the tzCache pattern in utils/timezone.ts. Used by tenant-level
// endpoints (e.g. /vocational-school/upcoming) that can't naturally pass an
// employeeId to getRoutingConfig. 5-minute TTL matches the rest of the
// tenantConfig-cached helpers in this codebase.
const tenantFlagCache = new Map<string, { live: boolean; exp: number }>();
const TENANT_FLAG_TTL_MS = 5 * 60_000;

/**
 * Resolve `tenantConfig.workEventModelLive` for a tenant. Cached for 5
 * minutes to avoid hot per-request reads on tenant-level listing endpoints.
 *
 * Use this when you have a tenantId but no employeeId — e.g. /upcoming list
 * routes that scope by tenant. When you have an employeeId, prefer
 * `getRoutingConfig` which returns the same flag plus per-tenant BS minute
 * config in a single round-trip.
 *
 * Default for missing tenantConfig row: `false` — i.e. the Absence-branch
 * (legacy / unmigrated tenant) is used. Matches `getRoutingConfig`'s default
 * AND the Prisma schema default (`@default(false)` on
 * TenantConfig.workEventModelLive).
 */
export async function getTenantWorkEventModelLive(
  prisma: PrismaClient,
  tenantId: string,
): Promise<boolean> {
  const cached = tenantFlagCache.get(tenantId);
  if (cached && cached.exp > Date.now()) return cached.live;

  const tc = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { workEventModelLive: true },
  });
  const live = tc?.workEventModelLive ?? false;
  tenantFlagCache.set(tenantId, { live, exp: Date.now() + TENANT_FLAG_TTL_MS });
  return live;
}

/**
 * Test-only cache invalidation hook for `getTenantWorkEventModelLive`. Called
 * from `beforeEach` in tests that flip `tenantConfig.workEventModelLive` mid-
 * test so the next request observes the new flag value. NOT for production
 * use — the cache is intentionally 5 minutes so the BC-proxy hot paths do not
 * hit the DB per request. When `tenantId` is omitted, the entire cache is
 * cleared.
 */
export function invalidateTenantWorkEventModelLiveCache(tenantId?: string): void {
  if (tenantId === undefined) {
    tenantFlagCache.clear();
    return;
  }
  tenantFlagCache.delete(tenantId);
}

export interface CompatRouting {
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
 *
 * REVISION (W6, Phase 79 Plan 04): renamed from the previous internal compat
 * helper and EXPORTED so apps/api/src/routes/vocational-school.ts can reuse the
 * same cached lookup pattern instead of rolling its own private helper.
 */
export async function getRoutingConfig(
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
 *
 * Phase 83 — exported unconditionally so jarbschg.ts (Plan 03) and the
 * operator script (Plan 04) can resolve the schedule type at a given date
 * without duplicating this logic.
 */
export async function resolveScheduleTypeAt(
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

/**
 * YYYY-MM-DD of a Date in UTC (WorkEvent.date is `@db.Date` — UTC midnight).
 *
 * Phase 83 — exported unconditionally so jarbschg.ts (Plan 03) and Plan 04
 * operator script can derive ISO date strings without reimplementing this.
 */
export function toIsoDate(d: Date): string {
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
 *
 * Phase 83 — exported unconditionally so jarbschg.ts (Plan 03) and Plan 04
 * operator script can derive ISO week bounds without reimplementing this.
 */
export function isoWeekBoundsUtc(dateInWeek: Date): { monday: Date; nextMonday: Date } {
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
