// Phase 64 Plan 02 — Pure helper unit tests for getEffectiveBreakDuration (D-04, BREAK-03).
//
// No DB, no Prisma. Pure function tests that lock in the precedence rules from
// CONTEXT.md D-04 + the boundary semantics inherited from the previously hard-coded
// auto-break logic in time-entries.ts. Together with auto-break.test.ts these guard
// BREAK-08 (behavior preservation) — if any of these change, tenants who never edited
// their config would see a behavior change, which is a regression.

import { describe, it, expect } from "vitest";
import {
  ARBZG_FLOOR_OVER_6H,
  ARBZG_FLOOR_OVER_9H,
  BREAK_MAX_OVER_6H,
  BREAK_MAX_OVER_9H,
} from "../utils/break-constants";
import { getEffectiveBreakDuration } from "../utils/break-effective";

const TENANT = { defaultBreakOver6h: 30, defaultBreakOver9h: 45 };
const NO_OVERRIDE = { breakOver6hOverride: null, breakOver9hOverride: null };

describe("break-constants", () => {
  it("ARBZG_FLOOR_OVER_6H === 30 (ArbZG §4 Pflichtpause)", () => {
    expect(ARBZG_FLOOR_OVER_6H).toBe(30);
  });
  it("ARBZG_FLOOR_OVER_9H === 45 (ArbZG §4 Pflichtpause)", () => {
    expect(ARBZG_FLOOR_OVER_9H).toBe(45);
  });
  it("BREAK_MAX_OVER_6H === 120 (sane upper bound, 2h)", () => {
    expect(BREAK_MAX_OVER_6H).toBe(120);
  });
  it("BREAK_MAX_OVER_9H === 180 (sane upper bound, 3h)", () => {
    expect(BREAK_MAX_OVER_9H).toBe(180);
  });
});

describe("getEffectiveBreakDuration", () => {
  // ── Tenant-default path (no override) ──────────────────────────────────────

  it("returns 0 when work duration is 0", () => {
    expect(getEffectiveBreakDuration(NO_OVERRIDE, TENANT, 0)).toBe(0);
  });

  it("returns 0 at exactly 6h (boundary is strict `> 6*60`)", () => {
    expect(getEffectiveBreakDuration(NO_OVERRIDE, TENANT, 360)).toBe(0);
  });

  it("returns tenant default (30) at 361 min (just over 6h)", () => {
    expect(getEffectiveBreakDuration(NO_OVERRIDE, TENANT, 361)).toBe(30);
  });

  it("returns tenant default (30) at exactly 9h (still 6h bucket; > 9*60 is strict)", () => {
    expect(getEffectiveBreakDuration(NO_OVERRIDE, TENANT, 540)).toBe(30);
  });

  it("returns tenant default (45) at 541 min (just over 9h)", () => {
    expect(getEffectiveBreakDuration(NO_OVERRIDE, TENANT, 541)).toBe(45);
  });

  it("returns tenant default (45) for a long shift (12h)", () => {
    expect(getEffectiveBreakDuration(NO_OVERRIDE, TENANT, 12 * 60)).toBe(45);
  });

  // ── Override path (one side only) ──────────────────────────────────────────

  it("6h override wins for 6h bucket (8h work)", () => {
    expect(
      getEffectiveBreakDuration(
        { breakOver6hOverride: 60, breakOver9hOverride: null },
        TENANT,
        480,
      ),
    ).toBe(60);
  });

  it("9h override wins for 9h bucket (10h work)", () => {
    expect(
      getEffectiveBreakDuration(
        { breakOver6hOverride: null, breakOver9hOverride: 90 },
        TENANT,
        600,
      ),
    ).toBe(90);
  });

  it("6h override does NOT bleed into the 9h bucket (only 9h override or tenant 9h default applies)", () => {
    // 10h work, only 6h override set → fall through to tenant 9h default (45)
    expect(
      getEffectiveBreakDuration(
        { breakOver6hOverride: 60, breakOver9hOverride: null },
        TENANT,
        600,
      ),
    ).toBe(45);
  });

  it("9h override does NOT bleed into the 6h bucket (only 6h override or tenant 6h default applies)", () => {
    // 8h work, only 9h override set → fall through to tenant 6h default (30)
    expect(
      getEffectiveBreakDuration(
        { breakOver6hOverride: null, breakOver9hOverride: 90 },
        TENANT,
        480,
      ),
    ).toBe(30);
  });

  // ── Both overrides set ─────────────────────────────────────────────────────

  it("both overrides set: 6h override picked in 6h bucket", () => {
    expect(
      getEffectiveBreakDuration({ breakOver6hOverride: 60, breakOver9hOverride: 90 }, TENANT, 480),
    ).toBe(60);
  });

  it("both overrides set: 9h override picked in 9h bucket", () => {
    expect(
      getEffectiveBreakDuration({ breakOver6hOverride: 60, breakOver9hOverride: 90 }, TENANT, 600),
    ).toBe(90);
  });

  it("both overrides set: returns 0 for ≤ 6h work regardless of overrides", () => {
    expect(
      getEffectiveBreakDuration(
        { breakOver6hOverride: 60, breakOver9hOverride: 90 },
        TENANT,
        300, // 5h
      ),
    ).toBe(0);
  });

  // ── Tenant defaults differ from ArbZG floor (custom tenant config) ────────

  it("returns custom tenant default (e.g., 45 for >6h via tariff agreement)", () => {
    expect(
      getEffectiveBreakDuration(
        NO_OVERRIDE,
        { defaultBreakOver6h: 45, defaultBreakOver9h: 60 },
        480,
      ),
    ).toBe(45);
  });

  it("returns custom tenant default for 9h bucket", () => {
    expect(
      getEffectiveBreakDuration(
        NO_OVERRIDE,
        { defaultBreakOver6h: 45, defaultBreakOver9h: 60 },
        600,
      ),
    ).toBe(60);
  });
});
