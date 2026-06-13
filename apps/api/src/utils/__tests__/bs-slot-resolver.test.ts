import { describe, it, expect } from "vitest";
import {
  resolveBsTagSlot,
  buildSlotOverrideHierarchy,
  type WeekContext,
  type SlotLayerInputs,
} from "../bs-slot-resolver.js";
import {
  BS_DAILY_DEFAULT_MIN,
  BS_BLOCK_WEEKLY_DEFAULT_MIN,
} from "../vocational-school-constants.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const baseTenantConfig: SlotLayerInputs["tenantConfig"] = {
  bsSlotFirstLongDayMinutes: null,
  bsSlotSecondLongDayMinutes: null,
  bsSlotShortDayMinutes: null,
  bsSlotBlockWeekMinutes: null,
  vocationalSchoolMinutesPerDay: 480,
  vocationalSchoolBlockMinutesPerWeek: 2400,
};

const emptyOverride = {
  bsSlotFirstLongDayMinutes: null,
  bsSlotSecondLongDayMinutes: null,
  bsSlotShortDayMinutes: null,
  bsSlotBlockWeekMinutes: null,
};

/**
 * Returns N sequential YYYY-MM-DD strings starting from Monday 2026-06-15 (ISO week 25).
 */
function isoWeekMonTo(n: number): string[] {
  // ISO week 2026-25 starts Mon 2026-06-15
  const base = new Date("2026-06-15T00:00:00Z");
  const dates: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Phase 83 — Wave-0 scaffold. Plan 02 fills in these tests against the
// resolver pure function. Listed here so every later <verify> command
// points to an existing file (Nyquist compliance per VALIDATION.md).
describe("resolveBsTagSlot — Phase 83 BBiG §15 Abs.2 slot resolver", () => {
  describe("4-layer hierarchy (BBIG-V19-02 / BBIG-V19-03)", () => {
    it("Employee.bsSlotFirstLongDayMinutes wins over Pattern + TenantConfig + fallback", () => {
      const hierarchy = buildSlotOverrideHierarchy({
        employee: { ...emptyOverride, bsSlotFirstLongDayMinutes: 540 },
        pattern: { ...emptyOverride, bsSlotFirstLongDayMinutes: 450 },
        tenantConfig: { ...baseTenantConfig, bsSlotFirstLongDayMinutes: 420 },
      });
      expect(hierarchy.firstLongDayMinutes).toBe(540);
    });

    it("Pattern.bsSlotFirstLongDayMinutes wins over TenantConfig + fallback when Employee=null", () => {
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: { ...emptyOverride, bsSlotFirstLongDayMinutes: 450 },
        tenantConfig: { ...baseTenantConfig, bsSlotFirstLongDayMinutes: 420 },
      });
      expect(hierarchy.firstLongDayMinutes).toBe(450);
    });

    it("TenantConfig.bsSlotFirstLongDayMinutes wins over vocationalSchoolMinutesPerDay fallback when Employee=Pattern=null", () => {
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: {
          ...baseTenantConfig,
          bsSlotFirstLongDayMinutes: 420,
          vocationalSchoolMinutesPerDay: 480,
        },
      });
      expect(hierarchy.firstLongDayMinutes).toBe(420);
    });

    it("All null → falls back to vocationalSchoolMinutesPerDay (legacy default 480)", () => {
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: {
          ...baseTenantConfig,
          bsSlotFirstLongDayMinutes: null,
          vocationalSchoolMinutesPerDay: 480,
        },
      });
      expect(hierarchy.firstLongDayMinutes).toBe(480);
    });

    it("All null AND vocationalSchoolMinutesPerDay missing → BS_DAILY_DEFAULT_MIN hard-coded 480", () => {
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: {
          bsSlotFirstLongDayMinutes: null,
          bsSlotSecondLongDayMinutes: null,
          bsSlotShortDayMinutes: null,
          bsSlotBlockWeekMinutes: null,
          vocationalSchoolMinutesPerDay: null,
          vocationalSchoolBlockMinutesPerWeek: null,
        },
      });
      expect(hierarchy.firstLongDayMinutes).toBe(BS_DAILY_DEFAULT_MIN);
      expect(hierarchy.blockWeekMinutes).toBe(BS_BLOCK_WEEKLY_DEFAULT_MIN);
    });
  });

  describe("Slot-index determinism (BBIG-V19-04, PITFALLS CD-2)", () => {
    it("date ASC sort: Monday BS-Tag → ordinalInWeek 1 → FIRST_LONG_DAY regardless of DB insertion order", () => {
      const dates = isoWeekMonTo(1);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      const slot = resolveBsTagSlot(
        new Date(`${dates[0]}T00:00:00Z`),
        1,
        wc,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(slot.slotType).toBe("FIRST_LONG_DAY");
      expect(slot.creditedMinutes).toBe(480);
    });

    it("Two BS-Tage in ISO week: earlier = FIRST_LONG_DAY, later = SECOND_LONG_DAY", () => {
      const dates = isoWeekMonTo(2);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      const first = resolveBsTagSlot(
        new Date(`${dates[0]}T00:00:00Z`),
        1,
        wc,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      const second = resolveBsTagSlot(
        new Date(`${dates[1]}T00:00:00Z`),
        2,
        wc,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(first.slotType).toBe("FIRST_LONG_DAY");
      expect(second.slotType).toBe("SECOND_LONG_DAY");
    });

    it("Three+ BS-Tage in ISO week (non-block): 1=FIRST, 2=SECOND, 3+=SHORT_DAY", () => {
      const dates = isoWeekMonTo(4);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      const slots = dates.map((d, i) =>
        resolveBsTagSlot(
          new Date(`${d}T00:00:00Z`),
          i + 1,
          wc,
          hierarchy,
          "FIXED_SCHEDULE" as never,
        ),
      );
      expect(slots[0].slotType).toBe("FIRST_LONG_DAY");
      expect(slots[1].slotType).toBe("SECOND_LONG_DAY");
      expect(slots[2].slotType).toBe("SHORT_DAY");
      expect(slots[3].slotType).toBe("SHORT_DAY");
    });

    it("Property test: shuffling bsDatesInWeek input gives identical SlotResolution per date", () => {
      const dates = isoWeekMonTo(3); // Mo, Tue, Wed
      // Caller is responsible for date-ASC sort; resolver receives sorted array.
      // Property: same sorted weekContext + same ordinal → same result on every call.
      const sorted: WeekContext = { bsDatesInWeek: [...dates].sort(), isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      const r1 = resolveBsTagSlot(
        new Date(`${dates[0]}T00:00:00Z`),
        1,
        sorted,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      const r2 = resolveBsTagSlot(
        new Date(`${dates[0]}T00:00:00Z`),
        1,
        sorted,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(r1).toEqual(r2);
      expect(r1.slotType).toBe("FIRST_LONG_DAY");
      // Verify SHORT_DAY also produces deterministic results on repeated calls.
      const r3 = resolveBsTagSlot(
        new Date(`${dates[2]}T00:00:00Z`),
        3,
        sorted,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      const r4 = resolveBsTagSlot(
        new Date(`${dates[2]}T00:00:00Z`),
        3,
        sorted,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(r3).toEqual(r4);
      expect(r3.slotType).toBe("SHORT_DAY");
    });
  });

  describe("Block-week cap (BBIG-V19-04, PITFALLS CD-3)", () => {
    it("isBlockWeek true + bsDatesInWeek.length=5 → 5 × creditedMinutes = blockWeekMinutes exactly", () => {
      const dates = isoWeekMonTo(5);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: true };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: { ...baseTenantConfig, bsSlotBlockWeekMinutes: 2400 },
      });
      let total = 0;
      for (let i = 0; i < 5; i++) {
        const slot = resolveBsTagSlot(
          new Date(`${dates[i]}T00:00:00Z`),
          i + 1,
          wc,
          hierarchy,
          "FIXED_SCHEDULE" as never,
        );
        expect(slot.slotType).toBe("BLOCK_WEEK");
        total += slot.creditedMinutes;
      }
      expect(total).toBe(2400);
    });

    it("isBlockWeek true + custom blockWeekMinutes=3000 → 5 × 600 = 3000 (no overshoot)", () => {
      const dates = isoWeekMonTo(5);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: true };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: { ...baseTenantConfig, vocationalSchoolBlockMinutesPerWeek: 3000 },
      });
      let total = 0;
      for (let i = 0; i < 5; i++) {
        const slot = resolveBsTagSlot(
          new Date(`${dates[i]}T00:00:00Z`),
          i + 1,
          wc,
          hierarchy,
          "FIXED_SCHEDULE" as never,
        );
        expect(slot.slotType).toBe("BLOCK_WEEK");
        expect(slot.creditedMinutes).toBe(600);
        total += slot.creditedMinutes;
      }
      expect(total).toBe(3000);
    });

    it("isBlockWeek false + 5 BS-Tage → ordinal-based per-slot logic (not divided cap)", () => {
      const dates = isoWeekMonTo(5);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      // First day must be FIRST_LONG_DAY (pauschal), NOT BLOCK_WEEK
      const slot = resolveBsTagSlot(
        new Date(`${dates[0]}T00:00:00Z`),
        1,
        wc,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(slot.slotType).toBe("FIRST_LONG_DAY");
      expect(slot.slotType).not.toBe("BLOCK_WEEK");
    });
  });

  describe("MONTHLY_HOURS schedule (Phase 63 D-04 invariant)", () => {
    it("contributesToExpected: false for MONTHLY_HOURS regardless of slot type", () => {
      const wc: WeekContext = { bsDatesInWeek: isoWeekMonTo(1), isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      const slot = resolveBsTagSlot(
        new Date("2026-06-15T00:00:00Z"),
        1,
        wc,
        hierarchy,
        "MONTHLY_HOURS" as never,
      );
      expect(slot.contributesToExpected).toBe(false);
      expect(slot.slotType).toBe("FIRST_LONG_DAY");
      expect(slot.creditedMinutes).toBe(480);
    });

    it("contributesToExpected: true for FIXED_SCHEDULE on FIRST_LONG_DAY", () => {
      const wc: WeekContext = { bsDatesInWeek: isoWeekMonTo(1), isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      const slot = resolveBsTagSlot(
        new Date("2026-06-15T00:00:00Z"),
        1,
        wc,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(slot.contributesToExpected).toBe(true);
    });

    it("contributesToExpected: true for SHIFT_BASED on BLOCK_WEEK", () => {
      const dates = isoWeekMonTo(5);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: true };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      const slot = resolveBsTagSlot(
        new Date(`${dates[0]}T00:00:00Z`),
        1,
        wc,
        hierarchy,
        "SHIFT_BASED" as never,
      );
      expect(slot.contributesToExpected).toBe(true);
      expect(slot.slotType).toBe("BLOCK_WEEK");
    });
  });

  describe("Netto fallback for SECOND_LONG_DAY / SHORT_DAY (Open Q3 default)", () => {
    it("SECOND_LONG_DAY + bsSlotSecondLongDayMinutes=null in all layers → creditedMinutes = 0", () => {
      const dates = isoWeekMonTo(2);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig, // bsSlotSecondLongDayMinutes: null
      });
      const slot = resolveBsTagSlot(
        new Date(`${dates[1]}T00:00:00Z`),
        2,
        wc,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(slot.slotType).toBe("SECOND_LONG_DAY");
      expect(slot.creditedMinutes).toBe(0);
    });

    it("SHORT_DAY + bsSlotShortDayMinutes=270 on TenantConfig → creditedMinutes = 270", () => {
      const dates = isoWeekMonTo(3);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: { ...baseTenantConfig, bsSlotShortDayMinutes: 270 },
      });
      const slot = resolveBsTagSlot(
        new Date(`${dates[2]}T00:00:00Z`),
        3,
        wc,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(slot.slotType).toBe("SHORT_DAY");
      expect(slot.creditedMinutes).toBe(270);
    });
  });

  describe("Ordinal-out-of-bounds defense (T-83-03 security)", () => {
    it("ordinalInWeek=0 → clamped to 1 (treated as FIRST_LONG_DAY, defensive fallback)", () => {
      const wc: WeekContext = { bsDatesInWeek: isoWeekMonTo(2), isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      const slot = resolveBsTagSlot(
        new Date("2026-06-15T00:00:00Z"),
        0,
        wc,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(slot.slotType).toBe("FIRST_LONG_DAY");
    });

    it("ordinalInWeek > bsDatesInWeek.length → clamped to last index (treated as SHORT_DAY)", () => {
      const dates = isoWeekMonTo(3);
      const wc: WeekContext = { bsDatesInWeek: dates, isBlockWeek: false };
      const hierarchy = buildSlotOverrideHierarchy({
        employee: null,
        pattern: null,
        tenantConfig: baseTenantConfig,
      });
      // ordinal 99 clamped to 3 → SHORT_DAY (3rd slot in 3-day week)
      const slot = resolveBsTagSlot(
        new Date("2026-06-17T00:00:00Z"),
        99,
        wc,
        hierarchy,
        "FIXED_SCHEDULE" as never,
      );
      expect(slot.slotType).toBe("SHORT_DAY");
    });
  });
});
