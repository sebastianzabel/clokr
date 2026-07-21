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
    /**
     * Legacy Phase 63 pauschal. As of owner decision 2026-07-21 this is NO LONGER
     * consumed by the FIRST_LONG_DAY chain (it shadowed the §15 daily Soll). Kept in
     * the interface for call-site compatibility; only a value passed via
     * bsSlotFirstLongDayMinutes (layer 3) can now drive a flat FIRST credit.
     */
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
 * Walks the Employee > Pattern > TenantConfig > daily-Soll chain to produce a
 * resolved hierarchy. Pure function (no Prisma).
 *
 * FIRST_LONG_DAY precedence (highest to lowest):
 *   1. Employee.bsSlotFirstLongDayMinutes  (per-MA override — BBIG-V19-03)
 *   2. Pattern.bsSlotFirstLongDayMinutes   (per-pattern override — BBIG-V19-02)
 *   3. TenantConfig.bsSlotFirstLongDayMinutes  (tenant-level config — BBIG-V19-01)
 *   4. inputs.dailySollMinutes  ← DEFAULT: the individual daily Soll per §15 Abs. 2
 *      Nr. 2 BBiG ("durchschnittliche tägliche Ausbildungszeit"), NOT the flat
 *      BS_DAILY_DEFAULT_MIN (480). A 38h/4-day Azubi gets 570 min, a 38h/5-day Azubi
 *      456 min. Only the 40h/5-day case coincidentally equals 480.
 *
 * Owner decision 2026-07-21 (BS-FIRST-LONG-DAY-DEFAULT-DECISION.md): the legacy
 * NOT-NULL `vocationalSchoolMinutesPerDay` @default(480) was REMOVED from this chain.
 * As a NOT-NULL column it always shadowed the daily Soll, silently re-flattening the
 * §15-mandated individual credit to the pre-2020 pauschal (abolished by BVaDiG). A
 * tenant that genuinely wants a flat pauschal must set it explicitly via
 * `bsSlotFirstLongDayMinutes` (layer 3) — surfaced in the Config-UI (Phases 76.35-37).
 *
 * BLOCK_WEEK precedence (unchanged from Phase 83): Employee > Pattern > TenantConfig >
 *   vocationalSchoolBlockMinutesPerWeek > BS_BLOCK_WEEKLY_DEFAULT_MIN (2400).
 *
 * SECOND_LONG_DAY and SHORT_DAY: explicit config wins, else the individual daily
 * Soll (`inputs.dailySollMinutes`). Owner decision 2026-07-21 (Phase 76.34, D-02/D-09,
 * Option A): per §15 Abs. 2 BBiG the 2nd BS-Langtag and the Kurztag are credited the
 * "durchschnittliche tägliche Ausbildungszeit" (= individual daily Soll) by default.
 * The prior `?? 0` under-credited these slots (rechtswidrig) and inverted the legal
 * hierarchy vs. the FIRST_LONG_DAY = daily Soll credit. Explicit Employee/Pattern/
 * TenantConfig `bsSlot*` overrides still win. This mirrors the FIRST_LONG_DAY chain.
 */
export function buildSlotOverrideHierarchy(inputs: SlotLayerInputs): SlotOverrideHierarchy {
  const { employee, pattern, tenantConfig } = inputs;

  const firstLongDayMinutes =
    employee?.bsSlotFirstLongDayMinutes ??
    pattern?.bsSlotFirstLongDayMinutes ??
    tenantConfig.bsSlotFirstLongDayMinutes ??
    inputs.dailySollMinutes; // §15 Abs. 2 Nr. 2 BBiG: individual daily Soll is the default (NOT flat 480)

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
          inputs.dailySollMinutes // §15 Abs. 2 BBiG: default = individual daily Soll (NOT 0)
        );
      }
      // SHORT_DAY
      return (
        employee?.bsSlotShortDayMinutes ??
        pattern?.bsSlotShortDayMinutes ??
        tenantConfig.bsSlotShortDayMinutes ??
        inputs.dailySollMinutes // §15 Abs. 2 BBiG: default = individual daily Soll (NOT 0)
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

  // FIRST_LONG_DAY: credit from firstLongDayMinutes (hierarchy layers 1-4,
  // default = individual daily Soll per §15 Abs. 2 Nr. 2 BBiG).
  if (clampedOrdinal === 1) {
    return {
      slotType: "FIRST_LONG_DAY",
      creditedMinutes: hierarchy.firstLongDayMinutes,
      contributesToExpected,
    };
  }

  // SECOND_LONG_DAY (ordinal 2) or SHORT_DAY (ordinal 3+): netto from explicit config,
  // else the individual daily Soll (§15 Abs. 2 BBiG default — Phase 76.34).
  const slotType: "SECOND_LONG_DAY" | "SHORT_DAY" =
    clampedOrdinal === 2 ? "SECOND_LONG_DAY" : "SHORT_DAY";

  return {
    slotType,
    creditedMinutes: hierarchy.nettoMinutes(slotType),
    contributesToExpected,
  };
}
