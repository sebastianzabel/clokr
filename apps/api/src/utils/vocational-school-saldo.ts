// Phase 63 — Berufsschule Saldo helper (D-01..D-04)
//
// Pure helpers that encode the CONTEXT.md D-02 capped block-week semantics for the
// saldo math in apps/api/src/routes/overtime.ts (4 loops) and
// apps/api/src/plugins/auto-close-month.ts (snapshot path).
//
// Net effect on saldo (D-01): BS minutes contribute to BOTH workedMinutes AND
// expectedMinutes for the same amount → balance stays neutral.
//
// MONTHLY_HOURS schedules (D-04) are handled by the caller (route/plugin layer)
// — this helper only returns the minute count for a single date. The caller
// decides which accumulator(s) to add it to.
//
// LOCKED invariants (CLAUDE.md "Soft Delete Convention"):
//   - Every Absence query MUST include deletedAt: null.

import type { PrismaClient, ScheduleType } from "@clokr/db";
import { BS_DAILY_DEFAULT_MIN } from "./vocational-school-constants.js";
import { buildSlotOverrideHierarchy, resolveBsTagSlot } from "./bs-slot-resolver";

/**
 * Tenant-config fields this helper reads. Both are optional/nullable to fail-open
 * (missing TenantConfig row → use coded defaults that match the schema @default).
 */
export interface VocationalSchoolTenantConfig {
  vocationalSchoolMinutesPerDay?: number | null;
  vocationalSchoolBlockMinutesPerWeek?: number | null;
  // Phase 76.31 — BVaDiG-2024 slot-aware BS crediting (D-06 tenant layer).
  bsSlotFirstLongDayMinutes?: number | null;
  bsSlotSecondLongDayMinutes?: number | null;
  bsSlotShortDayMinutes?: number | null;
  bsSlotBlockWeekMinutes?: number | null;
}

/**
 * Minimal schedule shape needed to compute the individual daily Soll.
 * weeklyHours / {day}Hours may be Prisma Decimal, number, string, or null — all are
 * `Number()`-coercible, so the fields are typed `unknown` to accept Decimal directly
 * without a cast at every call site.
 */
export interface ScheduleForDailySoll {
  weeklyHours?: unknown;
  mondayHours?: unknown;
  tuesdayHours?: unknown;
  wednesdayHours?: unknown;
  thursdayHours?: unknown;
  fridayHours?: unknown;
  saturdayHours?: unknown;
  sundayHours?: unknown;
}

/**
 * Phase 76.31 D-02 — individual daily Soll from a WorkSchedule.
 *
 *   workDaysPerWeek = count of {day}Hours markers > 0 (Mo..So)
 *   dailySoll       = round(weeklyHours * 60 / workDaysPerWeek)   (0-guard)
 *
 * Per RESEARCH Q3: the {day}Hours values are markers used to COUNT workdays; the
 * AMOUNT is always weeklyHours/workDaysPerWeek, NEVER the {day}Hours values directly.
 * This is the FIRST_LONG_DAY final fallback so a 38h/4-day Azubi gets 570 min (9.5h),
 * mirroring the holiday `dailySollMin` pattern (timezone.ts, close-employee-month.ts:493).
 */
export function computeDailySollMinutes(schedule: ScheduleForDailySoll): number {
  const days = [
    "mondayHours",
    "tuesdayHours",
    "wednesdayHours",
    "thursdayHours",
    "fridayHours",
    "saturdayHours",
    "sundayHours",
  ] as const;
  const workDaysPerWeek = days.filter((d) => Number(schedule[d] ?? 0) > 0).length;
  if (workDaysPerWeek === 0) return 0; // 0-guard (RESEARCH line 37)
  return Math.round((Number(schedule.weeklyHours ?? 0) * 60) / workDaysPerWeek);
}

