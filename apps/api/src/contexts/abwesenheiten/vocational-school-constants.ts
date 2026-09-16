/**
 * Numeric defaults + thresholds for vocational-school (Berufsschule) logic.
 *
 * D-02: Per-tenant defaults stored in TenantConfig.vocationalSchoolMinutesPerDay
 *       and TenantConfig.vocationalSchoolBlockMinutesPerWeek. Constants below
 *       MUST match the @default(...) values in packages/db/prisma/schema.prisma
 *       so a fail-open lookup (missing TenantConfig row) yields identical behavior.
 *
 * D-10: 225 = 5 UStd * 45 min. JArbSchG §9 Abs. 1 Nr. 2 ceiling for AZUBI < 18 on a BS-day.
 */
export const BS_DAILY_DEFAULT_MIN = 480;
export const BS_BLOCK_WEEKLY_DEFAULT_MIN = 2400;
export const JARBSCHG_MAX_WORK_ON_BS_DAY_MIN = 225;
export const JARBSCHG_MINOR_AGE_THRESHOLD = 18;

// Tenant-config range bounds (D-02 server-side validation).
// Re-exported here so the settings Zod schema (Plan 03) has a single source of truth.
export const BS_DAILY_MIN_BOUND = 240; // 4h
export const BS_DAILY_MAX_BOUND = 600; // 10h, ArbZG-compatible
export const BS_BLOCK_WEEKLY_MIN_BOUND = 1200; // 20h
export const BS_BLOCK_WEEKLY_MAX_BOUND = 3000; // 50h

// Phase 76.31 — JArbSchG §9 slot-aware long-day threshold.
// 225 = 5 UStd × 45 min. A SECOND_LONG_DAY / SHORT_DAY slot counts as a "long day"
// (JArbSchG §9 hard-block relevant) only when its credited minutes exceed this.
export const JARBSCHG_LONG_DAY_INSTRUCTION_MIN = 225;
