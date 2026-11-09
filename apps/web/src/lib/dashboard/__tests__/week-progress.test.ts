// Issue #451 (D-06) — FLEXTIME "Diese Woche Soll" tile compares worked and Soll through
// yesterday (issue #438), not the whole-week pair.
//
// describe A: pure behaviour of weekProgressDelta(), no DOM.
// describe B: source-level proof that the dashboard page computes the tile's delta via
//   weekProgressDelta(stats.week) and no longer subtracts targetHours from workedHours inline —
//   apps/web/vitest.config.ts registers no `$app/*` alias and the page imports `$app/*` directly,
//   so mounting it is not possible here (same wall clock-out-result.test.ts's describe C
//   documents).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { weekProgressDelta } from "../week-progress";

describe("weekProgressDelta — D-06: the to-date pair when present, else the legacy whole-week delta", () => {
  it("A1: both to-date fields present -> uses the to-date pair (workedToDateHours - targetToDateHours)", () => {
    const delta = weekProgressDelta({
      workedHours: 19,
      targetHours: 32,
      workedToDateHours: 15,
      targetToDateHours: 16,
    });
    expect(delta).toBe(-1);
  });

  it("A2: no to-date fields -> legacy degrade (workedHours - targetHours)", () => {
    const delta = weekProgressDelta({ workedHours: 0, targetHours: 40 });
    expect(delta).toBe(-40);
  });

  it("A3: rounds to 2 decimals", () => {
    const delta = weekProgressDelta({
      workedHours: 0,
      targetHours: 0,
      workedToDateHours: 10.333,
      targetToDateHours: 10,
    });
    expect(delta).toBe(0.33);
  });

  it("A4: only ONE to-date field present -> legacy degrade (both must be present together)", () => {
    const delta = weekProgressDelta({
      workedHours: 19,
      targetHours: 32,
      workedToDateHours: 15,
    });
    expect(delta).toBe(19 - 32);
  });
});

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../../../routes/(app)/dashboard/+page.svelte",
  "src/routes/(app)/dashboard/+page.svelte",
);

// Owner acceptance #845 (09.11.2026, prototype v5): the „Diese Woche“ cell reads „worked / Soll ·
// n Tage geplant“ and shows no delta line any more. The pins therefore guard that no delta is
// computed on the page at all — and never from the whole-week pair (D-06's defect).
describe("dashboard +page.svelte source pin — no week delta on Mein Tag (#845), never the whole-week pair", () => {
  it("B1: the page source is loaded (anti-vacuity) and shows the week cell", () => {
    expect(PAGE.length).toBeGreaterThan(50_000);
    expect(PAGE).toContain('label: "Diese Woche"');
  });

  it("B2: no week delta is derived on the page (a delta, if it returns, goes through weekProgressDelta)", () => {
    expect(PAGE).not.toMatch(/stats\.week\.workedToDateHours|stats\.week\.targetToDateHours/);
    expect(PAGE).not.toMatch(/weekDiff/);
  });

  it("B3: the page no longer subtracts targetHours from workedHours inline for the week delta", () => {
    expect(PAGE).not.toMatch(/stats\.week\.workedHours\s*-\s*stats\.week\.targetHours/);
  });
});
