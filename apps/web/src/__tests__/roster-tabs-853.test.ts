// Issue #853 (D-853-04, D-853-05, D-853-13) - source pins of the two rebuilt roster tabs
// (Woche = /shifts, Hinweise = /shifts/conflicts): both are link tabs of the ONE route table, sit
// directly under the head and name their own tab as the current one. The pages import
// `$app/navigation` / fire requests on mount, so they are source-read (like shifts-salon-558).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { rosterTabs } from "$lib/nav/routes";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const WOCHE = readRouteFile(
  "../routes/(app)/shifts/+page.svelte",
  "src/routes/(app)/shifts/+page.svelte",
);
const HINWEISE = readRouteFile(
  "../routes/(app)/shifts/conflicts/+page.svelte",
  "src/routes/(app)/shifts/conflicts/+page.svelte",
);

const TAB_STRIP = /<PageTabs\b[^>]*\/>/;

describe("Dienstplan tabs - Woche and Hinweise sit on the route table's link tabs", () => {
  it("[floor] the walked sources are the real pages", () => {
    expect(WOCHE.length).toBeGreaterThan(10_000);
    expect(HINWEISE.length).toBeGreaterThan(2_000);
  });

  it("[table] the tab list offers Woche and Hinweise as routes of the Dienstplan area", () => {
    const tabs = rosterTabs(
      { permissions: ["shift:plan:ZUGEWIESEN"] },
      { availabilityEnabled: true },
    );
    const hrefs = tabs.map((t) => t.href);
    expect(hrefs).toContain("/team/dienstplan");
    expect(hrefs).toContain("/team/dienstplan/konflikte");
  });

  it("[woche] the strip is built from rosterTabs() and marks /team/dienstplan", () => {
    expect(WOCHE.match(/rosterTabs\(/g)).toHaveLength(1);
    const strip = TAB_STRIP.exec(WOCHE);
    expect(strip, "no <PageTabs … /> on the Woche page").not.toBeNull();
    expect(strip![0]).toContain("tabs={rosterTabsList}");
    expect(strip![0]).toContain('tab="/team/dienstplan"');
  });

  it("[hinweise] the strip is built from rosterTabs() and marks /team/dienstplan/konflikte", () => {
    expect(HINWEISE.match(/rosterTabs\(/g)).toHaveLength(1);
    const strip = TAB_STRIP.exec(HINWEISE);
    expect(strip, "no <PageTabs … /> on the Hinweise page").not.toBeNull();
    expect(strip![0]).toContain("tabs={rosterTabsList}");
    expect(strip![0]).toContain('tab="/team/dienstplan/konflikte"');
  });

  it("[no links] the old header links to the sibling pages are gone from Woche", () => {
    expect(WOCHE).not.toContain('href="/shifts/conflicts"');
    expect(WOCHE).not.toContain('href="/shifts/planning"');
  });

  it("[hinweise] the notices are one List under the section „Hinweise zur Schichtplanung“", () => {
    expect(HINWEISE).toContain('<TeamSection title="Hinweise zur Schichtplanung">');
    expect(HINWEISE).toContain('testId="shift-notice-list"');
    expect(HINWEISE).toContain('testId="shift-notice"');
    expect(HINWEISE).toContain("kind={n.kind}");
    expect(HINWEISE).toContain("{n.action.label}");
  });
});
