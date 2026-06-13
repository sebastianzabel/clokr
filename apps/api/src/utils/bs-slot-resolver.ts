/**
 * Phase 83 — BBiG §15 Abs.2 slot resolver (BVaDiG 2024 conformant).
 *
 * Per PITFALLS.md CD-1: this is the ONLY function in the codebase that reads
 * the 4-layer slot config hierarchy. A CI lint rule (Plan 05) fails any direct
 * read of TenantConfig.bsSlot* / vocationalSchoolMinutesPerDay outside this file.
 *
 * Per PITFALLS.md CD-2: ordinalInWeek MUST be derived by the caller from
 * bsDatesInWeek (already sorted date ASC, soft-delete-filtered). The resolver
 * itself is pure — no DB access guarantees identical results regardless of
 * concurrent soft-deletes.
 *
 * Per PITFALLS.md S-3: callers MUST invoke this function exactly ONCE per
 * (employeeId, date) and reuse the SlotResolution for BOTH workedMinutes and
 * expectedMinutes. Pure-function design makes accidental double-call cheap.
 */
import type { ScheduleType } from "@clokr/db";
import {
  BS_DAILY_DEFAULT_MIN,
  BS_BLOCK_WEEKLY_DEFAULT_MIN,
} from "./vocational-school-constants.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SlotType = "FIRST_LONG_DAY" | "SECOND_LONG_DAY" | "SHORT_DAY" | "BLOCK_WEEK";

/**
 * Pre-loaded ISO-week context. Caller (Plan 03 adapter integration) is responsible
 * for loading bsDatesInWeek with `orderBy: { date: "asc" }` + `deletedAt: null`.
 */
export interface WeekContext {
  /** YYYY-MM-DD UTC date strings, sorted date ASC. */
  bsDatesInWeek: string[];
  /**
   * Block-week classification: bsDatesInWeek.length >= 5 AND
   * (instructionHours >= 25 — caller decides; v1.9 known-limitation per FEATURES.md
   * Scenario E uses bsDatesInWeek.length >= 5 alone).
   */
  isBlockWeek: boolean;
}

/**
 * Pre-assembled 4-layer hierarchy. Use buildSlotOverrideHierarchy() to construct.
 * nettoMinutes is a closure so SECOND_LONG_DAY vs SHORT_DAY can pull different
 * config fields without leaking the implementation into the resolver.
 */
export interface SlotOverrideHierarchy {
  firstLongDayMinutes: number;
  blockWeekMinutes: number;
  nettoMinutes: (slotType: "SECOND_LONG_DAY" | "SHORT_DAY") => number;
}

export interface SlotResolution {
  slotType: SlotType;
  /** Minutes credited to workedMinutes (and expectedMinutes if contributesToExpected). */
  creditedMinutes: number;
  /** Phase 63 D-04 invariant: false only for MONTHLY_HOURS. */
  contributesToExpected: boolean;
}

/**
 * Layer inputs for the override hierarchy. Caller passes raw DB rows.
 */
export interface SlotLayerInputs {
  employee: {
    bsSlotFirstLongDayMinutes: number | null;
    bsSlotSecondLongDayMinutes: number | null;
    bsSlotShortDayMinutes: number | null;
    bsSlotBlockWeekMinutes: number | null;
  } | null;
  pattern: {
    bsSlotFirstLongDayMinutes: number | null;
    bsSlotSecondLongDayMinutes: number | null;
    bsSlotShortDayMinutes: number | null;
    bsSlotBlockWeekMinutes: number | null;
  } | null;
  tenantConfig: {
    bsSlotFirstLongDayMinutes: number | null;
    bsSlotSecondLongDayMinutes: number | null;
    bsSlotShortDayMinutes: number | null;
    bsSlotBlockWeekMinutes: number | null;
    vocationalSchoolMinutesPerDay: number | null;
    vocationalSchoolBlockMinutesPerWeek: number | null;
  };
}

// ── Hierarchy builder ─────────────────────────────────────────────────────────

/**
 * Walks the Employee > Pattern > TenantConfig > legacy field > hard-coded default
 * chain to produce a resolved hierarchy. Pure function (no Prisma).
 *
 * Layer precedence (highest to lowest):
 *   1. Employee.bsSlot*  (per-MA override — BBIG-V19-03)
 *   2. Pattern.bsSlot*   (per-pattern override — BBIG-V19-02)
 *   3. TenantConfig.bsSlot*  (tenant-level config — BBIG-V19-01)
 *   4. TenantConfig.vocationalSchoolMinutesPerDay / vocationalSchoolBlockMinutesPerWeek
 *      (legacy tenant default — backward-compat with Phase 63 pauschal)
 *   5. BS_DAILY_DEFAULT_MIN (480) / BS_BLOCK_WEEKLY_DEFAULT_MIN (2400)
 *      (hard-coded fallback — Pitfall 7: fail-open without DB row)
 *
 * SECOND_LONG_DAY and SHORT_DAY: explicit config wins, else 0
 * (no silent over-credit when instructionMinutes is unknown — Open Q3 RESOLVED).
 */
