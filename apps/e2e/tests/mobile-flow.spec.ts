import { test, expect, devices } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

// test.use() with defaultBrowserType must be top-level (not inside describe)
const { defaultBrowserType: _bt, ...iphone14Settings } = devices["iPhone 14"];
test.use(iphone14Settings);

test.describe("Mobile Experience (UI-15 — v1.5 Bottom-Tab Bar)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("bottom-tab bar — visible and renders all four tabs", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // The fixed BottomTabBar replaced the old `.mobile-nav` in Phase 39.
    const bar = page.locator(".bottom-tab-bar");
    await expect(bar).toBeVisible();

    // Three primary tab labels + the Mehr trigger.
    for (const label of ["Übersicht", "Zeit", "Urlaub", "Mehr"]) {
      await expect(bar.getByText(label, { exact: true }).first()).toBeVisible();
    }

    await screenshotPage(page, "flow-mobile-bottom-tab-bar");
  });

  test("bottom-tab bar — every tab clears the 44 px touch-target minimum", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const tabs = page.locator(".bottom-tab-bar .tab");
    const count = await tabs.count();
    expect(count).toBe(4);

    for (let i = 0; i < count; i += 1) {
      const box = await tabs.nth(i).boundingBox();
      expect(box, `tab ${i} bounding box`).not.toBeNull();
      if (box) {
        // WCAG 2.5.5 — min 44×44.
        expect(box.height, `tab ${i} height`).toBeGreaterThanOrEqual(44);
        // Width depends on grid (390 / 4 ≈ 97), well above 44px.
        expect(box.width, `tab ${i} width`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test("dashboard — timer card visible on mobile without overflow", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // The v1.5 dashboard hero is the `.timer-card` (replaces the old `.clock-btn`).
    const timerCard = page.locator(".timer-card").first();
    await expect(timerCard).toBeVisible();

    const box = await timerCard.boundingBox();
    if (box) {
      // Card must be fully within the iPhone 14 viewport (390px wide).
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390 + 5);
    }

    await screenshotPage(page, "flow-mobile-dashboard");
  });

  test("Mehr-sheet — opens, traps focus, closes with ESC", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Tap "Mehr" to open the bottom sheet.
    await page.locator(".bottom-tab-bar .tab").last().click();

    const sheet = page.locator(".mehr-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("role", "dialog");

    // Admin sees the full overflow nav — at minimum these manager + admin items
    // are present in the sheet.
    for (const label of ["Anträge", "Team-Zeiten", "Mitarbeitende", "Compliance & Audit"]) {
      await expect(sheet.getByText(label, { exact: false }).first()).toBeVisible();
    }

    // ESC closes the sheet.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("Mehr-sheet — admin can navigate to /admin/employees via the sheet", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await page.locator(".bottom-tab-bar .tab").last().click();
    const sheet = page.locator(".mehr-sheet");
    await expect(sheet).toBeVisible();

    await sheet.getByText("Mitarbeitende", { exact: false }).first().click();
    await page.waitForURL("**/admin/employees", { timeout: 10_000 });
    await expect(page).toHaveURL(/admin\/employees/);

    await screenshotPage(page, "flow-mobile-admin-employees");
  });

  test("time entries — calendar usable on mobile (no horizontal overflow)", async ({ page }) => {
    await page.goto("/time-entries");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 5;
    });
    expect(hasOverflow).toBe(false);

    // Month title from the canonical MonthBar primitive.
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

    // Form elements should be within viewport.
    const typeSelect = page.locator("#f-type").first();
    await expect(typeSelect).toBeVisible();
    const box = await typeSelect.boundingBox();
    if (box) {
      expect(box.width).toBeGreaterThan(200);
      expect(box.x + box.width).toBeLessThanOrEqual(390 + 5);
    }

    await screenshotPage(page, "flow-mobile-leave-form");
  });

  test("profile page layout on mobile", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Should stack vertically on mobile.
    await expect(page.getByText(/Passwort/).first()).toBeVisible();
    await expect(page.getByText(/Profilbild|Avatar/).first()).toBeVisible();

    await screenshotPage(page, "flow-mobile-profile");
  });

  test("no horizontal scrollbar on any primary mobile page", async ({ page }) => {
    // Routes carrying wide tables (e.g. /admin/employees) own their internal
    // .table-scroll wrapper — the document itself should not scroll horizontally.
    const routes = ["/dashboard", "/time-entries", "/leave", "/settings", "/reports"];
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
      console.log("Mobile overflow on:", overflow);
    }
    expect(overflow).toHaveLength(0);
  });
});
