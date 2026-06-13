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

/**
 * Phase 83 — Semantic alias for the 225-min instruction-minutes threshold used
 * inside `resolveBsTagSlot()` to classify SECOND_LONG_DAY / SHORT_DAY as
 * "long" based on netto instructionMinutes (JArbSchG §9 Abs.1: "mehr als
 * fünf Unterrichtsstunden von je 45 Minuten" = > 225 min).
 *
 * Same numeric value as JARBSCHG_MAX_WORK_ON_BS_DAY_MIN, kept as a separate
 * export so the resolver and jarbschg.ts intent reads clearly:
 *   - JARBSCHG_MAX_WORK_ON_BS_DAY_MIN = work-time threshold at POST /time-entries
 *   - JARBSCHG_LONG_DAY_INSTRUCTION_MIN = instruction-time threshold inside resolver
 * If the statute is amended to diverge these two, only one of them needs to move.
 */
export const JARBSCHG_LONG_DAY_INSTRUCTION_MIN = 225;

// Tenant-config range bounds (D-02 server-side validation).
// Re-exported here so the settings Zod schema (Plan 03) has a single source of truth.
export const BS_DAILY_MIN_BOUND = 240; // 4h
export const BS_DAILY_MAX_BOUND = 600; // 10h, ArbZG-compatible
export const BS_BLOCK_WEEKLY_MIN_BOUND = 1200; // 20h
export const BS_BLOCK_WEEKLY_MAX_BOUND = 3000; // 50h
