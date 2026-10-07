// Issue #495 — pins that both month-card pages pass `noSollTarget` to MonatSaldoCard and set it
// only for a MONTHLY_HOURS contract without monthly hours.
//
// This is a source-read PIN, not a behaviour test: route pages cannot be mounted here because
// `apps/web/vitest.config.ts` has no `$app` alias. Without the pin, a page that stops passing the
// prop would silently render the old "—" figure (the card default is false) with no failing test.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGES = [
  {
    name: "/time-entries",
    source: readRouteFile(
      "../routes/(app)/time-entries/+page.svelte",
      "src/routes/(app)/time-entries/+page.svelte",
    ),
  },
  {
    name: "/team/time-entries",
    source: readRouteFile(
      "../routes/(app)/team/time-entries/+page.svelte",
      "src/routes/(app)/team/time-entries/+page.svelte",
    ),
  },
];

describe.each(PAGES)("month card no-Soll wiring — $name", ({ source }) => {
  it("reads a non-empty page source", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("passes noSollTarget from monthMetrics to <MonatSaldoCard>", () => {
    const start = source.indexOf("<MonatSaldoCard");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("onRetry={loadAll}", start);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("noSollTarget={monthMetrics.noSollTarget}");
  });

  it("sets noSollTarget: true exactly once, inside the no-monthly-target branch", () => {
    const occurrences = source.split("noSollTarget: true").length - 1;
    expect(occurrences).toBe(1);

    const branchStart = source.indexOf("if (isMonthlyHours && !hasMonthlyTarget) {");
    expect(branchStart).toBeGreaterThan(-1);
    const branchEnd = source.indexOf("if (hasMonthlyTarget) {", branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);

    const at = source.indexOf("noSollTarget: true");
    expect(at).toBeGreaterThan(branchStart);
    expect(at).toBeLessThan(branchEnd);
  });
});
