import { test, expect } from "../fixtures";
import { loginAsAdmin, loginAsTenantAdmin, screenshotPage, TEST_ADMIN } from "./helpers";

const WRONG_CURRENT_PASSWORD = "wrongcurrentpassword";

test.describe("Error Handling + UX Plausibility", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
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
    // Guard: this wrong value must never equal the seed admin's real password, otherwise the
    // request could succeed and rotate the credentials every other seed-login spec depends on.
    expect(WRONG_CURRENT_PASSWORD).not.toBe(TEST_ADMIN.password);

    // Same stub as suppressWhatsNew() in apps/e2e/fixtures/tenant.ts (module-private, so inlined
    // here). The What's-New drawer auto-opens for a user who never dismissed it — i.e. on every
    // freshly seeded stack — and intercepts the pointer events aimed at the settings form.
    await page.route("**/api/v1/release-notes*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ releases: [] }),
      }),
    );

    await page.goto("/settings");

    const curPw = page.locator("#cur-pw");
    const newPw = page.locator("#new-pw");
    const confirmPw = page.locator("#confirm-pw");

    // A missing form must fail the test, never skip its body.
    await expect(curPw).toBeVisible();
    await expect(newPw).toBeVisible();
    await expect(confirmPw).toBeVisible();

    await curPw.fill(WRONG_CURRENT_PASSWORD);
    await newPw.fill("NewStr0ng!Pass#42");
    await confirmPw.fill("NewStr0ng!Pass#42");

    const submit = page.getByRole("button", { name: "Passwort ändern", exact: true });
    await expect(submit).toBeEnabled();

    // Register the response wait BEFORE the click so a fast answer cannot be missed.
    const responsePromise = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/auth/change-password" &&
        r.request().method() === "POST",
    );
    await submit.click();
    const response = await responsePromise;

    // auth.ts compares the current password with bcrypt and answers 400 BEFORE any update, so
    // a wrong current password can never change the stored one. The route is rate-limited to
    // 5 requests per 15 minutes per client IP; this test spends exactly one per project run.
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: "Aktuelles Passwort ist falsch" });

    // Toasts carry no test id; the component renders `toast toast-{type}` (Toast.svelte).
    await expect(
      page.locator(".toast-error").filter({ hasText: "Aktuelles Passwort ist falsch" }),
    ).toBeVisible();
    // The success toast "Passwort geändert" must never appear.
    await expect(page.locator(".toast-success")).toHaveCount(0);

    await screenshotPage(page, "flow-error-password-change");
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

// Tests that write data run on a freshly bootstrapped tenant with no stored login: they neither
// run as nor write onto the shared seed admin.
test.describe("Error Handling — own tenant", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // A weekday ~3 weeks ahead. The time is pinned to local noon BEFORE formatting so toISOString()
  // cannot cut the date over a UTC midnight straddle (issue #34).
  function futureWeekday(offsetDays: number): string {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  test("leave form shows error for overlapping dates", async ({ page, tenant }) => {
    const day = futureWeekday(21);
    const headers = { authorization: `Bearer ${tenant.adminToken}` };

    // Precondition via the API: one SICK request on the day. SICK against an existing PENDING or
    // APPROVED SICK is blocked in every status (leave.ts:582-599), so this does not depend on
    // whether SICK auto-approves; SICK is also exempt from the lead-time and advance checks.
    const created = await page.request.post("/api/v1/leave/requests", {
      headers,
      data: { type: "SICK", startDate: day, endDate: day },
    });
    expect(created.status()).toBe(201);

    await loginAsTenantAdmin(page, tenant);
    await page.goto("/leave");
    await page.getByTestId("leave-new-request").click();
    await expect(page.getByTestId("leave-form")).toBeVisible();

    await page.getByTestId("leave-form-type").selectOption("SICK");
    await page.getByTestId("leave-form-from").fill(day);
    await page.getByTestId("leave-form-to").fill(day);

    // Register the response wait BEFORE the click so a fast answer cannot be missed.
    const responsePromise = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/leave/requests" && r.request().method() === "POST",
    );
    await page.getByTestId("leave-form-submit").click();
    const response = await responsePromise;

    // leave.ts:598-599 rejects the overlap with 409 and exactly this body.
    expect(response.status()).toBe(409);
    expect(await response.json()).toEqual({ error: "Überschneidung mit bestehendem Antrag" });

    // LeaveRequestForm keeps the form open on an API error and shows the message inline
    // (LeaveRequestForm.svelte:544-551/569-576). No zero-error-toast assertion: the appointment
    // collision pre-check may legitimately raise a toast on a tenant without Phorest.
    await expect(page.getByTestId("leave-form-error")).toContainText(
      "Überschneidung mit bestehendem Antrag",
    );
    await expect(page.getByTestId("leave-form")).toBeVisible();
    await expect(page.locator(".toast-success")).toHaveCount(0);

    // The rejected submission must not have written a second row.
    const list = await page.request.get("/api/v1/leave/requests", { headers });
    expect(list.ok()).toBe(true);
    const rows = (await list.json()) as { startDate: string }[];
    expect(rows.filter((r) => r.startDate.slice(0, 10) === day)).toHaveLength(1);

    await screenshotPage(page, "flow-error-overlap");
  });
});
