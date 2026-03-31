import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

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

  test("clock in and verify running state", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Reset state: if already clocked in, clock out first
    const clockOutBtn = page.locator(".clock-btn--out");
    if (await clockOutBtn.isVisible()) {
      await clockOutBtn.click();
      await expect(page.locator(".clock-btn--in")).toBeVisible({ timeout: 10_000 });
    }

    // Verify the clock-in button is visible before clicking
    const clockInBtn = page.locator(".clock-btn--in");
    await expect(clockInBtn).toBeVisible();

    // Click to clock in
    await clockInBtn.click();

    // After clock-in: clock-out button must appear and status text must show
    await expect(page.locator(".clock-btn--out")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Eingestempelt seit/)).toBeVisible();

    await screenshotPage(page, "flow-clock-in-active");
  });

  test("clock out and verify stopped state", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Ensure we are clocked in before testing clock-out
    const clockInBtn = page.locator(".clock-btn--in");
    if (await clockInBtn.isVisible()) {
      await clockInBtn.click();
      await expect(page.locator(".clock-btn--out")).toBeVisible({ timeout: 10_000 });
    }

    // Verify the clock-out button is visible before clicking
    const clockOutBtn = page.locator(".clock-btn--out");
    await expect(clockOutBtn).toBeVisible();

    // Click to clock out
    await clockOutBtn.click();

    // After clock-out: clock-in button must appear and status text must disappear
    await expect(page.locator(".clock-btn--in")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Eingestempelt seit/)).not.toBeVisible();

    await screenshotPage(page, "flow-clock-out-stopped");
  });
});
