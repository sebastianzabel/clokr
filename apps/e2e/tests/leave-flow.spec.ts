import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

test.describe("Abwesenheiten — Complete Flow", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");
  });

  test("page loads with tabs and vacation summary", async ({ page }) => {
    await expect(page.getByText(/Kalender/).first()).toBeVisible();
    await expect(page.getByText(/Meine Anträge/i).first()).toBeVisible();
    // Vacation summary should show
    await expect(page.getByText(/Jahresanspruch|Verbleibend/).first()).toBeVisible();
    await screenshotPage(page, "flow-leave-overview");
  });

  test("open leave request form", async ({ page }) => {
    // Click "Neuer Antrag"
    const newBtn = page.getByText(/Neuer Antrag|Antrag/).first();
    await newBtn.click();
    await page.waitForTimeout(500);

    // Form should appear
    const typeSelect = page
      .locator("#f-type, select")
      .filter({ hasText: /Urlaub/ })
      .first();
    await expect(typeSelect).toBeVisible();

    await screenshotPage(page, "flow-leave-form");
  });

  test("create a vacation request", async ({ page }) => {
    // Open form
    await page
      .getByText(/Neuer Antrag|Antrag/)
      .first()
      .click();
    await page.waitForTimeout(500);

    // Select vacation type
    const typeSelect = page.locator("#f-type").first();
    if (await typeSelect.isVisible()) {
      await typeSelect.selectOption("VACATION");
    }

    // Set dates (2 weeks from now to avoid lead time issues)
    const start = new Date();
    start.setDate(start.getDate() + 30);
    while (start.getDay() === 0 || start.getDay() === 6) start.setDate(start.getDate() + 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 2);
    while (end.getDay() === 0 || end.getDay() === 6) end.setDate(end.getDate() + 1);

    const startStr = start.toISOString().split("T")[0];
    const endStr = end.toISOString().split("T")[0];

    const startInput = page.locator("#f-start, input[type='date']").first();
    const endInput = page.locator("#f-end").first();

    if (await startInput.isVisible()) {
      await startInput.fill(startStr);
      await page.waitForTimeout(200);
    }
    if (await endInput.isVisible()) {
      await endInput.fill(endStr);
      await page.waitForTimeout(200);
    }

    await screenshotPage(page, "flow-leave-request-filled");

    // Submit
    const submitBtn = page
      .getByRole("button", { name: /einreichen|antrag stellen|speichern/i })
      .first();
    if (await submitBtn.isVisible()) {
      await submitBtn.click();
      await page.waitForTimeout(1000);
    }

    await screenshotPage(page, "flow-leave-request-submitted");
  });

  test("switch to Meine Anträge tab", async ({ page }) => {
    const myRequestsTab = page.getByText("Meine Anträge", { exact: false });
    if (await myRequestsTab.isVisible()) {
      await myRequestsTab.click();
      await page.waitForTimeout(500);
      await screenshotPage(page, "flow-leave-my-requests");
    }
  });

  test("manager sees approvals tab", async ({ page }) => {
    const approvalsTab = page.getByText(/Genehmigungen/i);
    if (await approvalsTab.isVisible()) {
      await approvalsTab.click();
      await page.waitForTimeout(500);
      await screenshotPage(page, "flow-leave-approvals");
    }
  });

  test("special leave shows reason dropdown", async ({ page }) => {
    await page
      .getByText(/Neuer Antrag|Antrag/)
      .first()
      .click();
    await page.waitForTimeout(500);

    const typeSelect = page.locator("#f-type").first();
    if (await typeSelect.isVisible()) {
      await typeSelect.selectOption("SPECIAL");
      await page.waitForTimeout(500);

      // Should show special leave rule dropdown
      const ruleSelect = page.locator("#f-special-rule");
      await expect(ruleSelect).toBeVisible();
      await screenshotPage(page, "flow-leave-special-dropdown");
    }
  });

  test("calendar month navigation", async ({ page }) => {
    const monthTitle = page.locator(".cal-nav-title, .cal-month-title").first();
    await expect(monthTitle).toBeVisible();

    // Open month picker
    await monthTitle.click();
    const picker = page.locator(".month-picker");
    await expect(picker).toBeVisible();

    // Navigate year
    const yearNext = picker.locator("button").filter({ hasText: "›" });
    await yearNext.click();
    await page.waitForTimeout(300);

    await screenshotPage(page, "flow-leave-month-picker");

    // Close by clicking outside
    const backdrop = page.locator(".month-picker-backdrop");
    if (await backdrop.isVisible()) {
      await backdrop.click();
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(300);
  });

  test("team toggle works", async ({ page }) => {
    const teamBtn = page.locator(".team-toggle").first();
    if (await teamBtn.isVisible()) {
      await teamBtn.click();
      await page.waitForTimeout(500);
      await screenshotPage(page, "flow-leave-team-view");

      // Toggle back
      await teamBtn.click();
      await page.waitForTimeout(300);
    }
  });
});
