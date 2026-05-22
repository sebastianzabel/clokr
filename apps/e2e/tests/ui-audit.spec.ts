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

  test("sidebar foot user-info is visible (desktop)", async ({ page }) => {
    // Sidebar.svelte renders the user block as `.sidebar-foot` in v1.5 — the
    // legacy `.sidebar-user` class was removed during the Phase 30 refresh.
    // The foot block is not itself clickable; access to the profile happens
    // via the Topbar avatar dropdown instead (see admin-settings-flow.spec).
    await page.goto("/dashboard");
    const foot = page.locator(".sidebar-foot");
    await expect(foot).toBeVisible();
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

    // Check always-visible section headers (the <details> summaries are always visible)
    // "Arbeitszeit" and "Urlaubsanspruch" are in open accordions
    // "Abwesenheiten & Sonderregelungen" is a summary (always visible even when collapsed)
    for (const section of ["Arbeitszeit", "Urlaubsanspruch", "Abwesenheiten"]) {
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

  test("mobile shell visible after login (UI-15 Bottom-Tab Bar + Topbar)", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await screenshotPage(page, "dashboard-mobile");

    // v1.5 mobile shell: the desktop Sidebar hides below 960px, but the
    // Topbar persists for the persona switch + bell + avatar. The new
    // BottomTabBar (Phase 39, UI-15) provides primary nav.
    await expect(page.locator("header.topbar")).toBeVisible();
    await expect(page.locator(".bottom-tab-bar")).toBeVisible();
  });
});
