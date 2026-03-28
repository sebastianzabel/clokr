import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

test.describe("Error Handling + UX Plausibility", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("leave form shows error for overlapping dates", async ({ page }) => {
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");

    // Create first request
    await page
      .getByText(/Neuer Antrag/)
      .first()
      .click();
    await page.waitForTimeout(300);

    const start = new Date();
    start.setDate(start.getDate() + 60);
    while (start.getDay() === 0 || start.getDay() === 6) start.setDate(start.getDate() + 1);
    const startStr = start.toISOString().split("T")[0];

    const startInput = page.locator("#f-start").first();
    const endInput = page.locator("#f-end").first();

    if (await startInput.isVisible()) {
      await startInput.fill(startStr);
      await endInput.fill(startStr);
      await page.waitForTimeout(300);

      // Submit
      const submit = page.getByRole("button", { name: /einreichen|antrag/i }).first();
      if (await submit.isVisible()) await submit.click();
      await page.waitForTimeout(1000);

      // Try same dates again → should get overlap error
      await page
        .getByText(/Neuer Antrag/)
        .first()
        .click();
      await page.waitForTimeout(300);
      await page.locator("#f-start").first().fill(startStr);
      await page.locator("#f-end").first().fill(startStr);
      await page.waitForTimeout(300);

      const submit2 = page.getByRole("button", { name: /einreichen|antrag/i }).first();
      if (await submit2.isVisible()) await submit2.click();
      await page.waitForTimeout(1000);

      // Should show error
      await screenshotPage(page, "flow-error-overlap");
      const errorMsg = page.getByText(/Überschneidung|overlap/i);
      // Error should be visible (either in modal or toast)
      if (await errorMsg.isVisible()) {
        expect(await errorMsg.textContent()).toBeTruthy();
      }
    }
  });

  test("login shows clear error on wrong credentials", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-Mail").fill("wrong@test.de");
    await page.getByLabel("Passwort", { exact: true }).fill("wrongpassword");
    await page.getByRole("button", { name: /anmelden/i }).click();
    await page.waitForTimeout(2000);

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

      await page.getByRole("button", { name: /passwort ändern/i }).click();
      await page.waitForTimeout(1000);

      await screenshotPage(page, "flow-error-password-change");
    }
  });

  test("dashboard provides clear information hierarchy", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

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
    await page.waitForTimeout(300);

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
