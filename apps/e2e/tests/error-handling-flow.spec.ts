import { test, expect } from "../fixtures";
import { loginAsAdmin, loginAsTenantAdmin, screenshotPage, TEST_ADMIN } from "./helpers";

const WRONG_CURRENT_PASSWORD = "wrongcurrentpassword";

test.describe("Error Handling + UX Plausibility", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("profile password change — wrong current password shows error", async ({ page }) => {
    // Guard: this wrong value must never equal the seed admin's real password, otherwise the
    // request could succeed and rotate the credentials every other seed-login spec depends on.
    expect(WRONG_CURRENT_PASSWORD).not.toBe(TEST_ADMIN.password);

    // The What's-New drawer, which would intercept the pointer events aimed at the settings form,
    // is stubbed away by the `page` override of the `../fixtures` test.
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

    // 1. The page greets the user (PageHead h1 "Guten Morgen/Tag/Abend, <name>").
    await expect(page.getByTestId("dashboard-page").getByRole("heading", { level: 1 })).toHaveText(
      /Guten (Morgen|Tag|Abend)/,
    );

    // 2. The hero clock is prominent.
    const clock = page.locator(".timer-card-wrap .timer-display");
    await expect(clock).toBeVisible();
    const fontSize = await clock.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(24);

    // 3. The hero card and the KPI pair both start inside the device's first viewport. "Above the
    // fold" is measured against the device viewport, not a fixed 600px, which was a desktop-only
    // assumption: the layout goes single-column at max-width 900px (dashboard +page.svelte:2019),
    // where the KPI pair is stacked under the hero on Pixel 7 and iPad. In the two-column layout
    // both start in the same row, so "the KPI pair never starts above the hero" holds in both
    // without a viewport branch.
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const viewportHeight = viewport?.height ?? 0;

    const hero = page.locator(".timer-card-wrap");
    const kpiPair = page.locator(".kpi-pair");
    await expect(hero).toBeVisible();
    await expect(kpiPair).toBeVisible();
    const heroBox = await hero.boundingBox();
    const kpiBox = await kpiPair.boundingBox();
    expect(heroBox).not.toBeNull();
    expect(kpiBox).not.toBeNull();
    expect(heroBox?.y ?? Infinity).toBeLessThan(viewportHeight);
    expect(kpiBox?.y ?? Infinity).toBeLessThan(viewportHeight);
    expect(kpiBox?.y ?? -Infinity).toBeGreaterThanOrEqual((heroBox?.y ?? Infinity) - 1);

    await screenshotPage(page, "flow-dashboard-hierarchy");
  });

  test("forms have clear labels and placeholders", async ({ page }) => {
    await page.goto("/leave");
    await page.getByTestId("leave-new-request").click();
    const form = page.getByTestId("leave-form");
    await expect(form).toBeVisible();

    // Type, Von, Bis and Anmerkung at least: proves the loop below does not run over nothing.
    const controls = await form.locator("input:visible, select:visible, textarea:visible").all();
    expect(controls.length).toBeGreaterThanOrEqual(4);

    // Every visible control needs a label element (for= or wrapping), an aria-label, an
    // aria-labelledby or a placeholder. Controls without an id are checked too: skipping them
    // used to let the unlabelled ones through.
    for (const control of controls) {
      const result = await control.evaluate((el) => {
        const field = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const labelled =
          (field.labels?.length ?? 0) > 0 ||
          !!el.getAttribute("aria-label")?.trim() ||
          !!el.getAttribute("aria-labelledby")?.trim() ||
          !!el.getAttribute("placeholder")?.trim();
        return {
          name: el.id || el.getAttribute("name") || el.outerHTML.slice(0, 80),
          labelled,
        };
      });
      expect(
        result.labelled,
        `Control ${result.name} has no label/aria-label/aria-labelledby/placeholder`,
      ).toBe(true);
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

// Tests that write data, or that must stay anonymous, run with no stored login: they neither run
// as nor write onto the shared seed admin (the data-writing ones on a freshly bootstrapped tenant).
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

  test("login shows clear error on wrong credentials", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("E-Mail")).toBeVisible();
    await expect(page.getByLabel("Passwort", { exact: true })).toBeVisible();
    const submit = page.getByRole("button", { name: /anmelden/i });
    await expect(submit).toBeVisible();

    // An address no user owns: a KNOWN address with a wrong password raises that user's
    // failedLoginAttempts and locks the account after 5 (auth.ts), which for the seed admin would
    // break every seed-login spec.
    await page.getByLabel("E-Mail").fill("wrong@test.de");
    await page.getByLabel("Passwort", { exact: true }).fill("wrongpassword");

    // Register the response wait BEFORE the click so a fast answer cannot be missed.
    const responsePromise = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/v1/auth/login" && r.request().method() === "POST",
    );
    await submit.click();
    const response = await responsePromise;

    // auth.ts:67-69 answers an unknown user with 401 before any lockout bookkeeping.
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "Ungültige Anmeldedaten" });

    await expect(
      page.getByRole("alert").filter({ hasText: "Ungültige Anmeldedaten" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await screenshotPage(page, "flow-error-login");
  });

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
