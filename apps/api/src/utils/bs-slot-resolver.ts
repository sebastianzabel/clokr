/**
 * Phase 76.31 — BBiG §15 Abs.2 slot resolver (BVaDiG 2024 conformant).
 *
 * Ported verbatim from v1.9 Phase 83 (origin/main) — this module is PURE
 * (no DB access, no event-model coupling) so it is portable per D-10.
 *
 * DIVERGENCE from Phase 83 (Phase 76.31 D-02): the FIRST_LONG_DAY fallback
 * resolves to the individual **daily Soll** (`round(weeklyHours*60/workDaysPerWeek)`;
 * e.g. a 38h/4-day Azubi → 570 min / 9.5h), NOT the flat BS_DAILY_DEFAULT_MIN (480).
 * The LONG day credits the individual's daily Soll — reusing the holiday
 * `dailySollMin` pattern (timezone.ts, close-employee-month.ts:493).
 *
 * Per PITFALLS CD-2: ordinalInWeek MUST be derived by the caller from
 * bsDatesInWeek (already sorted date ASC, soft-delete-filtered). The resolver
 * itself is pure — no DB access guarantees identical results regardless of
 * concurrent soft-deletes.
 *
 * Per PITFALLS S-3: callers MUST invoke this function exactly ONCE per
 * (employeeId, date) and reuse the SlotResolution for BOTH workedMinutes and
 * expectedMinutes. Pure-function design makes accidental double-call cheap.
 */
import type { ScheduleType } from "@clokr/db";
import { BS_BLOCK_WEEKLY_DEFAULT_MIN } from "./vocational-school-constants";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SlotType = "FIRST_LONG_DAY" | "SECOND_LONG_DAY" | "SHORT_DAY" | "BLOCK_WEEK";

/**
 * Pre-loaded ISO-week context. Caller (Wave 4 adapter integration) is responsible
 * for loading bsDatesInWeek with `orderBy: { date: "asc" }` + `deletedAt: null`.
 */
export interface WeekContext {
  /** YYYY-MM-DD UTC date strings, sorted date ASC. */
  bsDatesInWeek: string[];
  /**
   * Block-week classification: bsDatesInWeek.length >= 5 (caller decides the
   * heuristic; Phase 76.31 D-05 uses bsDatesInWeek.length >= 5 alone).
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
  /**
   * Phase 76.31 D-02: individual daily Soll = round(weeklyHours*60/workDaysPerWeek).
   * The FIRST_LONG_DAY final fallback (LONG day = individual daily Soll, NOT flat 480).
   * Caller computes this from the active schedule (workDaysPerWeek = count of {day}Hours > 0),
   * mirroring the holiday `dailySollMin` pattern (timezone.ts, close-employee-month.ts:493).
   */
  dailySollMinutes: number;
}

// ── Hierarchy builder ─────────────────────────────────────────────────────────

/**
 * Walks the Employee > Pattern > TenantConfig > legacy field > daily-Soll chain to
 * produce a resolved hierarchy. Pure function (no Prisma).
 *
 * FIRST_LONG_DAY precedence (highest to lowest):
 *   1. Employee.bsSlotFirstLongDayMinutes  (per-MA override — BBIG-V19-03)
 *   2. Pattern.bsSlotFirstLongDayMinutes   (per-pattern override — BBIG-V19-02)
 *   3. TenantConfig.bsSlotFirstLongDayMinutes  (tenant-level config — BBIG-V19-01)
 *   4. TenantConfig.vocationalSchoolMinutesPerDay
 *      (legacy tenant default — backward-compat with Phase 63 pauschal)
 *   5. inputs.dailySollMinutes  ← Phase 76.31 D-02 DIVERGENCE: individual daily Soll,
 *      NOT the flat BS_DAILY_DEFAULT_MIN (480). The LONG day credits the individual's
 *      daily contractual Soll so a 38h/4-day Azubi gets 570 min, not 480.
 *
 * BLOCK_WEEK precedence (unchanged from Phase 83): Employee > Pattern > TenantConfig >
 *   vocationalSchoolBlockMinutesPerWeek > BS_BLOCK_WEEKLY_DEFAULT_MIN (2400).
 *
 * SECOND_LONG_DAY and SHORT_DAY: explicit config wins, else 0. Per Phase 83,
 * the daily-Soll fallback for unconfigured second/short days is deliberately NOT
 * applied inside the resolver — it is handled at the CALLER level in Wave 3
 * (Claude's Discretion: never silently under-credit; surface as a config gap),
 * NOT here (no silent over-credit when instructionMinutes is unknown).
 */
export function buildSlotOverrideHierarchy(inputs: SlotLayerInputs): SlotOverrideHierarchy {
  const { employee, pattern, tenantConfig } = inputs;

  const firstLongDayMinutes =
    employee?.bsSlotFirstLongDayMinutes ??
    pattern?.bsSlotFirstLongDayMinutes ??
    tenantConfig.bsSlotFirstLongDayMinutes ??
    tenantConfig.vocationalSchoolMinutesPerDay ??
    inputs.dailySollMinutes; // Phase 76.31 D-02 divergence: daily Soll, NOT BS_DAILY_DEFAULT_MIN

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
 *                        defensively against out-of-bounds manipulation).
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
  // Defense: clamp ordinalInWeek to valid range [1, bsDatesInWeek.length].
  // Even if a caller passes manipulated input (0, negative, or > array length),
  // the resolver produces a defined SlotType and never panics.
  const maxOrdinal = Math.max(1, weekContext.bsDatesInWeek.length);
  const clampedOrdinal = Math.min(Math.max(1, ordinalInWeek), maxOrdinal);

  // Phase 63 D-04 invariant: MONTHLY_HOURS schedules have no daily hour target →
  // BS minutes add to workedMinutes but NOT expectedMinutes.
  const contributesToExpected = (scheduleType as string) !== "MONTHLY_HOURS";

  // Block-week branch wins over per-slot logic per PITFALLS CD-3.
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

  // FIRST_LONG_DAY: pauschal credit from firstLongDayMinutes (hierarchy layer 1-5,
  // final fallback = individual daily Soll per Phase 76.31 D-02).
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
