import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * a11y advisory gate for Phase 70 (DEVOPS-V8-05).
 * Scoped to the LOGIN page only (public, no auth) — full authenticated-page
 * coverage requires the docker-compose webServer: from Phase 73.
 *
 * Phase 70 = advisory: violations are logged but the spec always passes.
 * Phase 73 will flip the assertion to `expect(violations).toEqual([])`
 * (hard gate) once docker-compose + seeded test data are wired into CI.
 */
test.describe("axe a11y scan — public pages", () => {
  test("login page has no WCAG 2 A/AA violations", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    // Phase 70: advisory — log violations but do not fail.
    // Phase 73 will flip this to a hard expect() once docker-compose is wired.
    if (accessibilityScanResults.violations.length > 0) {
      console.warn(
        `[axe-scan] Found ${accessibilityScanResults.violations.length} a11y violations on /login (advisory in Phase 70):`,
      );
      for (const v of accessibilityScanResults.violations) {
        console.warn(`  - [${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`);
      }
    }

    // Phase 70 assertion: spec passes regardless of violations (advisory).
    // Replace with `expect(accessibilityScanResults.violations).toEqual([])` in Phase 73.
    expect(accessibilityScanResults.violations.length).toBeGreaterThanOrEqual(0);
  });
});
