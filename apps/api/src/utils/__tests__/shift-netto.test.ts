/**
 * shift-netto.test.ts
 *
 * Phase 100 (OTC-04, Task 1) — pure unit pin for shift-netto.ts. No `getTestApp`, no DB, no
 * calendar dates anywhere in this file (only "HH:mm" strings). Behaviour is pinned to agree with
 * the `sumShiftNetto` closure at month-saldo.ts:390-404, which this module extracts.
 */
import { describe, it, expect } from "vitest";
import { shiftNettoMinutes, sumShiftNettoMinutes } from "../shift-netto";
import type { BreakEmployeeShape, BreakTenantConfigShape } from "../break-effective";

const NO_OVERRIDE: BreakEmployeeShape = { breakOver6hOverride: null, breakOver9hOverride: null };
const TENANT_DEFAULTS: BreakTenantConfigShape = { defaultBreakOver6h: 30, defaultBreakOver9h: 45 };

describe("shiftNettoMinutes", () => {
  it("06:00-14:00 (480 brutto), tenant defaults 30/45, no employee override -> break 30 -> netto 450", () => {
    expect(
      shiftNettoMinutes({ startTime: "06:00", endTime: "14:00" }, NO_OVERRIDE, TENANT_DEFAULTS),
    ).toBe(450);
  });

  it("08:00-14:00 (360 brutto) is exactly 6h -- STRICT > boundary means no break -> netto 360", () => {
    expect(
      shiftNettoMinutes({ startTime: "08:00", endTime: "14:00" }, NO_OVERRIDE, TENANT_DEFAULTS),
    ).toBe(360);
  });

  it("08:00-17:00 (540 brutto) is exactly 9h -- STRICT > boundary means the over-6h tier (30min) -> netto 510", () => {
    expect(
      shiftNettoMinutes({ startTime: "08:00", endTime: "17:00" }, NO_OVERRIDE, TENANT_DEFAULTS),
    ).toBe(510);
  });

  it("06:00-16:00 (600 brutto) is over 9h -> break 45 -> netto 555", () => {
    expect(
      shiftNettoMinutes({ startTime: "06:00", endTime: "16:00" }, NO_OVERRIDE, TENANT_DEFAULTS),
    ).toBe(555);
  });

  it("employee breakOver6hOverride wins over the tenant default for a 480-brutto shift -> break 15 -> netto 465", () => {
    const employee: BreakEmployeeShape = { breakOver6hOverride: 15, breakOver9hOverride: null };
    expect(
      shiftNettoMinutes({ startTime: "06:00", endTime: "14:00" }, employee, TENANT_DEFAULTS),
    ).toBe(465);
  });

  it("22:00-06:00 crosses midnight: brutto is 480 (not -960) -> netto 450", () => {
    expect(
      shiftNettoMinutes({ startTime: "22:00", endTime: "06:00" }, NO_OVERRIDE, TENANT_DEFAULTS),
    ).toBe(450);
  });

  it("08:00-08:00 (zero-length shift): brutto 0 -> contributes 0, never negative", () => {
    expect(
      shiftNettoMinutes({ startTime: "08:00", endTime: "08:00" }, NO_OVERRIDE, TENANT_DEFAULTS),
    ).toBe(0);
  });

  it("a break configured longer than the shift floors netto at 0, never negative", () => {
    // 08:00-18:00 = 600 brutto (over 9h); the employee's over-9h override (650) exceeds the shift itself.
    const employee: BreakEmployeeShape = { breakOver6hOverride: null, breakOver9hOverride: 650 };
    expect(
      shiftNettoMinutes({ startTime: "08:00", endTime: "18:00" }, employee, TENANT_DEFAULTS),
    ).toBe(0);
  });
});

describe("sumShiftNettoMinutes", () => {
  it("returns 0 for an empty list", () => {
    expect(sumShiftNettoMinutes([], NO_OVERRIDE, TENANT_DEFAULTS)).toBe(0);
  });

  it("sums the individual nettos of three shifts", () => {
    const shifts = [
      { startTime: "06:00", endTime: "14:00" }, // 480 brutto -> 450 netto
      { startTime: "08:00", endTime: "14:00" }, // 360 brutto -> 360 netto (exactly 6h, no break)
      { startTime: "06:00", endTime: "16:00" }, // 600 brutto -> 555 netto
    ];
    expect(sumShiftNettoMinutes(shifts, NO_OVERRIDE, TENANT_DEFAULTS)).toBe(450 + 360 + 555);
  });
});
