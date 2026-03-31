import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

// Compute a weekday date far enough in the past to avoid conflicts with previous test runs.
// Uses 60 days ago offset to ensure the date is in a month that tests are unlikely to
// have polluted from previous runs.
function weekdayNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().split("T")[0];
}

const TEST_DATE = weekdayNDaysAgo(60);

/**
 * Navigate the time-entries calendar to the month of a given YYYY-MM-DD date.
 * Clicks "Vorheriger Monat" until the displayed month+year matches.
 */
async function navigateToMonth(page: import("@playwright/test").Page, targetDate: string) {
  const targetYear = parseInt(targetDate.substring(0, 4));
  const targetMonth = parseInt(targetDate.substring(5, 7)); // 1-based
  const monthNames = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ];
  const targetLabel = `${monthNames[targetMonth - 1]} ${targetYear}`;

  for (let attempts = 0; attempts < 24; attempts++) {
    // The center cal-nav button shows "Monat Jahr" (e.g., "März 2026")
    const centerBtn = page.locator(".cal-nav-center button").first();
    const centerText = await centerBtn.textContent().catch(() => "");
    if (centerText?.includes(monthNames[targetMonth - 1]) && centerText?.includes(String(targetYear))) {
      break;
    }
    // Determine if we need to go backwards or forwards
    // Simple approach: always go backwards (test dates are in the past)
    await page.locator(".cal-nav button[title='Vorheriger Monat']").click();
    await page.waitForTimeout(200);
  }
  console.log(`Navigated to: ${targetLabel}`);
}

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
    // Navigate calendar to the month of TEST_DATE (60 days ago)
    await navigateToMonth(page, TEST_DATE);

    // Click the day cell for TEST_DATE to open the add modal.
    // Using data-date attribute for reliable selection.
    const dayCell = page.locator(`[data-date="${TEST_DATE}"]`).first();
    await expect(dayCell).toBeVisible({ timeout: 5_000 });
    await dayCell.click();

    // Wait for modal to appear — the modal uses role=dialog on the .modal-card element
    const modal = page.locator("[role='dialog']").first();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // If the modal opened in edit mode (entry already exists), skip creation
    const modalTitle = await modal.locator("h2").first().textContent();
    if (modalTitle?.includes("bearbeiten")) {
      console.log(`Entry already exists for ${TEST_DATE} — closing modal`);
      await modal.getByRole("button", { name: /Abbrechen|Schließen/i }).first().click();
      await expect(modal).not.toBeVisible({ timeout: 3_000 });
      return;
    }

    // Fill start and end times (date is pre-filled from the cell click)
    await modal.locator("#f-start").fill("08:00");
    await modal.locator("#f-end").fill("16:30");

    // Click save — for new entries the button text is "Eintrag hinzufügen"
    await modal
      .getByRole("button", { name: /Eintrag hinzufügen|Änderungen speichern/i })
      .first()
      .click();

    // Modal should close after successful save
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    await screenshotPage(page, "flow-time-entry-created");
  });

  test("edit an existing time entry", async ({ page }) => {
    // Navigate to the month of TEST_DATE and open the entry
    await navigateToMonth(page, TEST_DATE);

    const modal = page.locator("[role='dialog']").first();
    const dayCell = page.locator(`[data-date="${TEST_DATE}"]`).first();
    await expect(dayCell).toBeVisible({ timeout: 5_000 });
    await dayCell.click();

    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Change end time to 17:00
    await modal.locator("#f-end").fill("17:00");

    // Click save — for edits the button text is "Änderungen speichern"
    await modal
      .getByRole("button", { name: /Eintrag hinzufügen|Änderungen speichern/i })
      .first()
      .click();

    // Modal should close
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    await screenshotPage(page, "flow-time-entry-edited");
  });

  test("delete a time entry", async ({ page }) => {
    // Navigate to the month of TEST_DATE first (calendar view has the nav buttons)
    await navigateToMonth(page, TEST_DATE);

    // Switch to list view where the delete (trash) button is visible
    await page.getByRole("button", { name: /Liste/i }).click();
    await page.waitForLoadState("networkidle");

    // In list view, find the first delete icon and click it
    const deleteBtn = page.locator(".btn-icon-danger").first();
    await expect(deleteBtn).toBeVisible({ timeout: 5_000 });
    await deleteBtn.click();

    // Confirm deletion by clicking the confirm button "Ja"
    await expect(page.getByRole("button", { name: "Ja" })).toBeVisible({ timeout: 3_000 });
    await page.getByRole("button", { name: "Ja" }).first().click();

    // Wait for the deletion to process
    await page.waitForTimeout(500);

    await screenshotPage(page, "flow-time-entry-deleted");
  });

  test("locked-month edit shows German error message", async ({ page }) => {
    // Intercept both POST and PUT requests to the time-entries API and return mocked 403.
    // The "Eintrag hinzufügen" button opens the form with editEntry=null, so saveEntry()
    // calls POST (not PUT) for new entries. We intercept both to cover both flows.
    await page.route("**/api/v1/time-entries", async (route) => {
      if (route.request().method() === "POST") {
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
    await page.locator("button.btn-primary").filter({ hasText: /Eintrag hinzufügen/i }).click();
    const modal = page.locator("[role='dialog']").first();
    await expect(modal).toBeVisible();

    // Fill a date slightly further back to avoid conflicts
    const d = new Date();
    d.setDate(d.getDate() - 14);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    const lockTestDate = d.toISOString().split("T")[0];

    await modal.locator("#f-date").fill(lockTestDate);
    await modal.locator("#f-start").fill("09:00");
    await modal.locator("#f-end").fill("17:00");

    // Click save — the intercepted POST returns 403
    await modal
      .getByRole("button", { name: /Eintrag hinzufügen|Änderungen speichern/i })
      .first()
      .click();

    // The page must display the German locked-month error
    await expect(page.getByText("Monat ist gesperrt")).toBeVisible({ timeout: 5_000 });

    await screenshotPage(page, "flow-locked-month-error");

    // Clean up route intercepts
    await page.unroute("**/api/v1/time-entries");
    await page.unroute("**/api/v1/time-entries/**");
  });
});
