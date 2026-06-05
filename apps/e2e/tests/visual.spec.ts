/**
 * Phase 75 — Visual regression baselines (D-01).
 *
 * 10 screenshots covering the operator's most re-checked surfaces. Each spec:
 *   1. Seeds a deterministic tenant via the Phase 73 bootstrap endpoint
 *      (apps/e2e/fixtures/visual-seed.ts).
 *   2. Freezes the browser clock at 2026-06-15T08:00:00Z so calendar widgets
 *      land on the same week/month every run.
 *   3. Hydrates the SvelteKit auth store via `addInitScript` so the page
 *      loads logged-in as the test-tenant admin (NOT the default
 *      .auth/admin.json which targets a dev-stack tenant that doesn't exist
 *      on docker-compose.test.yml).
 *   4. Navigates and waits on a Phase 73-04/-05 `data-testid="<surface>-page"`
 *      anchor — no `waitForTimeout`.
 *   5. Takes a full-page screenshot — threshold inherited from the
 *      `visual` project (D-04: maxDiffPixelRatio 0.002).
 *
 * To re-baseline (D-05):
 *   docker compose -f docker-compose.e2e.yml run --rm e2e-visual \
 *     pnpm --filter e2e exec playwright test --project=visual --update-snapshots
 *   git add apps/e2e/tests/visual.spec.ts-snapshots/
 *   git commit -m "feat(75): re-baseline <page> after <change>"
 *
 * Auth strategy note: the visual project sets `storageState: ".auth/admin.json"`
 * (Phase 73-07), which loads the dev-stack admin credentials. We replace those
 * in `beforeEach` via `addInitScript` so each test logs in as a fresh
 * test-tenant admin (whose user exists, whose tenant has the seed data).
 */
import { visualTest as test, expect } from "./visual.setup";
import { seedDeterministicTenant, ANCHOR_DATE } from "../fixtures/visual-seed";

test.beforeEach(async ({ page, request }) => {
  // Freeze "now" at 2026-06-15T08:00:00Z so every component reading
  // `new Date()` snaps to the same instant. Time-entries page defaults to
  // the current month → June 2026; shifts page defaults to the current
  // week → 2026-W24 (June 8–14).
  await page.clock.install({ time: new Date(ANCHOR_DATE) });

  // Bootstrap + seed the deterministic tenant. The login response gives us
  // accessToken + refreshToken + user; we inject all three into localStorage
  // BEFORE any page script runs so the SvelteKit auth store hydrates with
  // the test-tenant identity instead of the dev-stack one from .auth/admin.json.
  const seed = await seedDeterministicTenant(request);
  await page.addInitScript(({ accessToken, refreshToken, user }) => {
    try {
      localStorage.setItem("accessToken", accessToken);
      localStorage.setItem("refreshToken", refreshToken);
      localStorage.setItem("user", JSON.stringify(user));
    } catch {
      /* localStorage may be locked in some contexts — auth store will fall back */
    }
  }, seed.auth);
});

test.describe("Phase 75 — Visual baselines", () => {
  test("01 — Dashboard", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-page")).toBeVisible();
    // Dashboard renders chart.js widgets; wait for the network to settle so
    // every KPI fetch is reflected in the screenshot.
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("01-dashboard.png", { fullPage: true });
  });

  test("02 — Zeiterfassung Kalender", async ({ page }) => {
    await page.goto("/time-entries");
    await expect(page.getByTestId("time-entries-page")).toBeVisible();
    // The calendar view is the default; the calendar grid is the deterministic
    // "data fully loaded" marker (rendered after the month-fetch resolves).
    await expect(page.getByTestId("calendar-grid")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("02-zeiterfassung-calendar.png", { fullPage: true });
  });

  test("03 — Zeiterfassung Liste", async ({ page }) => {
    await page.goto("/time-entries?view=list");
    await expect(page.getByTestId("time-entries-page")).toBeVisible();
    await expect(page.getByTestId("time-entries-list")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("03-zeiterfassung-list.png", { fullPage: true });
  });

  test("04 — Urlaub Overview", async ({ page }) => {
    await page.goto("/leave");
    await expect(page.getByTestId("leave-page")).toBeVisible();
    await expect(page.getByTestId("leave-balance")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("04-urlaub-overview.png", { fullPage: true });
  });

  test("05 — Urlaub Form (Neuantrag)", async ({ page }) => {
    await page.goto("/leave");
    await expect(page.getByTestId("leave-page")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.getByTestId("leave-new-request").click();
    await expect(page.getByTestId("leave-form-modal")).toBeVisible();
    await expect(page.getByTestId("leave-form")).toBeVisible();
    await expect(page).toHaveScreenshot("05-urlaub-form.png", { fullPage: true });
  });

  test("06 — Schichtplan Wochen-Grid", async ({ page }) => {
    await page.goto("/shifts");
    await expect(page.getByTestId("shifts-page")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("06-schichtplan-wochen-grid.png", { fullPage: true });
  });

  test("07 — Admin Mitarbeiter Liste", async ({ page }) => {
    await page.goto("/admin/employees");
    await expect(page.getByTestId("admin-employees-page")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("07-admin-employees-list.png", { fullPage: true });
  });

  test("08 — Admin System", async ({ page }) => {
    await page.goto("/admin/system");
    await expect(page.getByTestId("admin-system-page")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("08-admin-system.png", { fullPage: true });
  });

  test("09 — Monatsabschluss", async ({ page }) => {
    await page.goto("/admin/month-close");
    await expect(page.getByTestId("month-close-page")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("09-monatsabschluss.png", { fullPage: true });
  });

  test("10 — Mobile Dashboard", async ({ page }) => {
    // Per T-75-03 in CONTEXT.md: fixed viewport for mobile baseline to avoid
    // device-profile drift. We re-set the viewport here instead of using a
    // separate project so the seed/login path stays identical.
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14 logical
    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-page")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("10-mobile-dashboard.png", { fullPage: true });
  });
});
