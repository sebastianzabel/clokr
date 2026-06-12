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

import type { PrismaClient } from "@clokr/db";
import { AbsenceType } from "@clokr/db";
import {
  BS_BLOCK_WEEKLY_DEFAULT_MIN,
  BS_DAILY_DEFAULT_MIN,
} from "./vocational-school-constants.js";

/**
 * Tenant-config fields this helper reads. Both are optional/nullable to fail-open
 * (missing TenantConfig row → use coded defaults that match the schema @default).
 */
export interface VocationalSchoolTenantConfig {
  vocationalSchoolMinutesPerDay?: number | null;
  vocationalSchoolBlockMinutesPerWeek?: number | null;
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
      type: AbsenceType.VOCATIONAL_SCHOOL,
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
): Promise<number> {
  const { start, next } = dateRangeUtc(date);

  const bs = await prisma.absence.findFirst({
    where: {
      employeeId,
      deletedAt: null, // CLAUDE.md soft-delete rule
      type: AbsenceType.VOCATIONAL_SCHOOL,
      startDate: { gte: start, lt: next },
    },
    select: { id: true },
  });
  if (!bs) return 0;

  const daily = tenantConfig?.vocationalSchoolMinutesPerDay ?? BS_DAILY_DEFAULT_MIN;
  const weekly = tenantConfig?.vocationalSchoolBlockMinutesPerWeek ?? BS_BLOCK_WEEKLY_DEFAULT_MIN;

  const bsDaysThisWeek = await countBsDaysInIsoWeek(prisma, employeeId, date);
  if (bsDaysThisWeek >= 5) {
    // Block-week cap: distribute `weekly` across N days so the weekly sum stays ≤ `weekly`.
    return Math.round(weekly / bsDaysThisWeek);
  }
  return daily;
}
