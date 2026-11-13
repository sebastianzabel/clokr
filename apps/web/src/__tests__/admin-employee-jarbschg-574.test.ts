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
// Since Issue #854 (plan 854-22) the Pausendauer group is VertragOverrides; the decision itself is
// the pure `isUnder18` of overrides-form.ts.
const OVERRIDES = readRouteFile(
  "../lib/components/employees/detail/VertragOverrides.svelte",
  "src/lib/components/employees/detail/VertragOverrides.svelte",
);
const OVERRIDES_MODEL = readRouteFile(
  "../lib/employees/overrides-form.ts",
  "src/lib/employees/overrides-form.ts",
);
// Since Issue #854 (plan 854-20) the birth date field lives in the Person tab.
const PERSON_TAB = readRouteFile(
  "../lib/components/employees/detail/PersonTab.svelte",
  "src/lib/components/employees/detail/PersonTab.svelte",
);

describe("Issue #574 — § 11 JArbSchG for every person under 18", () => {
  it("[vacuity gate] the override component and the model are loaded", () => {
    expect(OVERRIDES.length).toBeGreaterThan(5_000);
    expect(OVERRIDES_MODEL.length).toBeGreaterThan(3_000);
    expect(PERSON_TAB.length).toBeGreaterThan(5_000);
    expect(OVERRIDES).toContain('data-testid="pausendauer-over6h"');
  });

  it("decides „under 18“ from the birth date alone, never from the classification", () => {
    // #854: the Vertrag tab follows the SAVED birth day of the record (the Person tab saves it).
    const match = /(?:let|const) under18 = \$derived\(([\s\S]*?)\);/.exec(OVERRIDES);
    expect(match, "no under18 derived").not.toBeNull();
    const expression = match?.[1] ?? "";
    expect(expression).toContain("birthDate");
    expect(expression).not.toMatch(/classification|AZUBI/i);
    expect(OVERRIDES).not.toContain("isAzubiUnder18");
    const rule = OVERRIDES_MODEL.slice(OVERRIDES_MODEL.indexOf("export function isUnder18"));
    expect(rule.slice(0, rule.indexOf("\n}"))).not.toMatch(/classification|AZUBI/i);
    // the page decides nothing about it any more
    expect(DETAIL).not.toContain("isUnder18");
  });

  it("gates the pill, the suggestion and both placeholders on the under-18 rule", () => {
    expect(OVERRIDES).toContain("{#if under18}");
    expect(OVERRIDES).toContain("canEdit && under18 && bothPauseEmpty");
    expect(OVERRIDES.split("placeholder={under18").length - 1).toBe(2);
  });

  it("names § 11 JArbSchG in the hint, the pill and the placeholders — never § 9", () => {
    expect(PERSON_TAB.replace(/\s+/g, " ")).toContain(
      "Für Personen unter 18 Jahren gelten bei den Pausen die Regeln nach § 11 JArbSchG: mehr als 4,5 Stunden 30 Min, mehr als 6 Stunden 60 Min.",
    );
    expect(OVERRIDES).toContain("Unter 18 — Pausen nach § 11 JArbSchG");
    // § 11 Abs. 1: 60 Min above 6 h — the ">6h" and the ">9h" placeholder both say 60 (review WR-05)
    expect(OVERRIDES.split('"60 Min — nach § 11 JArbSchG"').length - 1).toBe(2);
    expect(OVERRIDES).not.toContain('"30 Min — nach § 11 JArbSchG"');
    expect(OVERRIDES_MODEL).toMatch(
      /UNDER_18_PAUSE[^=]*=\s*\{\s*breakOver6hOverride: 60,\s*breakOver9hOverride: 60,\s*\}/,
    );
    for (const source of [OVERRIDES, OVERRIDES_MODEL, PERSON_TAB]) {
      expect(source).not.toMatch(/JArbSchG\s*§\s*9|§\s*9\s*JArbSchG/);
    }
  });
});
