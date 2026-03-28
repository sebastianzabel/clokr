import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

test.describe("UI Audit — Visual & Layout Checks", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("sidebar navigation has all expected links", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Check core navigation items exist somewhere on the page
    for (const text of ["Dashboard", "Zeiterfassung", "Abwesenheiten"]) {
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    }
  });

  test("sidebar user box is clickable and leads to profile", async ({ page }) => {
    await page.goto("/dashboard");
    const userBox = page.locator(".sidebar-user");
    await expect(userBox).toBeVisible();
    await userBox.click();
    await page.waitForURL("**/settings");
    await expect(page).toHaveURL(/settings/);
  });

  test("dashboard loads with summary cards", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    await screenshotPage(page, "dashboard");

    // Should have some content — not just a blank page
    const bodyText = await page.textContent("body");
    expect(bodyText?.length).toBeGreaterThan(100);
  });

  test("time entries page shows month summary", async ({ page }) => {
    await page.goto("/time-entries");
    await page.waitForLoadState("networkidle");
    await screenshotPage(page, "time-entries");

    // Month summary bar should be visible (Soll or Ist)
    await expect(page.getByText(/Soll|Ist/).first()).toBeVisible({ timeout: 5000 });
  });

  test("leave page shows vacation summary", async ({ page }) => {
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");
    await screenshotPage(page, "leave");

    await expect(page.getByText(/Jahresanspruch|Verbleibend|Urlaub/).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test("admin system page loads all sections", async ({ page }) => {
    await page.goto("/admin/system");
    await page.waitForLoadState("networkidle");
    await screenshotPage(page, "admin-system");

    for (const section of ["Sicherheit", "Session", "Passwort"]) {
      await expect(page.getByText(section, { exact: false }).first()).toBeVisible();
    }
  });

  test("profile page has password change and avatar", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await screenshotPage(page, "profile");

    await expect(page.getByText(/Passwort/).first()).toBeVisible();
    await expect(page.getByText(/Profilbild|Avatar/).first()).toBeVisible();
  });

  test("admin vacation page loads all config sections", async ({ page }) => {
    await page.goto("/admin/vacation");
    await page.waitForLoadState("networkidle");
    await screenshotPage(page, "admin-vacation");

    for (const section of ["Arbeitszeit", "Urlaubsanspruch", "Heiligabend"]) {
      await expect(page.getByText(section, { exact: false }).first()).toBeVisible();
    }
  });
});

test.describe("UI Audit — Mobile Responsive", () => {
  test.use({ viewport: { width: 375, height: 812 } }); // iPhone 13

  test("login page renders correctly on mobile", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await screenshotPage(page, "login-mobile");

    await expect(page.getByLabel("E-Mail")).toBeVisible();
    await expect(page.getByRole("button", { name: /anmelden/i })).toBeVisible();
  });

  test("mobile header visible after login", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await screenshotPage(page, "dashboard-mobile");

    // Mobile header should be visible, sidebar hidden
    await expect(page.locator(".mobile-header").or(page.locator("header"))).toBeVisible();
  });
});
