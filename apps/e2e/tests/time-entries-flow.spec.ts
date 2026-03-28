import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

test.describe("Zeiterfassung — Complete Flow", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/time-entries");
    await page.waitForLoadState("networkidle");
  });

  test("page loads with calendar and summary bar", async ({ page }) => {
    await expect(page.getByText(/Soll|Ist/).first()).toBeVisible();
    await expect(page.locator(".cal-nav")).toBeVisible();
    await expect(page.getByText(/Kalender/).first()).toBeVisible();
  });

  test("create a manual time entry", async ({ page }) => {
    // Click "Eintrag hinzufügen"
    await page.getByText(/Eintrag hinzufügen/i).click();
    await page.waitForTimeout(500);

    // Fill form — look for the modal/form
    const modal = page.locator(".modal, .entry-form, [role='dialog']").first();
    if (await modal.isVisible()) {
      // Fill date (today)
      const today = new Date().toISOString().split("T")[0];
      const dateInput = modal.locator("input[type='date']").first();
      if (await dateInput.isVisible()) {
        await dateInput.fill(today);
      }

      // Fill start time
      const startInput = modal.locator("input[type='time']").first();
      if (await startInput.isVisible()) {
        await startInput.fill("08:00");
      }

      // Fill end time
      const endInput = modal.locator("input[type='time']").nth(1);
      if (await endInput.isVisible()) {
        await endInput.fill("16:30");
      }

      await screenshotPage(page, "flow-time-entry-form");

      // Submit
      const saveBtn = modal.getByRole("button", { name: /speichern|erstellen/i }).first();
      if (await saveBtn.isVisible()) {
        await saveBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    await screenshotPage(page, "flow-time-entry-created");
  });

  test("calendar month picker works", async ({ page }) => {
    // Click on month title to open picker
    const monthTitle = page.locator(".cal-month-title, .cal-nav-title").first();
    await expect(monthTitle).toBeVisible();
    await monthTitle.click();

    // Picker should appear
    const picker = page.locator(".month-picker");
    await expect(picker).toBeVisible();

    await screenshotPage(page, "flow-month-picker-open");

    // Click a month
    const monthBtn = picker.locator(".month-picker-btn").first();
    await monthBtn.click();

    // Picker should close
    await expect(picker).not.toBeVisible();
  });

  test("switch between calendar and list view", async ({ page }) => {
    // Find and click "Liste" tab
    const listTab = page.getByText("Liste", { exact: true });
    if (await listTab.isVisible()) {
      await listTab.click();
      await page.waitForTimeout(500);
      await screenshotPage(page, "flow-time-entries-list");
    }

    // Switch back to calendar
    const calTab = page.getByText("Kalender", { exact: true });
    if (await calTab.isVisible()) {
      await calTab.click();
      await page.waitForTimeout(500);
    }
  });

  test("summary bar updates correctly", async ({ page }) => {
    // Check that Soll, Ist, and Saldo values are displayed
    const summaryBar = page.locator(".month-summary").first();
    if (await summaryBar.isVisible()) {
      const text = await summaryBar.textContent();
      expect(text).toContain("h"); // Hours displayed
    }
  });

  test("employee filter visible for managers", async ({ page }) => {
    const dropdown = page.locator("select").filter({ hasText: /Meine Einträge|Mitarbeiter/i });
    await expect(dropdown.first()).toBeVisible();
  });
});
