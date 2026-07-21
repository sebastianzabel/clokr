/**
 * Phase 76.31 Plan 03 — pure BS slot resolver unit tests.
 *
 * PURE unit test — no getTestApp / DB / MINIO needed.
 *
 * Asserts the Phase 76.31 D-02 DIVERGENCE from Phase 83: the FIRST_LONG_DAY
 * fallback resolves to the individual daily Soll (`dailySollMinutes`), NOT the
 * flat BS_DAILY_DEFAULT_MIN (480). A 38h/4-day Azubi → 570 min / 9.5h.
 *
 * Owner decision 2026-07-21 (BS-FIRST-LONG-DAY-DEFAULT-DECISION.md): the legacy
 * NOT-NULL `vocationalSchoolMinutesPerDay` @default(480) was removed from the
 * FIRST_LONG_DAY precedence chain so the individual daily Soll is the effective
 * default per §15 Abs. 2 Nr. 2 BBiG. A flat pauschal is still possible via an
 * explicit `bsSlotFirstLongDayMinutes` override.
 */
import { describe, it, expect } from "vitest";
import type { ScheduleType } from "@clokr/db";
import {
  buildSlotOverrideHierarchy,
  resolveBsTagSlot,
  type SlotLayerInputs,
  type WeekContext,
} from "../utils/bs-slot-resolver";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** All four bsSlot* fields null. */
const NULL_SLOTS = {
  bsSlotFirstLongDayMinutes: null,
  bsSlotSecondLongDayMinutes: null,
  bsSlotShortDayMinutes: null,
  bsSlotBlockWeekMinutes: null,
};

/** Build inputs with everything null except the daily Soll (the 38h/4-day case = 570). */
function makeInputs(overrides: Partial<SlotLayerInputs> = {}): SlotLayerInputs {
  return {
    employee: null,
    pattern: null,
    tenantConfig: {
      ...NULL_SLOTS,
      vocationalSchoolMinutesPerDay: null,
      vocationalSchoolBlockMinutesPerWeek: null,
    },
    dailySollMinutes: 570, // 38h * 60 / 4 workdays = 570 min = 9.5h
    ...overrides,
  };
}

/** A normal (non-block) week with a single BS day. */
function singleDayWeek(): WeekContext {
  return { bsDatesInWeek: ["2026-07-21"], isBlockWeek: false };
}

const SHIFT_BASED: ScheduleType = "SHIFT_BASED";

// ── FIRST_LONG_DAY daily-Soll divergence ─────────────────────────────────────

