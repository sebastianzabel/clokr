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
import type { Locator, Page } from "@playwright/test";

// Track the seed result across the test lifecycle so afterEach can drop the
// tenant. Using an outer Map keyed by testInfo.testId avoids leakage between
// parallel workers (each worker has its own module state).
const seedByTest = new Map<string, { tenantId: string; apiBaseUrl: string }>();

test.beforeEach(async ({ page, request }, testInfo) => {
  // Freeze "now" at 2025-06-16T08:00:00Z (Mon) so every component reading
  // `new Date()` snaps to the same instant. Time-entries page defaults to
  // the current month → June 2025; shifts page defaults to the current
  // week → 2025-W25 (June 16–22). Past date so the API's future-entry
  // guard accepts every seeded shift regardless of real clock.
  await page.clock.install({ time: new Date(ANCHOR_DATE) });

  // Bootstrap + seed the deterministic tenant. The login response gives us
  // accessToken + refreshToken + user; we inject all three into localStorage
  // BEFORE any page script runs so the SvelteKit auth store hydrates with
  // the test-tenant identity instead of the dev-stack one from .auth/admin.json.
  const seed = await seedDeterministicTenant(request);
  seedByTest.set(testInfo.testId, {
    tenantId: seed.tenantId,
    apiBaseUrl: process.env.E2E_API_BASE ?? "http://localhost:4001",
  });

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

test.afterEach(async ({ request }, testInfo) => {
  // Tear down the seeded tenant so the next test (or the next run) can
  // re-create employees with the same employeeNumbers without colliding
  // on User.email's global unique index. Mirrors the Phase 73-02 tenant
  // fixture's KEEP_TEST_TENANTS escape hatch — set the env var to skip
  // teardown when debugging a flaky baseline.
  if (process.env.KEEP_TEST_TENANTS === "true") return;
  const ctx = seedByTest.get(testInfo.testId);
  if (!ctx) return;
  seedByTest.delete(testInfo.testId);
  await request.delete(`${ctx.apiBaseUrl}/api/v1/test/tenant/${ctx.tenantId}`).catch(() => {
    /* teardown is best-effort; a stale tenant will be cleaned by the
       next bootstrap call's email uniqueness check or by the nightly
       test-tenant sweep (Phase 73 follow-up). */
  });
});

/**
 * Issue #845: the parts of Ich › Mein Tag whose text follows the server's real date (the visual
 * seed freezes only the browser clock): the Stundenkonto value with its line below, and the titles
 * and subtitles of the „Für dich“ rows.
 */
function realDateMasks(page: Page): Locator[] {
  const saldo = page.getByTestId("kpi-saldo");
  const forYou = page.getByRole("list", { name: "Für dich", exact: true });
  return [
    saldo.locator(".kpi-value"),
    saldo.locator(".kpi-explanation"),
    forYou.locator(".list-title"),
    forYou.locator(".list-subtitle"),
  ];
}

test.describe("Phase 75 — Visual baselines", () => {
  test("01 — Dashboard", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-page")).toBeVisible();
    // Dashboard renders chart.js widgets; wait for the network to settle so
    // every KPI fetch is reflected in the screenshot.
    await page.waitForLoadState("networkidle");
    // Mask the chart.js <canvas> elements: canvas rasterization is non-deterministic
    // across runs/renders (observed as byte-differing screenshots between retries in
    // the same CI run), which would flake the baseline. Masking excludes those regions
    // from the comparison while still validating the surrounding layout.
    // Issue #588 (P-13): the card "Salden" shows figures the server computes against the real
    // date (the visual seed freezes only the browser clock), so its names order, values and median
    // move every day. The mask keeps the card's frame, heading and position in the comparison.
    // Issue #845: Mein Tag shows two more figures the server computes against the real date — the
    // Stundenkonto (saldo through yesterday) and the missing days under „Für dich“ (the newest
    // workdays without an entry). Same reasoning as P-13: the values are masked, the KPI cell, the
    // rows, their chips and buttons stay in the comparison.
    await expect(page).toHaveScreenshot("01-dashboard.png", {
      fullPage: true,
      mask: [page.locator("canvas"), page.getByTestId("team-saldo-values"), ...realDateMasks(page)],
    });
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
    // Filter to "VIS" so the non-deterministic bootstrap admin row
    // (employeeNumber: `A-{tenantId.slice(-4)}`, last-login timestamp,
    // email with random hex) is excluded — only the 4 deterministic
    // VIS-001..VIS-004 employees remain in the snapshot.
    await page.getByRole("searchbox", { name: "Personen suchen" }).fill("VIS");
    // Re-anchor on the page after debounce so the filtered table is rendered
    // before the screenshot fires.
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
    // Mask chart.js <canvas> (non-deterministic rasterization) — see test 01 — and the figures of
    // the card "Salden" (Issue #588, P-13: they move with the server's real date).
    // Issue #845: the real-date figures of Mein Tag — see test 01.
    await expect(page).toHaveScreenshot("10-mobile-dashboard.png", {
      fullPage: true,
      mask: [page.locator("canvas"), page.getByTestId("team-saldo-values"), ...realDateMasks(page)],
    });
  });

  // Issue #843 (D-843-04): the example page of the design-system blocks. One screenshot per
  // theme x mode frame (six); the page reads no API data. The baselines are taken from the CI
  // artifact (plan 843-36), never from a local render.
  test("11 — Bausteine", async ({ page }) => {
    await page.goto("/admin/bausteine");
    await expect(page.locator('[data-testid="bausteine-page"]')).toBeVisible();
    await page.waitForLoadState("networkidle");
    // The frames are taller than the viewport, so an element screenshot scrolls the page, and the
    // sticky chrome (the Topbar, the SaveBar of the form demo) lands inside each image at an offset
    // that depends on that scroll position. For this test only the chrome sits in the flow: the
    // product behaviour is untouched, the six frames just no longer depend on where the page was
    // scrolled to when the screenshot fired.
    await page.addStyleTag({
      content: ".topbar, .save-bar { position: static !important; }",
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    // Soft: a changed frame must not hide the state of the frames after it, so one CI run reports
    // (and the artifact carries) every frame that differs. The test still fails on any mismatch.
    for (const theme of ["pflaume", "salz", "petrol"]) {
      for (const mode of ["light", "dark"]) {
        await expect
          .soft(page.getByTestId(`bausteine-frame-${theme}-${mode}`))
          .toHaveScreenshot(`11-bausteine-${theme}-${mode}.png`);
      }
    }
  });
});
