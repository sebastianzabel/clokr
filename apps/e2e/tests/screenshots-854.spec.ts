/**
 * Issue #854 (AC-9, D-854-17) - the acceptance screenshots of the migrated Verwalten pages.
 *
 * NON-GATING. There is no pixel assertion: the spec writes one full-page PNG per page and viewport
 * to `test-results/screenshots-854/dev-<slug>-<width>.png`, and the CI job `screenshots-854`
 * uploads that directory as the artifact `screenshots-854` next to the prototype for the human
 * comparison. It runs in the Playwright project `screenshots` only and skips itself unless
 * `CAPTURE_854=1`, so no other run ever produces files.
 *
 * Pages: apps/e2e/fixtures/verwalten-854-pages.json (shared with verwalten-854.spec.ts). Viewports:
 * 1440 x 900 and 390 x 844. A detail page with tabs is captured on its first tab only (the tab is
 * the page's default view; the gating spec visits the others).
 *
 * Data: the throwaway fixture tenant of the CI stack and synthetic names (no seed, no real names,
 * T-854-06), so the PNGs contain nothing personal. The browser clock is fixed (the visual project's
 * anchor date) so dates in the pages are stable between runs.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "../fixtures";
import { ANCHOR_DATE } from "../fixtures/visual-seed";
import {
  MIGRATED_PAGES,
  openPage,
  resolvePage,
  settle,
  signInAsTenantAdmin,
} from "../helpers/verwalten-854";

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

const OUT_DIR = resolve(__dirname, "../test-results/screenshots-854");

test.skip(process.env.CAPTURE_854 !== "1", "capture runs only in the screenshots-854 CI job");

test.describe.configure({ mode: "parallel", timeout: 120_000 });

for (const entry of MIGRATED_PAGES) {
  for (const viewport of VIEWPORTS) {
    test(`capture ${entry.slug} at ${viewport.width} px`, async ({ page, request, tenant }) => {
      mkdirSync(OUT_DIR, { recursive: true });
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
      await page.setViewportSize(viewport);
      // The same fixed clock as the visual project: date fields and "today" markers do not move.
      await page.clock.install({ time: new Date(ANCHOR_DATE) });
      await signInAsTenantAdmin(page, request, tenant);
      const { url } = await resolvePage(request, tenant, entry);
      await openPage(page, url);
      await settle(page);
      await page.screenshot({
        path: resolve(OUT_DIR, `dev-${entry.slug}-${viewport.width}.png`),
        fullPage: true,
      });
    });
  }
}
