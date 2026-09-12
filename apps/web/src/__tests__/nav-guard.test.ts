// Phase 109 (Issue #35, D-12 / AK-07) — the unsaved-changes navigation guard.
//
// Why source reads, not mounts: routes and layout components aren't mountable in this
// workspace (no `$app` alias in apps/web/vitest.config.ts) — see layout-boundaries.test.ts
// (Phase 127) for the established precedent this file follows (same `readRouteFile` shape).

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

const TOPBAR = readRouteFile(
  "../lib/components/layout/Topbar.svelte",
  "src/lib/components/layout/Topbar.svelte",
);
const SIDEBAR = readRouteFile(
  "../lib/components/layout/Sidebar.svelte",
  "src/lib/components/layout/Sidebar.svelte",
);
const APP_LAYOUT = readRouteFile(
  "../routes/(app)/+layout.svelte",
  "src/routes/(app)/+layout.svelte",
);
const CLIENT = readRouteFile("../lib/api/client.ts", "src/lib/api/client.ts");

describe("N-08/AK-07 — every logout path clears the unsaved registry before it navigates", () => {
  const SITES = [
    { name: "Topbar", src: TOPBAR, nav: 'goto("/login")' },
    { name: "Sidebar", src: SIDEBAR, nav: 'goto("/login")' },
    { name: "inactivity timeout", src: APP_LAYOUT, nav: 'goto("/login?reason=timeout")' },
  ] as const;

  it.each(SITES)("$name calls clearUnsaved() before $nav", ({ src, nav }) => {
    const iClear = src.indexOf("clearUnsaved()");
    const iNav = src.indexOf(nav);
    expect(iClear).toBeGreaterThan(-1);
    expect(iNav).toBeGreaterThan(-1);
    expect(iClear).toBeLessThan(iNav);
  });

  it("client.ts clears before BOTH window.location.href logouts", () => {
    const clears = CLIENT.split("clearUnsaved()").length - 1;
    const redirects = CLIENT.split('window.location.href = "/login"').length - 1;
    expect(redirects).toBe(2);
    expect(clears).toBe(2);
    // positional: each clear precedes its own redirect
    for (const chunk of CLIENT.split('window.location.href = "/login"').slice(0, 2)) {
      expect(chunk.lastIndexOf("clearUnsaved()")).toBeGreaterThan(-1);
    }
  });

  it.each([
    { name: "Topbar.svelte", src: TOPBAR },
    { name: "Sidebar.svelte", src: SIDEBAR },
    { name: "+layout.svelte", src: APP_LAYOUT },
    { name: "client.ts", src: CLIENT },
  ])("$name imports clearUnsaved from $stores/unsaved", ({ src }) => {
    expect(src).toContain("clearUnsaved");
    expect(src).toContain("$stores/unsaved");
  });
});

describe("D-12/AK-07 — the navigation guard", () => {
  it("registers beforeNavigate exactly once", () => {
    expect((APP_LAYOUT.match(/beforeNavigate\(/g) ?? []).length).toBe(1);
  });

  it("N-07: the callback is synchronous — no await inside it", () => {
    const body = APP_LAYOUT.slice(
      APP_LAYOUT.indexOf("beforeNavigate((navigation)"),
      APP_LAYOUT.indexOf("function discardAndLeave"),
    );
    expect(body).not.toContain("await");
    expect(body).not.toContain("async");
  });

  it("returns early when nothing is unsaved, before it can cancel", () => {
    const body = APP_LAYOUT.slice(
      APP_LAYOUT.indexOf("beforeNavigate((navigation)"),
      APP_LAYOUT.indexOf("function discardAndLeave"),
    );
    expect(body.indexOf("if (!hasUnsaved()) return;")).toBeLessThan(
      body.indexOf("navigation.cancel()"),
    );
  });

  it("clears the registry BEFORE re-issuing the navigation", () => {
    const body = APP_LAYOUT.slice(
      APP_LAYOUT.indexOf("function discardAndLeave"),
      APP_LAYOUT.indexOf("function keepEditing"),
    );
    expect(body.indexOf("clearUnsaved()")).toBeLessThan(body.indexOf("goto(target)"));
  });

  it("N-06: uses ConfirmDialog, never window.confirm", () => {
    expect(APP_LAYOUT).toContain("<ConfirmDialog");
    expect(APP_LAYOUT).not.toContain("window.confirm");
  });

  it("asks in German with the agreed wording", () => {
    expect(APP_LAYOUT).toContain("Ungespeicherte Änderungen verwerfen?");
  });

  it("the dialog sits outside the view ErrorBoundary, after CommandPalette", () => {
    expect(APP_LAYOUT.indexOf("</ErrorBoundary>")).toBeLessThan(
      APP_LAYOUT.indexOf("<ConfirmDialog"),
    );
    expect(APP_LAYOUT.indexOf("<CommandPalette")).toBeLessThan(
      APP_LAYOUT.indexOf("<ConfirmDialog"),
    );
  });
});