/**
 * Compute the Monday 00:00:00.000 UTC and the next Monday 00:00:00.000 UTC for the
 * ISO week containing `dateInWeek`. Returns [monday, nextMonday) — half-open so a
 * gte/lt Prisma filter never includes the Monday of the following week.
 *
 * Mirrors the ISO-week semantics in apps/api/src/utils/vocational-school-generator.ts
 * (Phase 62). Mon = 1 ... Sun = 7 day numbering.
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

/**
 * Compute the UTC midnight (00:00:00.000) and the next UTC midnight for the calendar
 * date of `date`. Returns [start, next) for a half-open range query against
 * Absence.startDate (stored as @db.Date, i.e. UTC midnight).
 */
function dateRangeUtc(date: Date): { start: Date; next: Date } {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
  const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, next };
}

/**
 * Returns the count of distinct VOCATIONAL_SCHOOL Absence days in the SAME ISO week
 * as `dateInWeek`, for the given employee. Soft-delete-aware (deletedAt: null).
 *
 * Used by both the caller (to detect block-week semantics) and by
 * getVocationalSchoolMinutesForDate() internally.
 */
export async function countBsDaysInIsoWeek(
  prisma: PrismaClient,
  employeeId: string,
  dateInWeek: Date,
): Promise<number> {
  const { monday, nextMonday } = isoWeekBoundsUtc(dateInWeek);

  const rows = await prisma.absence.findMany({
    where: {
      employeeId,
      deletedAt: null, // CLAUDE.md soft-delete rule
      type: "VOCATIONAL_SCHOOL",
      startDate: { gte: monday, lt: nextMonday },
    },
    select: { startDate: true },
  });
  // Defensive de-dupe by ISO date string. The Phase 62 generator emits exactly one row
  // per BS day, but Absence has no @@unique on (employeeId, startDate) alone (only with
  // `type` — Phase 63-01), so we de-dupe defensively here.
  const uniq = new Set(rows.map((r) => r.startDate.toISOString().slice(0, 10)));
  return uniq.size;
}

/**
 * Returns the number of BS minutes attributable to `date` for the given employee.
 *
 * Applies the CONTEXT.md D-02 capped-block semantics:
 *   - 0 if no VOCATIONAL_SCHOOL Absence exists for `date` (soft-delete-aware)
 *   - 0 if the existing Absence is soft-deleted or of a different type
 *   - When the same ISO week has < 5 BS days → each day posts
 *     `tenantConfig.vocationalSchoolMinutesPerDay` (default 480)
 *   - When the same ISO week has ≥ 5 BS days → each day posts
 *     `tenantConfig.vocationalSchoolBlockMinutesPerWeek / N` where N is the total
 *     BS days in that ISO week. This CAPS the weekly total at the tenant's weekly
 *     setting (BERSCH-04).
 *
 * The helper is schedule-type-agnostic. The caller (overtime.ts, auto-close-month.ts)
 * decides whether to add the returned number to workedMinutes only (MONTHLY_HOURS per
 * D-04) or to both workedMinutes AND expectedMinutes (FIXED_SCHEDULE / FLEXTIME /
 * SHIFT_BASED per D-01).
 */
