// Phase 104-10 dev-pass fix — regression test for the blocking defect found during
// Task 4 owner verification: switching the leave form's "Art der Abwesenheit" away
// from VACATION and back threw `TypeError: Cannot read properties of undefined
// (reading 'length')` because one of two mapping call sites omitted
// `section9Movements`. See ../vacation-balance.ts for the full root-cause writeup.
//
// Same convention as apps/web/src/lib/leave/__tests__/storno.test.ts: plain-function
// tests, no component mount, because vacation-balance.ts is a pure, dependency-free
// module by design.

import { describe, it, expect } from "vitest";
import {
  mapVacationBalance,
  resolveAdjustmentBadge,
  type VacationEntitlementRow,
  type LastDaysAdjustment,
} from "../vacation-balance";

/** Same formula `leave/+page.svelte`'s own `vacRemaining` `$derived` uses — kept local to this
 * test (not imported from the mapper, which deliberately does NOT compute it, per D-13/UI-SPEC
 * "Verfügbar keeps its current formula untouched") so the "unchanged for identical inputs"
 * assertion below is a genuine regression guard, not a tautology against the same code path. */
function available(b: { total: number; carryOver: number; used: number }): number {
  return b.total + b.carryOver - b.used;
}

const baseRow: VacationEntitlementRow = {
  typeCode: "VACATION",
  leaveType: { name: "Urlaub" },
  totalDays: 30,
  usedDays: 3,
  carriedOverDays: 5,
  effectiveCarryOverDays: 5,
  carryOverDeadline: "2027-03-31",
};

describe("mapVacationBalance", () => {
  it("returns null for undefined input (no VACATION entitlement row found)", () => {
    expect(mapVacationBalance(undefined)).toBeNull();
  });

  it("defaults section9Movements to [] when the API response omits the field entirely", () => {
    // This is the exact shape that used to reach the template as `undefined` via the
    // second (loadBalanceForType) call site before this fix — `.length` on it threw.
    const result = mapVacationBalance(baseRow);
    expect(result).not.toBeNull();
    expect(result?.section9Movements).toEqual([]);
    // The specific regression: this must never throw.
    expect(() => result?.section9Movements.length).not.toThrow();
  });

  it("passes through a populated section9Movements array unchanged", () => {
    const movement = {
      creditId: "cred-1",
      days: 2,
      from: "2026-09-09",
      to: "2026-09-10",
      label: "+2 Tage gutgeschrieben (§ 9 BUrlG, Krankheit 09.09.–10.09.)",
    };
    const result = mapVacationBalance({ ...baseRow, section9Movements: [movement] });
    expect(result?.section9Movements).toEqual([movement]);
  });

  it("maps totals, used days and carry-over consistently regardless of section9Movements presence", () => {
    const withMovements = mapVacationBalance({
      ...baseRow,
      section9Movements: [{ creditId: "c1", days: 1, from: null, to: null, label: "x" }],
    });
    const withoutMovements = mapVacationBalance(baseRow);
    expect(withMovements?.total).toBe(withoutMovements?.total);
    expect(withMovements?.used).toBe(withoutMovements?.used);
    expect(withMovements?.carryOver).toBe(withoutMovements?.carryOver);
    expect(withMovements?.carryOverDeadline).toBe(withoutMovements?.carryOverDeadline);
  });

  it("falls back to carriedOverDays when effectiveCarryOverDays is nullish", () => {
    const result = mapVacationBalance({
      ...baseRow,
      effectiveCarryOverDays: undefined as unknown as number,
      carriedOverDays: 7,
    });
    expect(result?.carryOver).toBe(7);
  });

  // ── Phase 107-07 (D-12/D-13): provisionalUsed ───────────────────────────────────────────
  describe("provisionalUsed", () => {
    it("defaults to 0 when the API response omits provisionalUsedDays entirely (pre-107-07 shape)", () => {
      const result = mapVacationBalance(baseRow);
      expect(result?.provisionalUsed).toBe(0);
      // This is exactly what drives the template's `{#if vacationBalance.provisionalUsed > 0}`
      // to omit the "Verbraucht (vorläufig)" row entirely — a reader with no provisional
      // consumption sees a card indistinguishable from before this phase (UI-SPEC §4/§UI
      // Considerations "overflow"). Not asserted by mounting the component (that would
      // restructure it for testability, which the plan forbids) — the conditional itself is a
      // one-line, directly-legible `{#if}` gated on this exact field.
    });

    it("carries a populated provisionalUsedDays through as provisionalUsed", () => {
      const result = mapVacationBalance({ ...baseRow, provisionalUsedDays: 2 });
      expect(result?.provisionalUsed).toBe(2);
    });

    it("computes the D-12 'Verbraucht (bestätigt)' value as used − provisionalUsed", () => {
      const result = mapVacationBalance({ ...baseRow, usedDays: 5, provisionalUsedDays: 2 })!;
      expect(result.used - result.provisionalUsed).toBe(3);
    });

    it("D-13: usedDays already counts provisional days at full value — used is NOT reduced by provisionalUsed", () => {
      const withProvisional = mapVacationBalance({
        ...baseRow,
        usedDays: 5,
        provisionalUsedDays: 2,
      });
      const withoutProvisional = mapVacationBalance({ ...baseRow, usedDays: 5 });
      expect(withProvisional?.used).toBe(5);
      expect(withProvisional?.used).toBe(withoutProvisional?.used);
    });

    it("leaves 'Verfügbar' (available) unchanged from the pre-107-07 value for identical total/carryOver/used inputs — adding provisionalUsedDays alone must not move it", () => {
      const before = mapVacationBalance(baseRow)!; // no provisionalUsedDays field at all
      const after = mapVacationBalance({ ...baseRow, provisionalUsedDays: 2 })!; // same total/used/carryOver
      expect(available(after)).toBe(available(before));
    });
  });
});