export function buildSlotOverrideHierarchy(inputs: SlotLayerInputs): SlotOverrideHierarchy {
  const { employee, pattern, tenantConfig } = inputs;

  const firstLongDayMinutes =
    employee?.bsSlotFirstLongDayMinutes ??
    pattern?.bsSlotFirstLongDayMinutes ??
    tenantConfig.bsSlotFirstLongDayMinutes ??
    tenantConfig.vocationalSchoolMinutesPerDay ??
    BS_DAILY_DEFAULT_MIN;

  const blockWeekMinutes =
    employee?.bsSlotBlockWeekMinutes ??
    pattern?.bsSlotBlockWeekMinutes ??
    tenantConfig.bsSlotBlockWeekMinutes ??
    tenantConfig.vocationalSchoolBlockMinutesPerWeek ??
    BS_BLOCK_WEEKLY_DEFAULT_MIN;

  return {
    firstLongDayMinutes,
    blockWeekMinutes,
    nettoMinutes(slotType: "SECOND_LONG_DAY" | "SHORT_DAY"): number {
      if (slotType === "SECOND_LONG_DAY") {
        return (
          employee?.bsSlotSecondLongDayMinutes ??
          pattern?.bsSlotSecondLongDayMinutes ??
          tenantConfig.bsSlotSecondLongDayMinutes ??
          0
        );
      }
      // SHORT_DAY
      return (
        employee?.bsSlotShortDayMinutes ??
        pattern?.bsSlotShortDayMinutes ??
        tenantConfig.bsSlotShortDayMinutes ??
        0
      );
    },
  };
}

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Pure slot resolver. Maps (date, ordinalInWeek, weekContext, hierarchy, scheduleType)
 * to a SlotResolution. No DB access. No side effects. Identical inputs → identical outputs.
 *
 * @param date            The BS-Tag date (used for future cap calc / logging).
 * @param ordinalInWeek   1-based position in weekContext.bsDatesInWeek (clamped
 *                        defensively against T-83-03 out-of-bounds manipulation).
 * @param weekContext     Pre-loaded ISO-week BS dates + block-week flag. Caller
 *                        MUST pre-sort bsDatesInWeek date ASC (PITFALLS CD-2).
 * @param hierarchy       Pre-assembled 4-layer minute config (use buildSlotOverrideHierarchy).
 * @param scheduleType    Active schedule at the date (caller resolves via resolveScheduleTypeAt).
 */
export function resolveBsTagSlot(
  date: Date,
  ordinalInWeek: number,
  weekContext: WeekContext,
  hierarchy: SlotOverrideHierarchy,
  scheduleType: ScheduleType,
): SlotResolution {
  // T-83-03 defense: clamp ordinalInWeek to valid range [1, bsDatesInWeek.length].
  // Even if a caller passes manipulated input (0, negative, or > array length),
  // the resolver produces a defined SlotType and never panics.
  const maxOrdinal = Math.max(1, weekContext.bsDatesInWeek.length);
  const clampedOrdinal = Math.min(Math.max(1, ordinalInWeek), maxOrdinal);

  // Phase 63 D-04 invariant: MONTHLY_HOURS schedules have no daily hour target →
  // BS minutes add to workedMinutes but NOT expectedMinutes.
  const contributesToExpected = (scheduleType as string) !== "MONTHLY_HOURS";

  // Block-week branch wins over per-slot logic per PITFALLS.md CD-3.
  // Distribution: Math.round(cap / N) ensures total == cap for whole-number configs.
  if (weekContext.isBlockWeek) {
    const perDay = Math.round(
      hierarchy.blockWeekMinutes / Math.max(1, weekContext.bsDatesInWeek.length),
    );
    return {
      slotType: "BLOCK_WEEK",
      creditedMinutes: perDay,
      contributesToExpected,
    };
  }

  // FIRST_LONG_DAY: pauschal credit from firstLongDayMinutes (hierarchy layer 1-5).
  if (clampedOrdinal === 1) {
    return {
      slotType: "FIRST_LONG_DAY",
      creditedMinutes: hierarchy.firstLongDayMinutes,
      contributesToExpected,
    };
  }

  // SECOND_LONG_DAY (ordinal 2) or SHORT_DAY (ordinal 3+): netto from explicit config or 0.
  const slotType: "SECOND_LONG_DAY" | "SHORT_DAY" =
    clampedOrdinal === 2 ? "SECOND_LONG_DAY" : "SHORT_DAY";

  return {
    slotType,
    creditedMinutes: hierarchy.nettoMinutes(slotType),
    contributesToExpected,
  };
}
