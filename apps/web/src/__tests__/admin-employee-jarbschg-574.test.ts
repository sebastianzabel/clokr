// Issue #574 (D-574-12) — the youth-protection hint of the employee detail page names § 11
// JArbSchG and applies to EVERY person under 18, not only to Azubis. The page is not mountable in
// the web test setup (no `$app` alias), so the wiring is pinned by source.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const DETAIL = readRouteFile(
  "../routes/(app)/admin/employees/[id]/+page.svelte",
  "src/routes/(app)/admin/employees/[id]/+page.svelte",
);

describe("Issue #574 — § 11 JArbSchG for every person under 18", () => {
  it("[vacuity gate] the employee detail page is loaded", () => {
    expect(DETAIL.length).toBeGreaterThan(100_000);
    expect(DETAIL).toContain('data-testid="pausendauer-over6h"');
  });

  it("decides „under 18“ from the birth date alone, never from the classification", () => {
    const match = /let isUnder18 = \$derived\(([\s\S]*?)\);/.exec(DETAIL);
    expect(match, "no isUnder18 derived").not.toBeNull();
    const expression = match?.[1] ?? "";
    expect(expression).toContain("eBirthDate");
    expect(expression).not.toMatch(/eClassification|AZUBI/);
    expect(DETAIL).not.toContain("isAzubiUnder18");
  });

  it("gates the pill, the suggestion and both placeholders on isUnder18", () => {
    expect(DETAIL).toContain("{#if isUnder18}");
    expect(DETAIL).toContain("isUnder18 && bothOverridesEmpty");
    expect(DETAIL.split("placeholder={isUnder18").length - 1).toBe(2);
  });

  it("names § 11 JArbSchG in the hint, the pill and the placeholders — never § 9", () => {
    expect(DETAIL.replace(/\s+/g, " ")).toContain(
      "Für Personen unter 18 Jahren gelten bei den Pausen die Regeln nach § 11 JArbSchG: mehr als 4,5 Stunden 30 Min, mehr als 6 Stunden 60 Min.",
    );
    expect(DETAIL).toContain("Unter 18 — Pausen nach § 11 JArbSchG");
    // § 11 Abs. 1: 60 Min above 6 h — the ">6h" and the ">9h" placeholder both say 60 (review WR-05)
    expect(DETAIL.split('"60 Min — nach § 11 JArbSchG"').length - 1).toBe(2);
    expect(DETAIL).not.toContain('"30 Min — nach § 11 JArbSchG"');
    expect(DETAIL).toMatch(/eBreakOver6hOverride = "60";\s*eBreakOver9hOverride = "60";/);
    expect(DETAIL).not.toMatch(/JArbSchG\s*§\s*9|§\s*9\s*JArbSchG/);
  });
});
