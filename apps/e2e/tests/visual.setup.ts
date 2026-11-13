import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

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

/** Resolves once every web font the page asked for has loaded (never throws on a navigation race). */
async function waitForWebFonts(page: Page): Promise<void> {
  await page
    .evaluate(() => document.fonts.ready)
    .catch(() => {
      /* page may have navigated */
    });
}

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
        await waitForWebFonts(page);
      });
      // #842 (Q1 step 7, A3): a screenshot must never capture the Figtree fallback, so every
      // navigation of a visual test resolves only after the self-hosted web fonts have loaded.
      const goto = page.goto.bind(page);
      page.goto = async (...args: Parameters<typeof goto>) => {
        const response = await goto(...args);
        await waitForWebFonts(page);
        return response;
      };
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };
