/**
 * Phase 73-08 functional.spec.ts — the canonical happy-path suite (D-11).
 *
 * Consolidates the non-overlapping content from the six pre-Phase-73 audit
 * specs that were deleted in 73-08:
 *
 *   - ui-audit.spec.ts          (sidebar + mobile shell render)
 *   - ux-quality.spec.ts        (modal closes on Escape, save confirmation)
 *   - ux-design-audit.spec.ts   (primary actions reachable from each page)
 *   - dynamic-audit.spec.ts     (pages render with content, no horizontal overflow)
 *   - ui-quality.spec.ts        (advisory-only — covered by Phase 75 visual regression)
 *   - visual-audit.spec.ts      (screenshot-only — covered by Phase 75)
 *
 * Anything more specific than a smoke check belongs in a domain spec:
 *   - clock-in / clock-out      → core-flows.spec.ts
 *   - time-entry CRUD           → time-entries-flow.spec.ts
 *   - leave-request flow        → leave-flow.spec.ts
 *   - admin settings            → admin-settings-flow.spec.ts
 *   - month close               → monatsabschluss.spec.ts
 *   - accessibility violations  → accessibility.spec.ts + axe-scan.spec.ts
 *
 * Conventions (Phase 73 rules):
 *   - `from "../fixtures"` (Plan 73-02 tenant fixture; per-test isolation D-04).
 *   - `getByTestId(...)` for every interactive element (Plans 73-03/04/05).
 *   - NO `page.waitForTimeout()` (Plan 73-06 ESLint rule).
 *   - No `.only`, no committed debug logging.
 */
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import type { Page } from "@playwright/test";

const TEST_PASSWORD = "test1234";

/**
 * UI login through the public /login form. Mirrors leave-flow.spec.ts so the
 * happy-path here exercises the same shell as the domain specs.
 */
async function loginAsTenantAdmin(page: Page, tenant: TestTenant): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(`admin@${tenant.tenantId}.test`);
  await page.getByLabel("Passwort", { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /anmelden/i }).click();
  await page.waitForURL(/\/(ich|team|verwalten)(\/|$)/, { timeout: 10_000 }); // #844: the start page
}

