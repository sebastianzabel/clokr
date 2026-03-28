import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

test.describe("Mobile Experience", () => {
  test.use({ viewport: { width: 375, height: 812 } }); // iPhone 13

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("dashboard — clock button usable on mobile", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Clock button should be visible and not overflow
    const clockBtn = page.locator(".clock-btn").first();
    if (await clockBtn.isVisible()) {
      const box = await clockBtn.boundingBox();
      if (box) {
        // Button should be fully within viewport
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(375 + 5); // 5px tolerance
      }
    }

    await screenshotPage(page, "flow-mobile-dashboard");
  });

  test("mobile nav — all items visible", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const nav = page.locator(".mobile-nav");
    await expect(nav).toBeVisible();

    // Check core items are accessible
    for (const label of ["Dashboard", "Zeiterfassung", "Abwesenheiten"]) {
      const item = nav.getByText(label);
      await expect(item).toBeVisible();
    }

    await screenshotPage(page, "flow-mobile-nav");
  });

  test("mobile nav — Admin link accessible", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const nav = page.locator(".mobile-nav");
    const adminLink = nav.getByText("Admin");

    // Admin should be visible (might need scroll)
    if (!(await adminLink.isVisible())) {
      // Scroll nav to the right
      await nav.evaluate((el) => (el.scrollLeft = el.scrollWidth));
      await page.waitForTimeout(300);
    }

    await expect(adminLink).toBeVisible();
    await adminLink.click();
    await page.waitForURL("**/admin/**");

    await screenshotPage(page, "flow-mobile-admin");
  });

  test("time entries — calendar usable on mobile", async ({ page }) => {
    await page.goto("/time-entries");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Calendar should not have horizontal overflow
    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasOverflow).toBe(false);

    // Month title should be visible
    await expect(page.locator(".cal-month-title, .cal-nav-title").first()).toBeVisible();

    await screenshotPage(page, "flow-mobile-time-entries");
  });

  test("leave form usable on mobile", async ({ page }) => {
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");

    await page
      .getByText(/Neuer Antrag/)
      .first()
      .click();
    await page.waitForTimeout(500);

    // Form elements should be within viewport
    const typeSelect = page.locator("#f-type").first();
    if (await typeSelect.isVisible()) {
      const box = await typeSelect.boundingBox();
      if (box) {
        expect(box.width).toBeGreaterThan(200); // Not too narrow
        expect(box.x + box.width).toBeLessThanOrEqual(375 + 5);
      }
    }

    await screenshotPage(page, "flow-mobile-leave-form");
  });

  test("profile page layout on mobile", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Should stack vertically on mobile
    await expect(page.getByText(/Passwort/).first()).toBeVisible();
    await expect(page.getByText(/Profilbild|Avatar/).first()).toBeVisible();

    await screenshotPage(page, "flow-mobile-profile");
  });

  test("no horizontal scrollbar on any mobile page", async ({ page }) => {
    // Admin pages with tables are expected to have scrollable containers
    const routes = ["/dashboard", "/time-entries", "/leave", "/settings"];
    const overflow: string[] = [];

    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);

      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth + 5;
      });

      if (hasOverflow) overflow.push(route);
    }

    if (overflow.length > 0) {
      console.log("📱 Mobile overflow on:", overflow);
    }
    expect(overflow).toHaveLength(0);
  });
});
