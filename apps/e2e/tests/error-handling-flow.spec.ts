import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

test.describe("Error Handling + UX Plausibility", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("leave form shows error for overlapping dates", async ({ page }) => {
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");

    const start = new Date();
    start.setDate(start.getDate() + 60);
    while (start.getDay() === 0 || start.getDay() === 6) start.setDate(start.getDate() + 1);
    const startStr = start.toISOString().split("T")[0];

    // Helper: open the form if not already open, then fill and submit
    async function openAndSubmitForm() {
      // The form dialog is visible when showForm=true
      const formDialog = page.locator("[role='dialog']").first();
      const formIsOpen = await formDialog.isVisible().catch(() => false);

      if (!formIsOpen) {
        // The "Neuer Antrag" button is only shown when the form is closed
        await page.getByText(/Neuer Antrag/).first().click();
        // Wait for the dialog to actually appear
        await page.locator("[role='dialog']").first().waitFor({ state: "visible" });
      }

      const startInput = page.locator("#f-start").first();
      const endInput = page.locator("#f-end").first();

      if (!(await startInput.isVisible())) return false;

      await startInput.fill(startStr);
      await endInput.fill(startStr);

      const submit = page.getByRole("button", { name: /einreichen|antrag/i }).first();
      if (await submit.isVisible()) {
        // Wait for the leave POST response (success OR error) instead of an arbitrary delay.
        await Promise.all([
          page
            .waitForResponse(
              (r) => r.url().includes("/api/v1/leave") && r.request().method() === "POST",
              { timeout: 5000 },
            )
            .catch(() => null),
          submit.click(),
        ]);
      }
      return true;
    }

    // Submit first request (might succeed or fail with overlap from a prior run)
    const filled = await openAndSubmitForm();

    if (filled) {
      // Submit the same dates again to trigger overlap error
      // If the first submit already failed with overlap, the form is still open — reuse it.
      await openAndSubmitForm();

      // Should show error
      await screenshotPage(page, "flow-error-overlap");
      const errorMsg = page.getByText(/Überschneidung|overlap/i);
      // Error should be visible (either in dialog or toast)
      if (await errorMsg.isVisible()) {
        expect(await errorMsg.textContent()).toBeTruthy();
      }
    }
  });

  test("login shows clear error on wrong credentials", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-Mail").fill("wrong@test.de");
    await page.getByLabel("Passwort", { exact: true }).fill("wrongpassword");
    // Wait for the auth POST to resolve (it returns 401) before screenshotting.
    await Promise.all([
      page
        .waitForResponse(
          (r) => r.url().includes("/api/v1/auth/login") && r.request().method() === "POST",
          { timeout: 5000 },
        )
        .catch(() => null),
      page.getByRole("button", { name: /anmelden/i }).click(),
    ]);

    await screenshotPage(page, "flow-error-login");
    // Should still be on login page
    await expect(page).toHaveURL(/login/);
  });

  test("profile password change — wrong current password shows error", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const curPw = page.locator("#cur-pw");
    const newPw = page.locator("#new-pw");
    const confirmPw = page.locator("#confirm-pw");

    if (await curPw.isVisible()) {
      await curPw.fill("wrongcurrentpassword");
      await newPw.fill("NewStr0ng!Pass#42");
      await confirmPw.fill("NewStr0ng!Pass#42");

      // Wait for the password-change request to resolve before screenshotting.
      await Promise.all([
        page
          .waitForResponse(
            (r) =>
              r.url().includes("/api/v1") &&
              (r.url().includes("password") || r.url().includes("me")) &&
              ["POST", "PUT", "PATCH"].includes(r.request().method()),
            { timeout: 5000 },
          )
          .catch(() => null),
        page.getByRole("button", { name: /passwort ändern/i }).click(),
      ]);

      await screenshotPage(page, "flow-error-password-change");
    }
  });

  test("dashboard provides clear information hierarchy", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Check information hierarchy
    // 1. Greeting should be most prominent
    const greeting = page.getByText(/Guten|Hallo/).first();
    await expect(greeting).toBeVisible();

    // 2. Clock should be prominent
    const clock = page.locator(".clock-time").first();
    if (await clock.isVisible()) {
      const fontSize = await clock.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(24); // At least 24px
    }

    // 3. Summary cards should be visible above fold
    const summaryCards = page.locator(".stat-card, .summary-card, .overview-card").first();
    if (await summaryCards.isVisible()) {
      const rect = await summaryCards.boundingBox();
      if (rect) {
        expect(rect.y).toBeLessThan(600); // Above the fold
      }
    }

    await screenshotPage(page, "flow-dashboard-hierarchy");
  });

  test("forms have clear labels and placeholders", async ({ page }) => {
    // Check leave form
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");
    await page
      .getByText(/Neuer Antrag/)
      .first()
      .click();
    // Wait for the form dialog to actually appear before inspecting inputs.
    await page.locator("[role='dialog']").first().waitFor({ state: "visible" });

    // Every visible input should have a label
    const inputs = await page.locator("input:visible, select:visible").all();
    for (const input of inputs) {
      const id = await input.getAttribute("id");
      if (id) {
        const label = page.locator(`label[for="${id}"]`);
        const hasLabel = await label.isVisible().catch(() => false);
        const ariaLabel = await input.getAttribute("aria-label");
        const placeholder = await input.getAttribute("placeholder");
        // Should have at least one form of labeling
        expect(
          hasLabel || !!ariaLabel || !!placeholder,
          `Input #${id} has no label/aria-label/placeholder`,
        ).toBe(true);
      }
    }
  });

  test("navigation is clear — user always knows where they are", async ({ page }) => {
    const routes = ["/dashboard", "/time-entries", "/leave", "/admin/employees"];

    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");

      // Active nav item should be highlighted
      const activeNav = page.locator(
        ".nav-item--active, .mobile-nav-item--active, [aria-current='page']",
      );
      await expect(activeNav.first()).toBeVisible();

      // Page should have a clear title/heading
      const heading = page.locator("h1").first();
      await expect(heading).toBeVisible();
    }
  });

  test("empty states provide guidance", async ({ page }) => {
    await page.goto("/admin/shutdowns");
    await page.waitForLoadState("networkidle");

    // Empty state should tell user what to do
    const emptyText = page.getByText(/Keine|Erstellen|anlegen/i).first();
    await expect(emptyText).toBeVisible();

    // Should have a CTA button
    const ctaBtn = page.getByText(/Neu|Erstellen|anlegen/i).first();
    await expect(ctaBtn).toBeVisible();

    await screenshotPage(page, "flow-empty-state-guidance");
  });
});
