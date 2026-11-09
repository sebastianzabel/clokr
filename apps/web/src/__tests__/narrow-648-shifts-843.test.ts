// Issue #648 / #843 D-843-11 - source pin of the /shifts week header.
//
// The fix of #648 is the block: the week header of /shifts is a PeriodPicker (zoom Woche), whose nav
// row stays inside the bar on narrow screens. The page must therefore own no period arrows of its
// own. The geometry (next arrow inside the viewport at 360/390 px) is proven by the e2e of plan 843-26;
// this file only keeps the page on the block. The page imports `$app/navigation`, drag-and-drop and
// fires requests on mount, so it is source-read, like `shifts-salon-558.test.ts`.
//
// Mutation proof (843-25) - recorded here, not re-run by CI:
//   M1 a `<button class="nav-btn">` put back into the week header -> red: "[own arrows]"
//   M2 the `<PeriodPicker …>` element removed from the page -> red: "[block]"

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/shifts/+page.svelte",
  "src/routes/(app)/shifts/+page.svelte",
);

/** What the pin forbids: a page-own period arrow or the old week header nav markup. */
function ownNavMarkup(source: string): string[] {
  const found: string[] = [];
  if (/class="[^"]*\bnav-btn\b/.test(source)) found.push("nav-btn");
  if (/week-header-nav/.test(source)) found.push("week-header-nav");
  return found;
}

describe("#648 /shifts week header is the PeriodPicker block (#843 D-843-11)", () => {
  it("[floor] the walked source is the real page, not an empty read", () => {
    expect(PAGE.length).toBeGreaterThan(10_000);
  });

  it("[block] the page imports and renders PeriodPicker with the single zoom Woche", () => {
    expect(PAGE).toContain('import PeriodPicker from "$components/ui/PeriodPicker.svelte"');
    const element = /<PeriodPicker\b[\s\S]*?\/>/.exec(PAGE);
    expect(element, "no <PeriodPicker … /> element on the page").not.toBeNull();
    expect(element![0]).toContain('zooms={["woche"]}');
    expect(element![0]).toContain('testIdPrefix="shifts-week"');
  });

  it("[own arrows] the page carries no nav-btn and no week-header-nav markup of its own", () => {
    expect(ownNavMarkup(PAGE)).toEqual([]);
  });

  it("[control] positive control: a page-own arrow is reported", () => {
    const fixture = '<div class="week-header-nav"><button class="nav-btn">‹</button></div>';
    expect(ownNavMarkup(fixture)).toEqual(["nav-btn", "week-header-nav"]);
  });
});