test.describe("Functional — happy paths across primary surfaces", () => {
  test.describe("Dashboard", () => {
    test("renders timer card + greeting after login", async ({ page, tenant }) => {
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/dashboard");

      // Timer card is the dashboard hero (Phase 49.4). It always exposes
      // either an Einstempeln or Ausstempeln button — fail loudly if neither
      // mounts (covers the "no empty pages" advisory from dynamic-audit).
      const stempelBtn = page.getByRole("button", { name: /(Ein|Aus)stempeln/ });
      await expect(stempelBtn.first()).toBeVisible({ timeout: 10_000 });

      // Greeting at the top of the page proves the auth-store hydrated and
      // the user data resolved (the PageHead sub line "Guten Morgen/Tag/Abend, ...", Issue #574).
      await expect(page.getByText(/Guten (Morgen|Tag|Abend)/)).toBeVisible();
    });

    test("primary clock action is reachable above the fold", async ({ page, tenant }) => {
      // Merged from ux-design-audit.spec.ts "critical actions reachable within 2 clicks"
      // — clock-in is the headline primary action; if it isn't visible the
      // dashboard hero is broken.
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/dashboard");

      const stempelBtn = page.getByRole("button", { name: /(Ein|Aus)stempeln/ }).first();
      await expect(stempelBtn).toBeVisible({ timeout: 10_000 });

      // Above the fold = within the first 800px (covers both desktop + tablet
      // viewports configured in playwright.config.ts).
      const box = await stempelBtn.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeLessThan(800);
    });

    test("Heute im Salon carries no saldo card and no team chart (#846 D-04)", async ({
      page,
      tenant,
    }) => {
      // Issue #846 (owner decision D-04): the card "Salden" (#588) and the three team charts (#591)
      // left the start page; they move to Verwalten › Berichte with #895. Positive control first:
      // the Kennzahlen-Band has rendered, so the absences below are measured on a loaded page.
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/team/heute");
      await expect(page.getByTestId("kpi-present")).toBeVisible({ timeout: 15_000 });
      await page.waitForLoadState("networkidle");

      await expect(page.locator(".team-saldo-card")).toHaveCount(0);
      await expect(page.locator("canvas")).toHaveCount(0);
      await expect(page.getByRole("link", { name: /im Bericht öffnen$/ })).toHaveCount(0);
    });
  });

  // Issue #846 (D-04): the team charts left Heute im Salon and come back under Verwalten › Berichte
  // with #895. Their drill-down contract (#591: a month column and the header link open the report
  // of those months) stays here as the acceptance of that page; #895 points the two tests at their
  // new place and removes the fixme. Until then there is no page that draws these charts.
  test.describe("Dashboard charts", () => {
    test.fixme("a month of the team charts opens the report of that month", async ({
      page,
      tenant,
    }) => {
      // Issue #591 (AC-591-3, D-591-3): the header links "Bericht →" and the click on a month
      // column both lead to the reports page; the URL is written by the reports page's own
      // serialiser, so the expectations below are the contract /reports?from&to&tab.
      const MONTH_NAMES = [
        "Januar",
        "Februar",
        "März",
        "April",
        "Mai",
        "Juni",
        "Juli",
        "August",
        "September",
        "Oktober",
        "November",
        "Dezember",
      ];
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/team/heute"); // #844: the team block lives on Team › Heute im Salon

      const hoursCanvas = page.getByRole("img", {
        name: /^(Gruppiertes )?Säulendiagramm: .*Arbeitsstunden/,
      });
      const trendCanvas = page.getByRole("img", { name: /^Liniendiagramm: Überstunden-Saldo/ });
      const sickCanvas = page.getByRole("img", { name: /^Säulendiagramm: Krankheitstage/ });
      await expect(hoursCanvas).toBeVisible({ timeout: 15_000 });
      await expect(trendCanvas).toBeVisible({ timeout: 15_000 });
      await expect(sickCanvas).toBeVisible({ timeout: 15_000 });

      // The keyboard path: one header link per chart to the chart's six months.
      const hoursLink = page.getByRole("link", { name: "Arbeitsstunden im Bericht öffnen" });
      const trendLink = page.getByRole("link", { name: "Überstunden-Trend im Bericht öffnen" });
      const sickLink = page.getByRole("link", { name: "Krankheitstage im Bericht öffnen" });
      await expect(hoursLink).toHaveAttribute(
        "href",
        /^\/reports\?from=\d{4}-\d{2}&to=\d{4}-\d{2}&tab=zeiten$/,
      );
      await expect(trendLink).toHaveAttribute(
        "href",
        /^\/reports\?from=\d{4}-\d{2}&to=\d{4}-\d{2}&tab=zeiten$/,
      );
      await expect(sickLink).toHaveAttribute(
        "href",
        /^\/reports\?from=\d{4}-\d{2}&to=\d{4}-\d{2}&tab=urlaub$/,
      );
      const hoursHref = (await hoursLink.getAttribute("href")) ?? "";
      const lastMonth = /to=(\d{4}-\d{2})/.exec(hoursHref)?.[1] ?? "";
      expect(lastMonth).toMatch(/^\d{4}-\d{2}$/);

      // The mouse path: a click inside the plot area at 90 % of the canvas width and 45 % of its
      // height. The chart answers by month column (index mode, not by bar), so any height inside
      // the plot area hits; 90 % of the width lies inside the last of the six columns, right of the
      // value axis and left of the chart's right padding.
      await hoursCanvas.scrollIntoViewIfNeeded();
      await page.waitForLoadState("networkidle");
      const box = await hoursCanvas.boundingBox();
      expect(box).not.toBeNull();
      await hoursCanvas.click({ position: { x: box!.width * 0.9, y: box!.height * 0.45 } });

      await page.waitForURL(/\/verwalten\/berichte\?from=(\d{4}-\d{2})&to=\1&tab=zeiten/);
      expect(new URL(page.url()).searchParams.get("to")).toBe(lastMonth);
      const [year, month] = lastMonth.split("-").map(Number);
      await expect(page.getByTestId("reports-period-label")).toContainText(
        `${MONTH_NAMES[month - 1]} ${year}`,
      );
    });

    test.fixme("the header link of Krankheitstage opens the urlaub tab over the chart's months", async ({
      page,
      tenant,
    }) => {
      // Issue #591 (P-591-06): a canvas click is not keyboard-operable, so the same drill-down
      // exists as a link in the card header.
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/team/heute"); // #844: the team block lives on Team › Heute im Salon

      const sickLink = page.getByRole("link", { name: "Krankheitstage im Bericht öffnen" });
      await expect(sickLink).toBeVisible({ timeout: 15_000 });
      const href = (await sickLink.getAttribute("href")) ?? "";
      expect(href).toMatch(/^\/reports\?from=\d{4}-\d{2}&to=\d{4}-\d{2}&tab=urlaub$/);

      await sickLink.click();
      await page.waitForURL(/\/verwalten\/berichte\?from=\d{4}-\d{2}&to=\d{4}-\d{2}&tab=urlaub/);
      // #844: the link's /reports URL redirects to Verwalten › Berichte and keeps its whole query
      expect(page.url()).toContain(href.replace(/^\/reports\?/, "/verwalten/berichte?"));
    });
  });

  test.describe("Sidebar navigation", () => {
    test("primary nav links route to the expected URLs", async ({ page, tenant }) => {
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/dashboard");

      // Sidebar testid surface (Phase 73-05). `nav-{slug}` is generated by
      // Sidebar.svelte's `navSlug(href)` helper — keys never drift from the
      // route table.
      await expect(page.getByTestId("sidebar")).toBeVisible();
      await expect(page.getByTestId("sidebar-brand")).toBeVisible();

      const targets = [
        // #844: the test ids stay those of the route files, the URLs are the new ones
        { testid: "nav-time-entries", url: /\/ich\/zeiten$/ },
        { testid: "nav-leave", url: /\/ich\/abwesenheiten$/ },
        { testid: "nav-reports", url: /\/verwalten\/berichte$/ },
        { testid: "nav-dashboard", url: /\/ich\/tag$/ },
      ];

      for (const t of targets) {
        await page.getByTestId(t.testid).click();
        await expect(page).toHaveURL(t.url);
      }
    });

    test("sidebar foot shows user info + logout (D-11 sidebar smoke)", async ({ page, tenant }) => {
      // Merged from ui-audit.spec.ts "sidebar foot user-info is visible".
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/dashboard");

      await expect(page.getByTestId("sidebar-user-menu")).toBeVisible();
      await expect(page.getByTestId("sidebar-logout")).toBeVisible();
    });
  });

  test.describe("Zeiterfassung surface", () => {
    test("page anchors + add button are visible", async ({ page, tenant }) => {
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/time-entries");

      // Surface anchors from Phase 73-03.
      await expect(page.getByTestId("time-entries-page")).toBeAttached();
      await expect(page.getByTestId("time-entries-add")).toBeVisible();
      await expect(page.getByTestId("time-entries-view-tabs")).toBeVisible();
    });
  });

  test.describe("Leave (Urlaub) surface", () => {
    test("page anchors + KPI row + new-request button are visible", async ({ page, tenant }) => {
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/leave");

      // Surface anchors from Phase 73-04.
      await expect(page.getByTestId("leave-page")).toBeAttached();
      await expect(page.getByTestId("leave-new-request")).toBeVisible();
      await expect(page.getByTestId("leave-balance")).toBeVisible();
      await expect(page.getByTestId("leave-view-tabs")).toBeVisible();
    });

    test("leave-form modal closes on Escape (Modals UX contract)", async ({ page, tenant }) => {
      // Merged from ux-quality.spec.ts "modals can be closed with Escape key".
      // The leave form is the only modal that ships with a stable testid in
      // every tenant — admin/special-leave needs seed data that the fresh
      // bootstrap tenant doesn't provide.
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/leave");
      await page.getByTestId("leave-new-request").click();

      const form = page.getByTestId("leave-form");
      await expect(form).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(form).toBeHidden({ timeout: 2000 });
    });
  });

  test.describe("Reports surface", () => {
    test("reports page mounts with its export surface behind „Exportieren“", async ({
      page,
      tenant,
    }) => {
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/reports");

      // Issue #612 (ADD-5): every export lives behind the period bar's one „Exportieren“ dialog, so
      // the DATEV block is found after opening it (before, the DATEV card sat on the page). We
      // don't assert on specific content (depends on tenant data) — just that the page mounted
      // with its export surface (covers "no empty pages").
      await page.getByRole("button", { name: "Exportieren" }).click();
      await expect(page.getByRole("dialog", { name: "Exportieren" })).toBeVisible();
      await expect(page.getByText(/DATEV/i).first()).toBeVisible({ timeout: 10_000 });
    });
  });

  test.describe("Admin System surface", () => {
    test("admin/system page mounts with documented testid", async ({ page, tenant }) => {
      // Merged from ui-audit.spec.ts "admin system page loads all sections".
      // Trimmed to the testid contract emitted by Phase 73-05.
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/admin/system");

      await expect(page.getByTestId("admin-system-page")).toBeAttached();
    });
  });

  test.describe("Cross-page sanity", () => {
    test("primary app pages render with non-trivial content", async ({ page, tenant }) => {
      // Merged from dynamic-audit.spec.ts "no empty pages (all have content)"
      // and ui-audit.spec.ts page-load smokes. Walks the same set of pages
      // covered by accessibility.spec.ts so coverage is consistent.
      await loginAsTenantAdmin(page, tenant);

      const pages = ["/dashboard", "/time-entries", "/leave", "/reports", "/settings"];

      for (const url of pages) {
        await page.goto(url);
        // Wait for the page to have meaningful body content. 50 chars is the
        // same threshold the deleted dynamic-audit.spec.ts used.
        await page.waitForFunction(() => document.body.innerText.trim().length >= 50, null, {
          timeout: 5_000,
        });
      }
    });

    test("dashboard has no horizontal overflow on desktop viewport", async ({ page, tenant }) => {
      // Merged from dynamic-audit.spec.ts "no horizontal scrollbar on desktop"
      // — kept just for the dashboard (the page most prone to grid blow-out).
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/dashboard");

      // Wait for the page to settle before measuring (timer card hydrates async).
      await expect(page.getByRole("button", { name: /(Ein|Aus)stempeln/ }).first()).toBeVisible({
        timeout: 10_000,
      });

      const hasHScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
      });
      expect(hasHScroll).toBe(false);
    });
  });

  // Issue #576: the What's-New panel opens only on click; an unread release shows a „Neu“ badge
  // on the sidebar's version entry. The tenant fixture stubs an empty corpus, so this test serves
  // its own synthetic release (one section for everyone, one operator section) — Playwright applies
  // the later route over the fixture's stub. The tenant admin holds tenant-settings:update and
  // therefore sees the operator section too.
  test.describe("What's-New nur auf Klick (Issue #576)", () => {
    test("no automatic opening; the badge leads to the panel", async ({ page, tenant }) => {
      await page.route("**/api/v1/release-notes*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            releases: [
              {
                version: "1.99.0",
                title: "Ruhigere Oberfläche",
                intro: [],
                footnote: null,
                sections: [
                  {
                    heading: "Neue Funktionen",
                    audience: "all",
                    bullets: [{ spans: [{ text: "Neues für alle", bold: false }] }],
                  },
                  {
                    heading: "Betrieb & Migration",
                    audience: "admin",
                    bullets: [{ spans: [{ text: "Hinweis für den Betrieb", bold: false }] }],
                  },
                ],
              },
            ],
          }),
        }),
      );
      await loginAsTenantAdmin(page, tenant);
      await page.goto("/dashboard");

      const entry = page.getByTestId("sidebar-whats-new");
      await expect(entry).toBeVisible();
      await expect(entry.getByText("Neu", { exact: true })).toBeVisible();
      const panel = page.getByRole("complementary", { name: "Was ist neu" });
      await expect(panel).not.toBeVisible();

      await entry.click();
      await expect(panel).toBeVisible();
      await expect(panel.getByText("Neues für alle")).toBeVisible();
      await expect(panel.getByText("Hinweis für den Betrieb")).toBeVisible();
      await page.getByRole("button", { name: "Schließen" }).click();
      await expect(panel).not.toBeVisible();
      await expect(entry.getByText("Neu", { exact: true })).toHaveCount(0);
    });
  });
});
