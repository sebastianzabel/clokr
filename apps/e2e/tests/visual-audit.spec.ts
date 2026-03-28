import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

test.describe("Visual Audit — Full Page Review", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("01 — Login Page", async ({ page }) => {
    // Logout first to see login
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await screenshotPage(page, "audit-01-login");
  });

  test("02 — Dashboard", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await screenshotPage(page, "audit-02-dashboard");

    // Scroll down to see charts
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(500);
    await screenshotPage(page, "audit-02-dashboard-scrolled");
  });

  test("03 — Zeiterfassung", async ({ page }) => {
    await page.goto("/time-entries");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await screenshotPage(page, "audit-03-time-entries");

    // Scroll to calendar
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(500);
    await screenshotPage(page, "audit-03-time-entries-calendar");
  });

  test("04 — Abwesenheiten", async ({ page }) => {
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await screenshotPage(page, "audit-04-leave");

    // Scroll to calendar
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(500);
    await screenshotPage(page, "audit-04-leave-calendar");
  });

  test("05 — Profil / Settings", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await screenshotPage(page, "audit-05-profile");
  });

  test("06 — Admin Mitarbeiter", async ({ page }) => {
    await page.goto("/admin/employees");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await screenshotPage(page, "audit-06-admin-employees");
  });

  test("07 — Admin Urlaub & Zeiten", async ({ page }) => {
    await page.goto("/admin/vacation");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await screenshotPage(page, "audit-07-admin-vacation");

    // Scroll through all sections
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(500);
    await screenshotPage(page, "audit-07-admin-vacation-mid");

    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(500);
    await screenshotPage(page, "audit-07-admin-vacation-bottom");
  });

  test("08 — Admin Sonderurlaub", async ({ page }) => {
    await page.goto("/admin/special-leave");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await screenshotPage(page, "audit-08-admin-special-leave");
  });

  test("09 — Admin Betriebsurlaub", async ({ page }) => {
    await page.goto("/admin/shutdowns");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await screenshotPage(page, "audit-09-admin-shutdowns");
  });

  test("10 — Admin Schichtplan", async ({ page }) => {
    await page.goto("/admin/shifts");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await screenshotPage(page, "audit-10-admin-shifts");
  });

  test("11 — Admin Monatsabschluss", async ({ page }) => {
    await page.goto("/admin/monatsabschluss");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await screenshotPage(page, "audit-11-admin-monatsabschluss");
  });

  test("12 — Admin System", async ({ page }) => {
    await page.goto("/admin/system");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await screenshotPage(page, "audit-12-admin-system");

    await page.evaluate(() => window.scrollTo(0, 800));
    await page.waitForTimeout(500);
    await screenshotPage(page, "audit-12-admin-system-mid");

    await page.evaluate(() => window.scrollTo(0, 99999));
    await page.waitForTimeout(500);
    await screenshotPage(page, "audit-12-admin-system-bottom");
  });

  test("13 — Admin Import", async ({ page }) => {
    await page.goto("/admin/import");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await screenshotPage(page, "audit-13-admin-import");
  });

  test("14 — Admin Audit Log", async ({ page }) => {
    await page.goto("/admin/audit");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await screenshotPage(page, "audit-14-admin-audit");
  });

  test("15 — Überstunden", async ({ page }) => {
    await page.goto("/overtime");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await screenshotPage(page, "audit-15-overtime");
  });

  test("16 — Reports", async ({ page }) => {
    await page.goto("/reports");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await screenshotPage(page, "audit-16-reports");
  });
});
