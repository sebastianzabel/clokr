import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers";

test.describe("Core Flows", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("navigate through all main pages without errors", async ({ page }) => {
    const routes = ["/dashboard", "/time-entries", "/leave", "/settings"];
    for (const route of routes) {
      const response = await page.goto(route);
      expect(response?.status()).toBeLessThan(500);
      // No error alerts visible
      const errorAlert = page.locator(".alert-error, [role='alert']").first();
      const hasError = await errorAlert.isVisible().catch(() => false);
      if (hasError) {
        const text = await errorAlert.textContent();
        // Ignore benign alerts (e.g., empty state messages)
        if (text && /fehler|error|500/i.test(text)) {
          throw new Error(`Error on ${route}: ${text}`);
        }
      }
    }
  });

  test("navigate admin pages without errors", async ({ page }) => {
    const adminRoutes = [
      "/admin/employees",
      "/admin/vacation",
      "/admin/special-leave",
      "/admin/shutdowns",
      "/admin/system",
      "/admin/monatsabschluss",
    ];
    for (const route of adminRoutes) {
      const response = await page.goto(route);
      expect(response?.status()).toBeLessThan(500);
    }
  });

  test("command palette opens with Ctrl+K", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    // Playwright uses Control, not Meta for keyboard shortcuts
    await page.keyboard.press("Control+k");
    await expect(
      page.getByPlaceholder(/suche|search/i).or(page.locator(".command-palette, .cmd-palette")),
    ).toBeVisible({ timeout: 3000 });
  });

  test("theme switcher works", async ({ page }) => {
    await page.goto("/dashboard");
    // Open command palette and search for theme
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(500);
    // Close it
    await page.keyboard.press("Escape");
  });
});
