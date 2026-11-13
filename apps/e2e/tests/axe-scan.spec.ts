import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * a11y gate for Phase 70 (DEVOPS-V8-05), made real and blocking by Phase 275 /
 * Issue #275 (D-08). Scoped to the PUBLIC pages only (no auth) — full
 * authenticated-page coverage requires the docker-compose webServer: from
 * Phase 73, and remains open (not scheduled).
 *
 * This assertion CAN fail (`toEqual([])`), and a failure DOES block the PR:
 * the `axe-scan` CI job's `continue-on-error: true` was removed in the same
 * phase (`.github/workflows/ci.yml`).
 *
 * Issue #855 (D-855-09): extended from /login to every signed-out page and each of
 * its states, plus the 404 page. The job runs the built web app without an API, so
 * the few API calls these pages make are answered by `page.route` — the scan is about
 * the markup of each state, not about the server.
 */

const POLICY = {
  passwordMinLength: 12,
  passwordRequireUpper: true,
  passwordRequireLower: true,
  passwordRequireDigit: true,
  passwordRequireSpecial: true,
};

async function mockApi(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/auth/password-policy")) {
      return route.fulfill({ status: 200, json: POLICY });
    }
    if (url.pathname.endsWith("/auth/login")) {
      return route.fulfill({ status: 401, json: { error: "Ungültige Anmeldedaten" } });
    }
    return route.fulfill({ status: 404, json: { error: "Nicht gefunden" } });
  });
}

async function expectNoViolations(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  // The sign-in frame is the landmark every state renders; wait for it before scanning.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();

  // Log violations for diagnosability — the assertion below fails on any non-empty
  // violation list, so this listing is what makes a red run actionable.
  if (results.violations.length > 0) {
    console.warn(`[axe-scan] Found ${results.violations.length} a11y violations on ${label}:`);
    for (const v of results.violations) {
      console.warn(`  - [${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`);
    }
  }

  // Real assertion (Phase 275 / Issue #275, D-08).
  expect(results.violations).toEqual([]);
}

test.describe("axe a11y scan — public pages", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("login page has no WCAG 2 A/AA violations", async ({ page }) => {
    await page.goto("/login");
    await expectNoViolations(page, "/login");
  });

  test("login page with a refused sign-in has no violations", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-Mail").fill("nobody@test.invalid");
    await page.getByLabel("Passwort", { exact: true }).fill("wrongpassword123");
    await page.getByRole("button", { name: /anmelden/i }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Ungültige Anmeldedaten");
    await expectNoViolations(page, "/login (Fehler)");
  });

  test("2FA page has no violations", async ({ page }) => {
    // The page sends a visitor without a pending sign-in back to /login.
    await page.addInitScript(() => sessionStorage.setItem("otp_userId", "axe-user"));
    await page.goto("/otp");
    await expect(page.getByLabel("6-stelliger Code")).toBeVisible();
    await expectNoViolations(page, "/otp");
  });

  test("password forgotten page has no violations", async ({ page }) => {
    await page.goto("/forgot-password");
    await expectNoViolations(page, "/forgot-password");
  });

  test("password reset page with a token has no violations", async ({ page }) => {
    await page.goto("/reset-password?token=axe-token");
    await expect(page.getByRole("textbox", { name: "Neues Passwort" })).toBeVisible();
    await expectNoViolations(page, "/reset-password");
  });

  test("password reset page without a token has no violations", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expectNoViolations(page, "/reset-password (ohne Link)");
  });

  test("invitation page with a token has no violations", async ({ page }) => {
    await page.goto("/invitation?token=axe-token");
    await expect(page.getByLabel("Passwort bestätigen")).toBeVisible();
    await expectNoViolations(page, "/invitation");
  });

  test("invitation page without a token has no violations", async ({ page }) => {
    await page.goto("/invitation");
    await expect(page.getByRole("heading", { name: "Link ungültig" })).toBeVisible();
    await expectNoViolations(page, "/invitation (ungültig)");
  });

  test("404 page has no violations and a way back", async ({ page }) => {
    const res = await page.goto("/diese-seite-gibt-es-nicht");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Diese Seite gibt es nicht." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Zur Startseite" })).toHaveAttribute("href", "/");
    await expectNoViolations(page, "404");
  });
});
