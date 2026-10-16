/**
 * Issue #595 (D-05, P-06) — the demo seed states only true things about closed months.
 *
 * `packages/db` cannot import `apps/api`, so the seed owns a pinned copy of `monthRangeUtc`
 * (`packages/db/src/demo-month-bounds.ts`). This file is the drift test for that copy and the
 * source-level pin of what `seed-demo.ts` writes (the seed module runs a whole seed on import
 * and is never loaded here, like `tenant-provisioning-88.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoMonthRangeUtc } from "../../../../packages/db/src/demo-month-bounds";
import { monthRangeUtc } from "../../src/contexts/working-time-account/timezone";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const ZONES = ["Europe/Berlin", "UTC", "America/New_York", "Asia/Kolkata"] as const;

/** Every month 2024-01 .. 2027-12 (48 months). */
function months(): Array<{ year: number; month: number }> {
  const result: Array<{ year: number; month: number }> = [];
  for (let year = 2024; year <= 2027; year++) {
    for (let month = 1; month <= 12; month++) result.push({ year, month });
  }
  return result;
}

describe("demoMonthRangeUtc — drift against monthRangeUtc (P-06, T-595-16)", () => {
  it("walks a non-empty case set (48 months x 4 zones)", () => {
    expect(months()).toHaveLength(48);
    expect(ZONES).toHaveLength(4);
  });

  for (const tz of ZONES) {
    it(`equals monthRangeUtc for every month 2024-01..2027-12 in ${tz}`, () => {
      let checked = 0;
      for (const { year, month } of months()) {
        const pinned = demoMonthRangeUtc(year, month, tz);
        const real = monthRangeUtc(year, month, tz);
        expect(pinned.start.toISOString(), `${tz} ${year}-${month} start`).toBe(
          real.start.toISOString(),
        );
        expect(pinned.end.toISOString(), `${tz} ${year}-${month} end`).toBe(real.end.toISOString());
        checked++;
      }
      expect(checked).toBe(48);
    });
  }
});

/** The text of the balanced-paren call that starts at `needle`. */
function callAt(source: string, needle: string, from = 0): string {
  const start = source.indexOf(needle, from);
  expect(start, `no ${needle} in the seed module`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf("(", start); i < source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${needle} call`);
}

describe("seed-demo.ts — no fabricated closed month (D-05)", () => {
  const source = readFileSync(join(REPO_ROOT, "packages/db/src/seed-demo.ts"), "utf8");

  it("has exactly one saldoSnapshot create, with bounds from demoMonthRangeUtc and literal zero figures", () => {
    const first = source.indexOf("saldoSnapshot.create(");
    expect(first, "no saldoSnapshot.create( call").toBeGreaterThan(-1);
    expect(
      source.indexOf("saldoSnapshot.create(", first + 1),
      "more than one snapshot create",
    ).toBe(-1);
    const call = callAt(source, "saldoSnapshot.create(");
    expect(call).toMatch(/periodType:\s*"MONTHLY"/);
    expect(call).toMatch(/periodStart:\s*\w+\.start\b/);
    expect(call).toMatch(/periodEnd:\s*\w+\.end\b/);
    expect(call).toMatch(/workedMinutes:\s*0\s*,/);
    expect(call).toMatch(/expectedMinutes:\s*0\s*,/);
    expect(call).toMatch(/balanceMinutes:\s*0\s*,/);
    expect(call).toMatch(/carryOver:\s*0\s*,/);
    expect(call).toMatch(/superseded:\s*false/);
  });

  it("derives the bounds through the pinned copy with the demo time zone", () => {
    expect(source).toMatch(/import\s*\{\s*demoMonthRangeUtc\s*\}\s*from\s*"\.\/demo-month-bounds"/);
    expect(source).toMatch(/demoMonthRangeUtc\(/);
    expect(source).toMatch(/const DEMO_TZ = "Europe\/Berlin"/);
  });

  it("no longer declares the invented per-employee balances or the weekday x 8 h Soll", () => {
    expect(source).not.toMatch(/snapDelta/);
    expect(source).not.toMatch(/workdaysExpected/);
    expect(source).not.toMatch(/Monatsabschluss \(Demo\)/);
  });

  it("writes the previous month's entries unlocked — the real closer locks them", () => {
    const calls = source
      .split("\n")
      .filter((line) => line.includes("genEntries(handle, prevFrom, prevTo"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/,\s*false\)/);
  });
});
