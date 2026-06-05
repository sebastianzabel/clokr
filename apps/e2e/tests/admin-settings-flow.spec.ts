/**
 * Admin Settings flow — Phase 73-05 migration.
 *
 * Migrated from CSS-class selectors + global admin login to the Phase 73-02
 * `tenant` fixture + data-testid selectors introduced in 73-05. Each test
 * gets its own isolated tenant (D-04), so parallel workers don't clobber
 * each other; the suite no longer relies on the shared dev-seed admin user.
 *
 * Selectors used:
 *  - sidebar nav: `nav-${slug}` (Sidebar.svelte, derived from href)
 *  - admin/employees: `admin-employees-page`, `admin-employees-add`,
 *      `admin-employees-row-${id}-edit`, ...
 *  - admin/system: `admin-system-page`, `admin-system-${section}-${field}`,
 *      `admin-system-${section}-save`
 *  - admin/month-close: `month-close-page`, `month-close-row-${month}-trigger`,
 *      `month-close-modal`, `month-close-confirm`
 *
 * waitForTimeout — all 6 occurrences removed in scope, replaced with
 * `expect(...).toBeVisible()` or `page.waitForResponse(...)`. Phase 73-06
 * will add the ESLint rule that bans waitForTimeout in this directory.
 */
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import type { Page } from "@playwright/test";

// Login to a freshly-bootstrapped test tenant. Mirrors the contract baked
// into apps/api/src/routes/test-bootstrap.ts:
//   admin email = `admin@${tenantId}.test`
//   admin password = TEST_PASSWORD ("test1234")
// We intentionally do NOT inject the bearer token into localStorage — the
// dashboard layout reads tenant features via the API, and going through the
// real login form proves the JWT + refresh-token flow works end-to-end.
async function loginAsTenantAdmin(page: Page, tenant: TestTenant): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(`admin@${tenant.tenantId}.test`);
  await page.getByLabel("Passwort", { exact: true }).fill("test1234");
  await page.getByRole("button", { name: /anmelden/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 10_000 });
}

test.describe("Admin Settings — Complete Flow", () => {
  test("sidebar surfaces admin-area nav links", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    // The sidebar is the global navigation — once these test-ids exist,
    // every spec gets refactor-resilient nav.
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("nav-admin-employees")).toBeVisible();
    await expect(page.getByTestId("nav-admin-vacation")).toBeVisible();
    await expect(page.getByTestId("nav-admin-month-close")).toBeVisible();
    await expect(page.getByTestId("nav-admin-system")).toBeVisible();
  });

  test("admin system — security section visible", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/admin/system");
    await expect(page.getByTestId("admin-system-page")).toBeVisible();
    // Sicherheit tab — 2FA toggle is the test-id we own from 73-05.
    await page.getByRole("tab", { name: /Sicherheit/i }).click();
    await expect(page.getByTestId("admin-system-sicherheit-twoFaEnabled")).toBeVisible();
  });

  test("admin system — toggle 2FA", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/admin/system");
    await page.getByRole("tab", { name: /Sicherheit/i }).click();
    const toggle = page.getByTestId("admin-system-sicherheit-twoFaEnabled");
    await expect(toggle).toBeVisible();

    // The toggle is a visually-hidden checkbox wrapped by .switch — read the
    // state, click via the surrounding label (the input itself has 0 size),
    // and assert the value flipped.
    const before = await toggle.isChecked();
    await page.locator("label.switch", { has: toggle }).click();
    await expect(toggle).toBeChecked({ checked: !before });
    // Flip back so we don't leave the tenant in a weird state for any
    // follow-up assertion (tenant gets torn down anyway, but explicit > implicit).
    await page.locator("label.switch", { has: toggle }).click();
  });

  test("admin system — save password policy round-trip", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/admin/system");
    await page.getByRole("tab", { name: /Sicherheit/i }).click();

    const minLength = page.getByTestId("admin-system-password-minLength");
    await expect(minLength).toBeVisible();

    const before = parseInt(await minLength.inputValue(), 10);
    const next = before === 12 ? 14 : 12;
    await minLength.fill(String(next));

    // Listen for the save API call so we know the round-trip completed
    // without relying on a fragile timeout.
    const savePromise = page.waitForResponse(
      (res) => res.url().includes("/password-policy") && res.request().method() === "PUT",
    );
    await page.getByTestId("admin-system-password-save").click();
    await savePromise;

    await page.reload();
    await page.getByRole("tab", { name: /Sicherheit/i }).click();
    await expect(page.getByTestId("admin-system-password-minLength")).toHaveValue(String(next));
  });

  test("admin employees — open list", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/admin/employees");
    await expect(page.getByTestId("admin-employees-page")).toBeVisible();
    await expect(page.getByTestId("admin-employees-add")).toBeVisible();
    await expect(page.getByTestId("admin-employees-search")).toBeVisible();
  });

  test("admin employees — search input narrows the list", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/admin/employees");
    const search = page.getByTestId("admin-employees-search");
    await search.fill("zzzz-no-such-person");
    // Filter is reactive (Svelte $derived) — the row count drops on the
    // next render frame. Asserting the empty body avoids a timeout-based
    // wait.
    await expect(page.locator("[data-testid^='admin-employees-row-']")).toHaveCount(0);
    await search.fill("");
  });

  test("admin monatsabschluss — page renders with year filter", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/admin/month-close");
    await expect(page.getByTestId("month-close-page")).toBeVisible();
    await expect(page.getByTestId("month-close-year")).toBeVisible();
    // A fresh tenant has no time entries yet, so every month is `no_data`.
    // The row test-ids prove the table rendered all 12 months.
    for (let m = 1; m <= 12; m++) {
      await expect(page.getByTestId(`month-close-row-${m}`)).toBeVisible();
    }
  });
});