describe("buildSlotOverrideHierarchy — FIRST_LONG_DAY daily-Soll fallback (D-02)", () => {
  it("all overrides null → firstLongDayMinutes falls through to dailySollMinutes (570, NOT 480)", () => {
    const h = buildSlotOverrideHierarchy(makeInputs({ dailySollMinutes: 570 }));
    expect(h.firstLongDayMinutes).toBe(570);
    expect(h.firstLongDayMinutes).not.toBe(480);
  });

  it("Employee.bsSlotFirstLongDayMinutes wins over the daily-Soll fallback", () => {
    const h = buildSlotOverrideHierarchy(
      makeInputs({
        employee: { ...NULL_SLOTS, bsSlotFirstLongDayMinutes: 600 },
        dailySollMinutes: 570,
      }),
    );
    expect(h.firstLongDayMinutes).toBe(600);
  });

  it("Pattern override wins over TenantConfig + daily-Soll", () => {
    const h = buildSlotOverrideHierarchy(
      makeInputs({
        pattern: { ...NULL_SLOTS, bsSlotFirstLongDayMinutes: 510 },
        dailySollMinutes: 570,
      }),
    );
    expect(h.firstLongDayMinutes).toBe(510);
  });

  it("legacy vocationalSchoolMinutesPerDay does NOT drive FIRST_LONG_DAY → daily Soll wins (§15 Abs. 2 Nr. 2 BBiG)", () => {
    // §15 Abs. 2 Nr. 2 BBiG (BVaDiG-2024): the FIRST BS-Langtag credits the
    // "durchschnittliche tägliche Ausbildungszeit" = individual daily Soll, NOT a
    // flat pauschal. The legacy NOT-NULL @default(480) column MUST NOT shadow the
    // daily Soll (owner decision 2026-07-21, BS-FIRST-LONG-DAY-DEFAULT-DECISION.md).
    // With bsSlot* null and a schedule whose daily Soll ≠ 480 (here 570), the
    // resolver must fall through to the individual daily Soll — layer 4 dropped.
    const h = buildSlotOverrideHierarchy(
      makeInputs({
        tenantConfig: {
          ...NULL_SLOTS,
          vocationalSchoolMinutesPerDay: 480,
          vocationalSchoolBlockMinutesPerWeek: null,
        },
        dailySollMinutes: 570,
      }),
    );
    expect(h.firstLongDayMinutes).toBe(570);
    expect(h.firstLongDayMinutes).not.toBe(480);
  });

  it("explicit bsSlotFirstLongDayMinutes override STILL wins over legacy + daily-Soll (layer 3 intact)", () => {
    // A tenant that WANTS a flat pauschal must set it explicitly on the slot field.
    const h = buildSlotOverrideHierarchy(
      makeInputs({
        tenantConfig: {
          ...NULL_SLOTS,
          bsSlotFirstLongDayMinutes: 480,
          vocationalSchoolMinutesPerDay: 999,
          vocationalSchoolBlockMinutesPerWeek: null,
        },
        dailySollMinutes: 570,
      }),
    );
    expect(h.firstLongDayMinutes).toBe(480);
  });

  it("TenantConfig.bsSlotFirstLongDayMinutes wins over legacy + daily-Soll", () => {
    const h = buildSlotOverrideHierarchy(
      makeInputs({
        tenantConfig: {
          ...NULL_SLOTS,
          bsSlotFirstLongDayMinutes: 540,
          vocationalSchoolMinutesPerDay: 480,
          vocationalSchoolBlockMinutesPerWeek: null,
        },
        dailySollMinutes: 570,
      }),
    );
    expect(h.firstLongDayMinutes).toBe(540);
  });
});

// ── resolveBsTagSlot ─────────────────────────────────────────────────────────

