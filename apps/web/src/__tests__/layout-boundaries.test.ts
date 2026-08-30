// Phase 127 (Issue #127), Task 2 — source-level regression shield for the ErrorBoundary
// PLACEMENT (D-01/D-02/D-03), not for its behaviour (that's ErrorBoundary.test.ts, plan 01).
//
// Why position, not presence: a boundary around the whole page compiles, passes every
// other check and inverts D-01 — "you can go elsewhere" becomes "you are stuck". The
// index comparison is the only thing that holds that difference in place.
//
// Why source reads, not mounts: routes aren't mountable in this workspace (no `$app`
// alias in apps/web/vitest.config.ts) — see leave-page-vocabulary.test.ts for the
// established precedent of reading route source instead.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
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

const APP_LAYOUT = readRouteFile(
  "../routes/(app)/+layout.svelte",
  "src/routes/(app)/+layout.svelte",
);
const ROOT_LAYOUT = readRouteFile("../routes/+layout.svelte", "src/routes/+layout.svelte");
const BOUNDARY = readRouteFile(
  "../lib/components/ui/ErrorBoundary.svelte",
  "src/lib/components/ui/ErrorBoundary.svelte",
);

function countErrorBoundaryOccurrences(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      count += countErrorBoundaryOccurrences(full);
    } else if (entry.endsWith(".svelte")) {
      const contents = readFileSync(full, "utf8");
      const matches = contents.match(/<ErrorBoundary/g);
      if (matches) count += matches.length;
    }
  }
  return count;
}

describe("layout boundary placement (Issue #127, D-01/D-02/D-03)", () => {
  it('(app)/+layout.svelte contains exactly one <ErrorBoundary scope="view">', () => {
    const matches = APP_LAYOUT.match(/<ErrorBoundary scope="view">/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(1);
  });

  it("navigation sits OUTSIDE the (app) boundary: Sidebar before it, BottomTabBar after it", () => {
    const iSidebar = APP_LAYOUT.indexOf("<Sidebar");
    const iBoundary = APP_LAYOUT.indexOf("<ErrorBoundary");
    const iBoundaryEnd = APP_LAYOUT.indexOf("</ErrorBoundary>");
    const iBottomBar = APP_LAYOUT.indexOf("<BottomTabBar");

    expect(iSidebar).toBeGreaterThan(-1);
    expect(iBoundary).toBeGreaterThan(-1);
    expect(iBoundaryEnd).toBeGreaterThan(-1);
    expect(iBottomBar).toBeGreaterThan(-1);

    expect(iSidebar).toBeLessThan(iBoundary);
    expect(iBoundaryEnd).toBeLessThan(iBottomBar);
  });

  it("the page content sits INSIDE the (app) boundary: <ErrorBoundary before {@render children", () => {
    const iBoundary = APP_LAYOUT.indexOf("<ErrorBoundary");
    const iChildren = APP_LAYOUT.indexOf("{@render children");
    expect(iBoundary).toBeGreaterThan(-1);
    expect(iChildren).toBeGreaterThan(-1);
    expect(iBoundary).toBeLessThan(iChildren);
  });

  it('root +layout.svelte contains exactly one <ErrorBoundary scope="app">, and <Toast is after it', () => {
    const matches = ROOT_LAYOUT.match(/<ErrorBoundary scope="app">/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(1);

    const iBoundaryEnd = ROOT_LAYOUT.indexOf("</ErrorBoundary>");
    const iToast = ROOT_LAYOUT.indexOf("<Toast");
    expect(iBoundaryEnd).toBeGreaterThan(-1);
    expect(iToast).toBeGreaterThan(-1);
    expect(iBoundaryEnd).toBeLessThan(iToast);
  });

  it("exactly two <ErrorBoundary occurrences under src/routes/ in total — no card/widget boundaries (D-03)", () => {
    const routesDir = (() => {
      try {
        return fileURLToPath(new URL("../routes", import.meta.url));
      } catch {
        return resolve(process.cwd(), "src/routes");
      }
    })();
    expect(countErrorBoundaryOccurrences(routesDir)).toBe(2);
  });

  it("D-02: the view and app message titles in ErrorBoundary.svelte are different strings, not the same message twice", () => {
    expect(BOUNDARY).toContain("Diese Ansicht konnte nicht geladen werden.");
    expect(BOUNDARY).toContain("Die Anwendung konnte nicht geladen werden.");
    expect(BOUNDARY.indexOf("Diese Ansicht konnte nicht geladen werden.")).not.toBe(
      BOUNDARY.indexOf("Die Anwendung konnte nicht geladen werden."),
    );
  });
});
