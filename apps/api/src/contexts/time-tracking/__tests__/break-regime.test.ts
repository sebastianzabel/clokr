// Issue #511 (D-02, D-05) — the regime table is the one home of the break thresholds. DB-free.
// The default regime must reproduce the expression the kernel used before the table existed, at every
// boundary: a duty applies strictly above its threshold.

import { describe, it, expect } from "vitest";
import {
  BREAK_REGIMES,
  LOWEST_BREAK_DUTY_MIN,
  breakRegimeFor,
  requiredBreakFor,
} from "../break-regime";

/** The pre-511 kernel expression, restated here only as the oracle of the sweep. */
function legacyRequired(workMin: number): number {
  return workMin > 540 ? 45 : workMin > 360 ? 30 : 0;
}

function minorRequired(workMin: number): number {
  return workMin > 360 ? 60 : workMin > 270 ? 30 : 0;
}

/** Every quarter minute of a day plus a hair around each threshold. */
function sweep(): number[] {
  const values: number[] = [];
  for (let m = 0; m <= 1440; m += 0.25) values.push(m);
  for (const edge of [270, 360, 540]) values.push(edge - 1e-9, edge, edge + 1e-9);
  return values;
}

describe("requiredBreakFor", () => {
  it("reproduces the legacy adult expression over the whole sweep", () => {
    const values = sweep();
    expect(values.length).toBeGreaterThan(5000);
    const mismatches = values.filter(
      (w) => requiredBreakFor(BREAK_REGIMES.ARBZG_4, w) !== legacyRequired(w),
    );
    expect(mismatches).toEqual([]);
  });

  it("applies the minors' bands over the whole sweep", () => {
    const mismatches = sweep().filter(
      (w) => requiredBreakFor(BREAK_REGIMES.JARBSCHG_11, w) !== minorRequired(w),
    );
    expect(mismatches).toEqual([]);
  });

  it("is strict at the thresholds", () => {
    expect(requiredBreakFor(BREAK_REGIMES.ARBZG_4, 360)).toBe(0);
    expect(requiredBreakFor(BREAK_REGIMES.ARBZG_4, 360 + 1e-9)).toBe(30);
    expect(requiredBreakFor(BREAK_REGIMES.ARBZG_4, 540)).toBe(30);
    expect(requiredBreakFor(BREAK_REGIMES.ARBZG_4, 540 + 1e-9)).toBe(45);
    expect(requiredBreakFor(BREAK_REGIMES.JARBSCHG_11, 270)).toBe(0);
    expect(requiredBreakFor(BREAK_REGIMES.JARBSCHG_11, 270 + 1e-9)).toBe(30);
  });
});

describe("regime table", () => {
  it("every regime is keyed by its own name and lists its bands highest first", () => {
    for (const [name, rules] of Object.entries(BREAK_REGIMES)) {
      expect(rules.regime).toBe(name);
      const overs = rules.thresholds.map((b) => b.overMin);
      expect([...overs].sort((a, b) => b - a)).toEqual(overs);
    }
  });

  it("the lowest duty band is derived from the table", () => {
    expect(LOWEST_BREAK_DUTY_MIN).toBe(270);
  });

  it("the minors' regime is chosen by the caller's age decision", () => {
    expect(breakRegimeFor(true)).toBe("JARBSCHG_11");
    expect(breakRegimeFor(false)).toBe("ARBZG_4");
  });
});
