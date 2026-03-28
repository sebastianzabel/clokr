import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

test.describe("Admin Settings — Complete Flow", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("navigate all admin tabs", async ({ page }) => {
    await page.goto("/admin/employees");
    await page.waitForLoadState("networkidle");

    const tabs = [
      "Mitarbeiter",
      "Urlaub",
      "Sonderurlaub",
      "Betriebsurlaub",
      "Monatsabschluss",
      "System",
    ];
    for (const tab of tabs) {
      const link = page
        .getByRole("link", { name: tab })
        .or(page.locator(".admin-tab").filter({ hasText: tab }))
        .first();
      if (await link.isVisible()) {
        await link.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(300);
      }
    }
    await screenshotPage(page, "flow-admin-tabs");
  });

  test("admin vacation — open/close accordion sections", async ({ page }) => {
    await page.goto("/admin/vacation");
    await page.waitForLoadState("networkidle");

    // Find accordion headers
    const headers = page.locator(".section-group-header, details > summary");
    const count = await headers.count();

    for (let i = 0; i < Math.min(count, 5); i++) {
      const header = headers.nth(i);
      if (await header.isVisible()) {
        await header.click();
        await page.waitForTimeout(200);
      }
    }
    await screenshotPage(page, "flow-admin-vacation-accordions");
  });

  test("admin system — security section visible", async ({ page }) => {
    await page.goto("/admin/system");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Sicherheit").first()).toBeVisible();
    await expect(page.getByText("Session-Management").first()).toBeVisible();
    await expect(page.getByText("Passwort-Richtlinie").first()).toBeVisible();

    await screenshotPage(page, "flow-admin-system-security");
  });

  test("admin system — toggle 2FA", async ({ page }) => {
    await page.goto("/admin/system");
    await page.waitForLoadState("networkidle");

    // Find 2FA checkbox
    const twoFaSwitch = page.locator(".switch input[type='checkbox']").first();
    if (await twoFaSwitch.isVisible()) {
      const wasBefore = await twoFaSwitch.isChecked();
      await twoFaSwitch.click();
      await page.waitForTimeout(500);

      // Toggle back
      await twoFaSwitch.click();
      await page.waitForTimeout(500);
    }
  });

  test("admin system — API keys section", async ({ page }) => {
    await page.goto("/admin/system");
    await page.waitForLoadState("networkidle");

    // Scroll to API keys
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);

    const apiSection = page.getByText("API Keys").first();
    await expect(apiSection).toBeVisible();
    await screenshotPage(page, "flow-admin-api-keys");
  });

  test("admin special-leave — view rules table", async ({ page }) => {
    await page.goto("/admin/special-leave");
    await page.waitForLoadState("networkidle");

    // Should have statutory rules
    await expect(page.getByText("Eigene Hochzeit").first()).toBeVisible();
    await expect(page.getByText("Gesetzlich").first()).toBeVisible();

    await screenshotPage(page, "flow-admin-special-leave");
  });

  test("admin special-leave — open create modal", async ({ page }) => {
    await page.goto("/admin/special-leave");
    await page.waitForLoadState("networkidle");

    await page.getByText("Neue Regel").click();
    await page.waitForTimeout(300);

    const modal = page.locator(".modal, [role='dialog']").first();
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Anlass")).toBeVisible();

    await screenshotPage(page, "flow-admin-special-leave-create");

    // Close modal
    await page.locator(".modal-close, .modal-backdrop").first().click();
  });

  test("admin employees — view employee list", async ({ page }) => {
    await page.goto("/admin/employees");
    await page.waitForLoadState("networkidle");

    // Should see employee table
    await expect(page.locator("table, .data-table").first()).toBeVisible();
    await screenshotPage(page, "flow-admin-employees-list");
  });

  test("admin employees — open create modal", async ({ page }) => {
    await page.goto("/admin/employees");
    await page.waitForLoadState("networkidle");

    const createBtn = page.getByText(/Mitarbeiter anlegen/i).first();
    if (await createBtn.isVisible()) {
      await createBtn.click();
      await page.waitForTimeout(300);

      const modal = page.locator(".modal, [role='dialog']").first();
      if (await modal.isVisible()) {
        await expect(modal.getByText(/Vorname|E-Mail/).first()).toBeVisible();
        await screenshotPage(page, "flow-admin-employee-create");

        // Close
        await page.keyboard.press("Escape");
      }
    }
  });

  test("admin monatsabschluss — view months", async ({ page }) => {
    await page.goto("/admin/monatsabschluss");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/Monatsabschluss/).first()).toBeVisible();
    // Should show month rows
    await expect(page.getByText(/Januar|Februar|März/).first()).toBeVisible();
    await screenshotPage(page, "flow-admin-monatsabschluss");
  });
});