describe("resolveBsTagSlot — slot classification + credited minutes", () => {
  it("ordinal 1, no block week → FIRST_LONG_DAY = daily Soll 570 (NOT 480)", () => {
    const h = buildSlotOverrideHierarchy(makeInputs({ dailySollMinutes: 570 }));
    const r = resolveBsTagSlot(new Date("2026-07-21"), 1, singleDayWeek(), h, SHIFT_BASED);
    expect(r.slotType).toBe("FIRST_LONG_DAY");
    expect(r.creditedMinutes).toBe(570);
    expect(r.contributesToExpected).toBe(true);
  });

  it("ordinal 2 → SECOND_LONG_DAY, credited = configured (300); unconfigured → daily Soll (§15, NOT 0)", () => {
    const week: WeekContext = {
      bsDatesInWeek: ["2026-07-20", "2026-07-21"],
      isBlockWeek: false,
    };
    const configured = buildSlotOverrideHierarchy(
      makeInputs({ employee: { ...NULL_SLOTS, bsSlotSecondLongDayMinutes: 300 } }),
    );
    const rConfigured = resolveBsTagSlot(new Date("2026-07-21"), 2, week, configured, SHIFT_BASED);
    expect(rConfigured.slotType).toBe("SECOND_LONG_DAY");
    expect(rConfigured.creditedMinutes).toBe(300);

    // Phase 76.34 (D-02/D-09, Option A): an UNCONFIGURED 2nd BS-Langtag defaults to
    // the individual daily Soll per §15 Abs. 2 BBiG — NOT netto 0 (which was rechtswidrig
    // and inverted the legal hierarchy vs. the FIRST_LONG_DAY = daily Soll credit).
    const nullH = buildSlotOverrideHierarchy(makeInputs({ dailySollMinutes: 570 }));
    const rNull = resolveBsTagSlot(new Date("2026-07-21"), 2, week, nullH, SHIFT_BASED);
    expect(rNull.slotType).toBe("SECOND_LONG_DAY");
    expect(rNull.creditedMinutes).toBe(570);
    expect(rNull.creditedMinutes).not.toBe(0);
  });

  it("ordinal 3 → SHORT_DAY, credited = configured (180); unconfigured → daily Soll (§15, NOT 0)", () => {
    const week: WeekContext = {
      bsDatesInWeek: ["2026-07-20", "2026-07-21", "2026-07-22"],
      isBlockWeek: false,
    };
    const configured = buildSlotOverrideHierarchy(
      makeInputs({ employee: { ...NULL_SLOTS, bsSlotShortDayMinutes: 180 } }),
    );
    const rConfigured = resolveBsTagSlot(new Date("2026-07-22"), 3, week, configured, SHIFT_BASED);
    expect(rConfigured.slotType).toBe("SHORT_DAY");
    expect(rConfigured.creditedMinutes).toBe(180);

    // Phase 76.34 (D-02/D-09, Option A): an UNCONFIGURED Kurztag defaults to the
    // individual daily Soll per §15 Abs. 2 BBiG — NOT netto 0.
    const nullH = buildSlotOverrideHierarchy(makeInputs({ dailySollMinutes: 570 }));
    const rNull = resolveBsTagSlot(new Date("2026-07-22"), 3, week, nullH, SHIFT_BASED);
    expect(rNull.slotType).toBe("SHORT_DAY");
    expect(rNull.creditedMinutes).toBe(570);
    expect(rNull.creditedMinutes).not.toBe(0);
  });

  it("isBlockWeek true, 5 BS days, blockWeekMinutes=2400 → BLOCK_WEEK = 480 (2400/5), wins over ordinal", () => {
    const week: WeekContext = {
      bsDatesInWeek: ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"],
      isBlockWeek: true,
    };
    const h = buildSlotOverrideHierarchy(
      makeInputs({
        tenantConfig: {
          ...NULL_SLOTS,
          vocationalSchoolMinutesPerDay: null,
          vocationalSchoolBlockMinutesPerWeek: 2400,
        },
      }),
    );
    // Even ordinal 1 must resolve to BLOCK_WEEK, not FIRST_LONG_DAY.
    const r = resolveBsTagSlot(new Date("2026-07-20"), 1, week, h, SHIFT_BASED);
    expect(r.slotType).toBe("BLOCK_WEEK");
    expect(r.creditedMinutes).toBe(480);
  });

  it("ordinal clamped defensively: 0 → FIRST_LONG_DAY, out-of-range high → SHORT_DAY", () => {
    const week: WeekContext = {
      bsDatesInWeek: ["2026-07-20", "2026-07-21", "2026-07-22"],
      isBlockWeek: false,
    };
    const h = buildSlotOverrideHierarchy(makeInputs({ dailySollMinutes: 570 }));
    const low = resolveBsTagSlot(new Date("2026-07-20"), 0, week, h, SHIFT_BASED);
    expect(low.slotType).toBe("FIRST_LONG_DAY");
    const high = resolveBsTagSlot(new Date("2026-07-22"), 99, week, h, SHIFT_BASED);
    expect(high.slotType).toBe("SHORT_DAY");
  });
});

// ── contributesToExpected (D-04) ─────────────────────────────────────────────

describe("resolveBsTagSlot — contributesToExpected (Phase 63 D-04)", () => {
  it("false only for MONTHLY_HOURS", () => {
    const h = buildSlotOverrideHierarchy(makeInputs({ dailySollMinutes: 570 }));
    const monthly = resolveBsTagSlot(
      new Date("2026-07-21"),
      1,
      singleDayWeek(),
      h,
      "MONTHLY_HOURS",
    );
    expect(monthly.contributesToExpected).toBe(false);
  });

  it("true for SHIFT_BASED and FIXED_SCHEDULE", () => {
    const h = buildSlotOverrideHierarchy(makeInputs({ dailySollMinutes: 570 }));
    const shift = resolveBsTagSlot(new Date("2026-07-21"), 1, singleDayWeek(), h, "SHIFT_BASED");
    expect(shift.contributesToExpected).toBe(true);
    const fixed = resolveBsTagSlot(new Date("2026-07-21"), 1, singleDayWeek(), h, "FIXED_SCHEDULE");
    expect(fixed.contributesToExpected).toBe(true);
  });
});