// ── Phase 107-07 (D-19/D-21): resolveAdjustmentBadge ──────────────────────────────────────
// Same "pure function, no component mount" convention as mapVacationBalance above — shared by
// both leave/+page.svelte and team/leave/+page.svelte, so the up/down decision is tested once.
describe("resolveAdjustmentBadge", () => {
  it("returns null when there was never an adjustment", () => {
    expect(resolveAdjustmentBadge(null)).toBeNull();
    expect(resolveAdjustmentBadge(undefined)).toBeNull();
  });

  it("resolves the upward variant as the D-21 prominent badge: badge-yellow, bold, ▲, + sign", () => {
    const adjustment: LastDaysAdjustment = {
      oldDays: 3,
      newDays: 5,
      direction: "up",
      at: "2026-08-27T14:36:00.000Z",
    };
    const badge = resolveAdjustmentBadge(adjustment)!;
    expect(badge.direction).toBe("up");
    expect(badge.badgeClass).toBe("badge badge-yellow");
    expect(badge.icon).toBe("▲");
    expect(badge.bold).toBe(true);
    expect(badge.delta).toBe(2);
  });

  it("resolves the downward variant as the D-21 quiet badge: badge-gray, not bold, ▼", () => {
    const adjustment: LastDaysAdjustment = {
      oldDays: 5,
      newDays: 3,
      direction: "down",
      at: "2026-08-27T14:36:00.000Z",
    };
    const badge = resolveAdjustmentBadge(adjustment)!;
    expect(badge.direction).toBe("down");
    expect(badge.badgeClass).toBe("badge badge-gray");
    expect(badge.icon).toBe("▼");
    expect(badge.bold).toBe(false);
    expect(badge.delta).toBe(2);
  });

  it("delta is always positive, regardless of direction", () => {
    const up = resolveAdjustmentBadge({
      oldDays: 1,
      newDays: 4,
      direction: "up",
      at: "2026-01-05T00:00:00.000Z",
    })!;
    const down = resolveAdjustmentBadge({
      oldDays: 4,
      newDays: 1,
      direction: "down",
      at: "2026-01-05T00:00:00.000Z",
    })!;
    expect(up.delta).toBe(3);
    expect(down.delta).toBe(3);
  });

  it("builds the fixed-shape tooltip with exactly the three UI-SPEC §3 interpolated values", () => {
    const badge = resolveAdjustmentBadge({
      oldDays: 5,
      newDays: 3,
      direction: "down",
      at: "2026-08-27T14:36:00.000Z",
    })!;
    expect(badge.tooltip).toBe("Alt: 5 Tage → Neu: 3 Tage · Auslöser: Roster-Planung · 27.08.2026");
  });

  it("formats a date-only 'at' string (no time component) identically to a full ISO datetime", () => {
    const fromDateOnly = resolveAdjustmentBadge({
      oldDays: 1,
      newDays: 2,
      direction: "up",
      at: "2026-03-01",
    })!;
    const fromDateTime = resolveAdjustmentBadge({
      oldDays: 1,
      newDays: 2,
      direction: "up",
      at: "2026-03-01T09:15:00.000Z",
    })!;
    expect(fromDateOnly.tooltip).toBe(fromDateTime.tooltip);
  });
});
