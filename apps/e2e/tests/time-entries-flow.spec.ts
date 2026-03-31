import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

// Compute a weekday date 7 days ago (shared across tests via closure)
function weekdaySevenDaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().split("T")[0];
}

const TEST_DATE = weekdaySevenDaysAgo();

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
    // Click "Eintrag hinzufügen" to open the add modal
    await page.getByText(/Eintrag hinzufügen/i).click();

    // Wait for modal to appear
    const modal = page.locator("[role='dialog'], .modal").first();
    await expect(modal).toBeVisible();

    // Fill in the date (7 days ago, guaranteed weekday)
    await modal.locator("input[type='date']").first().fill(TEST_DATE);

    // Fill start and end times
    await modal.locator("input[type='time']").first().fill("08:00");
    await modal.locator("input[type='time']").nth(1).fill("16:30");

    // Click save
    await modal.getByRole("button", { name: /speichern|erstellen/i }).first().click();

    // Modal should close after successful save
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    await screenshotPage(page, "flow-time-entry-created");
  });

  test("edit an existing time entry", async ({ page }) => {
    // Navigate to the correct month if the test date is in a different month
    // (TEST_DATE is at most 7 days ago, so it's in the current or previous month)
    // The modal is reused from the create step — open by clicking the day cell
    const modal = page.locator("[role='dialog'], .modal").first();

    // Try to find the day cell using data-date attribute
    const dayCell = page.locator(`[data-date="${TEST_DATE}"]`).first();
    const dayCellVisible = await dayCell.isVisible().catch(() => false);

    if (dayCellVisible) {
      await dayCell.click();
    } else {
      // Fallback: click the edit icon (pencil) in the list view if calendar not available
      await page.locator(".btn-icon").filter({ hasText: /✏️/ }).first().click();
    }

    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Change end time to 17:00
    await modal.locator("input[type='time']").nth(1).fill("17:00");

    // Click save
    await modal.getByRole("button", { name: /speichern|erstellen/i }).first().click();

    // Modal should close
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    await screenshotPage(page, "flow-time-entry-edited");
  });

  test("delete a time entry", async ({ page }) => {
    const modal = page.locator("[role='dialog'], .modal").first();

    // Open the entry by clicking the day cell or edit icon
    const dayCell = page.locator(`[data-date="${TEST_DATE}"]`).first();
    const dayCellVisible = await dayCell.isVisible().catch(() => false);

    if (dayCellVisible) {
      await dayCell.click();
      await expect(modal).toBeVisible({ timeout: 5_000 });

      // Inside modal, click delete button
      await modal.getByRole("button", { name: /löschen/i }).first().click();
    } else {
      // Fallback: use the row-level delete icon (🗑) which opens inline confirm
      await page.locator(".btn-icon-danger").first().click();
    }

    // Confirm deletion by clicking "Ja"
    await page.getByRole("button", { name: "Ja" }).first().click();

    // Modal should be gone
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    await screenshotPage(page, "flow-time-entry-deleted");
  });

  test("locked-month edit shows German error message", async ({ page }) => {
    // Intercept PUT requests to the time-entries API and return mocked 403
    await page.route("**/api/v1/time-entries/**", async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Eintrag ist gesperrt und kann nicht bearbeitet werden",
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Open the add modal
    await page.getByText(/Eintrag hinzufügen/i).click();
    const modal = page.locator("[role='dialog'], .modal").first();
    await expect(modal).toBeVisible();

    // Fill a date slightly further back to avoid conflicts
    const d = new Date();
    d.setDate(d.getDate() - 14);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    const lockTestDate = d.toISOString().split("T")[0];

    await modal.locator("input[type='date']").first().fill(lockTestDate);
    await modal.locator("input[type='time']").first().fill("09:00");
    await modal.locator("input[type='time']").nth(1).fill("17:00");

    // Click save — the intercepted PUT returns 403
    await modal.getByRole("button", { name: /speichern|erstellen/i }).first().click();

    // The page must display the German locked-month error
    await expect(page.getByText("Monat ist gesperrt")).toBeVisible();

    await screenshotPage(page, "flow-locked-month-error");

    // Clean up route intercept
    await page.unroute("**/api/v1/time-entries/**");
  });
});
