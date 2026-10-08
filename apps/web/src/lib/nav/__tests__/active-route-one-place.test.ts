// Issue #515 — "which navigation item is current" is decided in ONE place,
// `$lib/nav/active-route`. The rule used to exist four times (Sidebar, BottomTabBar,
// MobileMoreSheet and the (app) layout's page-label lookup) and the copies drifted apart; a
// variant that decides on its own can mark a different item than the others, which breaks
// WCAG 1.3.1 / 4.1.2 for the user who switches between the layouts.
//
// The four consumers are a fixed list, not a directory walk: a walk over a moved directory would
// pass having checked nothing. The needle is a plain substring, so comments count too.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const CONSUMERS: { name: string; fromHere: string; fromCwd: string }[] = [
  {
    name: "Sidebar.svelte",
    fromHere: "../../components/layout/Sidebar.svelte",
    fromCwd: "src/lib/components/layout/Sidebar.svelte",
  },
  {
    name: "BottomTabBar.svelte",
    fromHere: "../../components/layout/BottomTabBar.svelte",
    fromCwd: "src/lib/components/layout/BottomTabBar.svelte",
  },
  {
    name: "MobileMoreSheet.svelte",
    fromHere: "../../components/layout/MobileMoreSheet.svelte",
    fromCwd: "src/lib/components/layout/MobileMoreSheet.svelte",
  },
  {
    name: "routes/(app)/+layout.svelte",
    fromHere: "../../../routes/(app)/+layout.svelte",
    fromCwd: "src/routes/(app)/+layout.svelte",
  },
];

const MATCH_NEEDLE = "startsWith(";

function occurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe("active-route is the one place the current navigation item is decided (#515)", () => {
  it("guards exactly the four known consumers", () => {
    expect(CONSUMERS).toHaveLength(4);
  });

  for (const consumer of CONSUMERS) {
    describe(consumer.name, () => {
      const source = readSource(consumer.fromHere, consumer.fromCwd);

      it("is a non-empty source file", () => {
        expect(source.length).toBeGreaterThan(0);
      });

      it("imports the shared matcher", () => {
        expect(source).toContain('from "$lib/nav/active-route"');
      });

      it("matches no routes of its own", () => {
        expect(source).not.toContain(MATCH_NEEDLE);
      });
    });
  }

  it("the helper itself contains the one prefix comparison", () => {
    const helper = readSource("../active-route.ts", "src/lib/nav/active-route.ts");
    expect(occurrences(helper, MATCH_NEEDLE)).toBe(1);
  });
});
