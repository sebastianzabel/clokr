// Phase 110-07 checkpoint fix (orchestrator live-acceptance, mobile viewport) — the What's-New
// drawer auto-opening on a phone covers the "Einstempeln" button (N-07's promise broken in
// OUTCOME, not mechanism; measured at 390x844: drawer w=359/h=844, `elementFromPoint()` on the
// button's centre resolved into `aside.whats-new`). Decision: below the app's existing mobile
// breakpoint, auto-open must be suppressed.
//
// `isMobileViewport()` is the extracted, genuinely testable seam for that decision. The call site
// that actually gates the auto-open effect lives in `(app)/+layout.svelte`, which cannot be
// mounted in this workspace (imports `$app/navigation`; no `$app` alias in
// `apps/web/vitest.config.ts` — see `nav-guard.test.ts`/`layout-boundaries.test.ts` for the
// established precedent). Extracting the width check into this standalone, `$app`-free module
// makes the actual OUTCOME (does the decision come out "mobile" or "desktop" at a given width)
// unit-testable against a real `window.innerWidth`, rather than only pinned by source-read.
//
// Reads `window.innerWidth`, not `matchMedia` — jsdom's `matchMedia` support is inconsistent
// across environments/polyfills, while `innerWidth` is a plain, always-present property that's
// trivial and reliable to stub per-test.
import { afterEach, describe, expect, it } from "vitest";
import { MOBILE_BREAKPOINT_PX, isMobileViewport } from "../viewport";

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

const ORIGINAL_INNER_WIDTH = window.innerWidth;

afterEach(() => {
  setInnerWidth(ORIGINAL_INNER_WIDTH);
});

describe("isMobileViewport() — Phase 110-07 checkpoint fix", () => {
  it("uses the app's existing 960px chrome breakpoint (BottomTabBar.svelte, (app)/+layout.svelte .app grid switch)", () => {
    expect(MOBILE_BREAKPOINT_PX).toBe(960);
  });

  it("is true at phone width (390px, the defect's measured viewport)", () => {
    setInnerWidth(390);
    expect(isMobileViewport()).toBe(true);
  });

  it("is true exactly AT the breakpoint (960px) — max-width semantics are inclusive", () => {
    setInnerWidth(960);
    expect(isMobileViewport()).toBe(true);
  });

  it("is false just above the breakpoint (961px)", () => {
    setInnerWidth(961);
    expect(isMobileViewport()).toBe(false);
  });

  it("is false at desktop width (1512px, the checkpoint's measured desktop viewport)", () => {
    setInnerWidth(1512);
    expect(isMobileViewport()).toBe(false);
  });
});
