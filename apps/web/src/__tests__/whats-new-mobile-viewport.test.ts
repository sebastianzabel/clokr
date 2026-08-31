// Phase 110-07 checkpoint fix (orchestrator live-acceptance, mobile viewport) — the auto-opening
// What's-New drawer covered the "Einstempeln" button on a phone (measured live at 390x844: drawer
// w=359/h=844, `elementFromPoint()` on the button's centre resolved into `aside.whats-new`;
// `clockInReachable: false`). Decision: below the app's mobile breakpoint, the drawer must not
// AUTO-open; manual opening (the version-line dot) stays available everywhere.
//
// Two halves of proof, split by what's actually mountable:
//
// 1. The DECISION FUNCTION (`isMobileViewport()`, apps/web/src/lib/utils/viewport.ts) is a real
//    outcome test against `window.innerWidth` — see viewport.test.ts. That is the genuinely
//    testable seam.
// 2. The WIRING in `(app)/+layout.svelte` cannot be mounted in this workspace — it imports
//    `$app/navigation`, and `apps/web/vitest.config.ts` declares no `$app` alias (established
//    precedent: nav-guard.test.ts, layout-boundaries.test.ts both read this same file as source
//    for exactly this reason). This file follows that precedent: it pins that the effect actually
//    calls `isMobileViewport()`, in the correct position (after the existing unread check, before
//    the open call), so the tested decision function is provably load-bearing in the real effect
//    and not just sitting unused nearby.
//
// Manual opening is proven with a REAL mount (MobileMoreSheet.svelte has no `$app` import) at a
// simulated phone width, clicking the version-line button exactly as a user would in the "Mehr"
// sheet — showing the manual entry point is not collateral damage from this fix.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { whatsNewOpen } from "$stores/release-notes";
import { versionStore } from "$stores/version";

vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

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

describe("(app)/+layout.svelte auto-open effect — mobile-viewport gate (source-read pin)", () => {
  it("imports isMobileViewport from $lib/utils/viewport", () => {
    expect(APP_LAYOUT).toContain('import { isMobileViewport } from "$lib/utils/viewport"');
  });

  function effectBody(): string {
    const start = APP_LAYOUT.indexOf("$effect(() => {");
    const end = APP_LAYOUT.indexOf("});", start);
    return APP_LAYOUT.slice(start, end);
  }

  it("calls isMobileViewport() exactly once inside the auto-open effect", () => {
    const body = effectBody();
    expect((body.match(/isMobileViewport\(\)/g) ?? []).length).toBe(1);
  });

  it("checks isMobileViewport() AFTER the existing unread check and BEFORE opening the drawer", () => {
    const body = effectBody();
    const iUnread = body.indexOf("hasUnreadReleaseNotes");
    const iMobile = body.indexOf("isMobileViewport()");
    const iOpen = body.indexOf("whatsNewOpen.set(true)");
    expect(iUnread).toBeGreaterThan(-1);
    expect(iMobile).toBeGreaterThan(iUnread);
    expect(iOpen).toBeGreaterThan(iMobile);
  });

  it("does not gate autoOpened itself on the viewport — only skips the open+latch this tick", () => {
    // The early return for isMobileViewport() must precede the `autoOpened = true` write, so a
    // mobile session that never opens automatically never falsely marks itself as having done so.
    const body = effectBody();
    const iMobileReturn = body.indexOf("if (isMobileViewport()) return;");
    const iLatch = body.indexOf("autoOpened = true;");
    expect(iMobileReturn).toBeGreaterThan(-1);
    expect(iLatch).toBeGreaterThan(iMobileReturn);
  });

  it("the desktop path is unchanged: only ONE new early-return line was added to the effect", () => {
    // Regression guard for "desktop auto-open must still work" (prove-it #3): the fix must be a
    // single additive early-return, not a restructuring of the existing unread/latch checks.
    const body = effectBody();
    const returns = body.match(/if \(.*?\) return;/g) ?? [];
    expect(returns).toEqual([
      "if (autoOpened) return;",
      "if (!$hasUnreadReleaseNotes) return;",
      "if (isMobileViewport()) return;",
    ]);
  });
});

describe("Manual opening at phone width is not collateral damage (prove-it #2)", () => {
  afterEach(() => {
    whatsNewOpen.set(false);
    versionStore.set("");
  });

  it("clicking the version-line button in MobileMoreSheet still opens the drawer while window.innerWidth is at phone width", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      value: 390,
      configurable: true,
      writable: true,
    });

    try {
      versionStore.set("1.9.18");
      const { default: MobileMoreSheet } =
        await import("$lib/components/layout/MobileMoreSheet.svelte");
      renderWithTheme(MobileMoreSheet, { open: true, items: [], currentPath: "/dashboard" });

      expect(whatsNewOpen).toBeDefined();
      let open = false;
      whatsNewOpen.subscribe((v) => (open = v))();
      expect(open).toBe(false);

      await fireEvent.click(screen.getByLabelText("Was ist neu in Version 1.9.18"));

      whatsNewOpen.subscribe((v) => (open = v))();
      expect(open).toBe(true);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        value: originalWidth,
        configurable: true,
        writable: true,
      });
    }
  });
});
