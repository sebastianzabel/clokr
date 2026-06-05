import { test as base, expect } from "@playwright/test";

/**
 * Phase 75 — Animation freeze for screenshot determinism.
 *
 * The CSS rule below kills every transition + animation regardless of whether
 * the component honors prefers-reduced-motion. It also disables CSS scroll
 * snapping and caret blink which would otherwise flake screenshots.
 *
 * DO NOT loosen this CSS without re-baselining all visual snapshots.
 */
const FREEZE_CSS = `
*, *::before, *::after {
  transition: none !important;
  animation: none !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
` as const;

type VisualFixtures = {
  freezeAnimations: void;
};

export const visualTest = base.extend<VisualFixtures>({
  freezeAnimations: [
    async ({ page }, use) => {
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
      await page.addInitScript(() => {
        // Disable smooth-scroll polyfills that read scroll-behavior at runtime.
        try {
          (window as unknown as { __reducedMotion?: boolean }).__reducedMotion = true;
        } catch {
          /* noop */
        }
      });
      page.on("load", async () => {
        await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {
          /* page may have navigated */
        });
      });
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };
