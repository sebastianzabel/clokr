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
      "Für Personen unter 18 Jahren gelten bei den Pausen die Regeln nach § 11 JArbSchG (30 / 60 Min).",
    );
    expect(DETAIL).toContain("Unter 18 — Pausen nach § 11 JArbSchG");
    expect(DETAIL).toContain('"30 Min — nach § 11 JArbSchG"');
    expect(DETAIL).toContain('"60 Min — nach § 11 JArbSchG"');
    expect(DETAIL).not.toMatch(/JArbSchG\s*§\s*9|§\s*9\s*JArbSchG/);
  });
});