export async function getVocationalSchoolMinutesForDate(
  prisma: PrismaClient,
  employeeId: string,
  date: Date,
  tenantConfig: VocationalSchoolTenantConfig | null,
  opts?: {
    /** Active WorkSchedule at `date` — used to compute the individual daily Soll. */
    schedule?: ScheduleForDailySoll | null;
    /** Active schedule type at `date` — drives contributesToExpected (D-04). */
    scheduleType?: ScheduleType | string | null;
  },
): Promise<number> {
  const { start, next } = dateRangeUtc(date);

  const bs = await prisma.absence.findFirst({
    where: {
      employeeId,
      deletedAt: null, // CLAUDE.md soft-delete rule
      type: "VOCATIONAL_SCHOOL",
      startDate: { gte: start, lt: next },
    },
    select: { id: true },
  });
  if (!bs) return 0;

  // ── Phase 76.31: slot-aware amount resolution (D-06 4-layer bsSlot* hierarchy) ──
  //
  // Load the Employee + active Pattern bsSlot* rows so the pure resolver can walk the
  // Employee ?? Pattern ?? TenantConfig ?? legacy ?? daily-Soll chain. The schedule is
  // supplied by the caller (opts) — it already holds it in scope. When no schedule is
  // provided, dailySollMinutes falls back to BS_DAILY_DEFAULT_MIN (480), preserving the
  // legacy pauschal behavior for callers that have not yet threaded a schedule.

  const employeeSlots = await prisma.employee.findFirst({
    where: { id: employeeId },
    select: {
      bsSlotFirstLongDayMinutes: true,
      bsSlotSecondLongDayMinutes: true,
      bsSlotShortDayMinutes: true,
      bsSlotBlockWeekMinutes: true,
    },
  });

  // Active BS pattern covering `date` (isActive + validFrom/validUntil window). If 0
  // rows → pattern=null (delegate to the TenantConfig layer).
  const { start: dayStart } = dateRangeUtc(date);
  const patternSlots = await prisma.employeeVocationalSchoolPattern.findFirst({
    where: {
      employeeId,
      isActive: true,
      validFrom: { lte: dayStart },
      OR: [{ validUntil: null }, { validUntil: { gte: dayStart } }],
    },
    orderBy: { validFrom: "desc" },
    select: {
      bsSlotFirstLongDayMinutes: true,
      bsSlotSecondLongDayMinutes: true,
      bsSlotShortDayMinutes: true,
      bsSlotBlockWeekMinutes: true,
    },
  });

  const dailySollMinutes = opts?.schedule
    ? computeDailySollMinutes(opts.schedule)
    : BS_DAILY_DEFAULT_MIN;

  const hierarchy = buildSlotOverrideHierarchy({
    employee: employeeSlots ?? null,
    pattern: patternSlots ?? null,
    tenantConfig: {
      bsSlotFirstLongDayMinutes: tenantConfig?.bsSlotFirstLongDayMinutes ?? null,
      bsSlotSecondLongDayMinutes: tenantConfig?.bsSlotSecondLongDayMinutes ?? null,
      bsSlotShortDayMinutes: tenantConfig?.bsSlotShortDayMinutes ?? null,
      bsSlotBlockWeekMinutes: tenantConfig?.bsSlotBlockWeekMinutes ?? null,
      vocationalSchoolMinutesPerDay: tenantConfig?.vocationalSchoolMinutesPerDay ?? null,
      vocationalSchoolBlockMinutesPerWeek:
        tenantConfig?.vocationalSchoolBlockMinutesPerWeek ?? null,
    },
    dailySollMinutes,
  });

  // ISO-week context: sorted distinct BS dates in the same ISO week → ordinalInWeek.
  const bsDatesInWeek = await sortedBsDatesInIsoWeek(prisma, employeeId, date);
  const isBlockWeek = bsDatesInWeek.length >= 5;
  const targetDs = start.toISOString().slice(0, 10);
  const idx = bsDatesInWeek.indexOf(targetDs);
  const ordinalInWeek = idx >= 0 ? idx + 1 : 1; // 1-based; defensive fallback to 1

  const res = resolveBsTagSlot(
    date,
    ordinalInWeek,
    { bsDatesInWeek, isBlockWeek },
    hierarchy,
    (opts?.scheduleType ?? "FIXED_SCHEDULE") as ScheduleType,
  );

  return res.creditedMinutes;
}

/**
 * Returns the sorted (date ASC) distinct YYYY-MM-DD strings of VOCATIONAL_SCHOOL
 * Absence days in the SAME ISO week as `dateInWeek`, soft-delete-filtered. Used to
 * derive the 1-based ordinalInWeek for resolveBsTagSlot (PITFALLS CD-2).
 */
async function sortedBsDatesInIsoWeek(
  prisma: PrismaClient,
  employeeId: string,
  dateInWeek: Date,
): Promise<string[]> {
  const { monday, nextMonday } = isoWeekBoundsUtc(dateInWeek);
  const rows = await prisma.absence.findMany({
    where: {
      employeeId,
      deletedAt: null, // CLAUDE.md soft-delete rule
      type: "VOCATIONAL_SCHOOL",
      startDate: { gte: monday, lt: nextMonday },
    },
    orderBy: { startDate: "asc" },
    select: { startDate: true },
  });
  const uniq = new Set(rows.map((r) => r.startDate.toISOString().slice(0, 10)));
  return Array.from(uniq).sort();
}
