import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * a11y gate for Phase 70 (DEVOPS-V8-05), made real by Phase 275 / Issue #275 (D-08).
 * Scoped to the LOGIN page only (public, no auth) — full authenticated-page
 * coverage requires the docker-compose webServer: from Phase 73.
 *
 * This assertion CAN fail (`toEqual([])`). The `axe-scan` CI job itself remains
 * `continue-on-error: true` (`.github/workflows/ci.yml:602`) — a failure here is
 * visible in the job log and run summary, but does not turn the PR check red.
 * That gap was raised to the owner as Phase 275 Plan 02's checkpoint; do not read
 * a green PR check as proof this spec passed.
 */
test.describe("axe a11y scan — public pages", () => {
  test("login page has no WCAG 2 A/AA violations", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    // Log violations for diagnosability — the assertion below fails on any non-empty
    // violation list, so this listing is what makes a red run actionable.
    if (accessibilityScanResults.violations.length > 0) {
      console.warn(
        `[axe-scan] Found ${accessibilityScanResults.violations.length} a11y violations on /login:`,
      );
      for (const v of accessibilityScanResults.violations) {
        console.warn(`  - [${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`);
      }
    }

    // Real assertion (Phase 275 / Issue #275, D-08). Measured on 2026-09-21 against the
    // same server shape CI scans (built apps/web, served on :4173): 0 violations.
    expect(accessibilityScanResults.violations).toEqual([]);
  });
});
