/**
 * Issue #854 (AC-4, D-854-17) - the gating browser proof of the migrated Verwalten pages.
 *
 * The page list is apps/e2e/fixtures/verwalten-854-pages.json; every page plan of #854 appends its
 * page there, so this spec grows with the phase without being edited. Per page (one test each):
 *
 *   1. Heading   the Seitenkopf H1 (`header.page-head h1`) has the expected text.
 *   2. axe       WCAG 2 A/AA including colour contrast, on the page content (`#main-content`) as
 *                loaded and again after selecting each tab. The shell (sidebar, topbar) belongs to
 *                the navigation specs and is not part of this page's verdict.
 *   3. Tabs      the strip offers exactly the listed triggers in order; selecting one marks it
 *                `aria-selected`; ArrowRight moves focus AND selection to the next trigger (the
 *                strip loops, so the last one wraps to the first).
 *   4. Overflow  at 390 and 1440 px (and on every tab) `scrollWidth <= innerWidth` and
 *                `measurePageOverflow()` names no unclipped element beyond the viewport.
 *
 * The assertions name a state (selected tab, focus position, element list), never only visibility.
 * Anti-vacuity: the axe scan must have checked something, the fixture list must not be empty
 * (helpers/verwalten-854.ts refuses to load one). Needs only the tenant fixture (no seed); CI
 * (`e2e-ci`) is the arbiter, there is no local run in this phase. No fixed sleeps.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { measurePageOverflow } from "../helpers/viewport-geometry";
import {
  MIGRATED_PAGES,
  openPage,
  resolvePage,
  settle,
  signInAsTenantAdmin,
  type MigratedPage,
} from "../helpers/verwalten-854";

const WIDTHS = [390, 1440] as const;
const HEIGHT = 900;

function tabTrigger(page: Page, label: string) {
  return page.getByRole("tab", { name: label, exact: true });
}

/** Axe over the page content with colour contrast enabled; the rule list is the tag set alone. */
async function expectNoAxeViolations(page: Page, where: string): Promise<void> {
  await settle(page);
  const results = await new AxeBuilder({ page })
    .include("#main-content")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const report = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
  }));
  expect(report, `axe violations ${where}: ${JSON.stringify(report, null, 2)}`).toEqual([]);
  // Anti-vacuity: the scan looked at something (a wrong selector would pass an empty page).
  expect(results.passes.length, `axe checked nothing ${where}`).toBeGreaterThan(0);
}

/** Selects a tab by clicking its trigger and waits until it is selected and its panel is shown. */
async function selectTab(page: Page, label: string): Promise<void> {
  const trigger = tabTrigger(page, label);
  await trigger.click();
  await expect(trigger, `tab ${label} is selected`).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel"), `the panel of ${label} is shown`).toBeVisible();
}

async function overflowFailures(page: Page, where: string): Promise<string[]> {
  await settle(page);
  const geometry = await measurePageOverflow(page);
  const failures: string[] = [];
  if (geometry.scrollWidth > geometry.innerWidth) {
    failures.push(
      `${where}: scrollWidth ${geometry.scrollWidth} > innerWidth ${geometry.innerWidth}` +
        ` (beyond viewport: ${geometry.beyondViewport.join("; ") || "none"})`,
    );
  }
  if (geometry.overflowing.length > 0) {
    failures.push(`${where}: overflowing ${geometry.overflowing.join("; ")}`);
  }
  return failures;
}

test.describe.configure({ mode: "parallel" });

test.describe("migrated Verwalten pages (#854 AC-4)", () => {
  // A page load, a bounded network-idle wait per scan and the entity set-up.
  test.describe.configure({ timeout: 120_000 });

  test("the fixture lists the pages this spec is meant to prove", () => {
    expect(MIGRATED_PAGES.map((entry) => entry.slug)).toEqual(
      expect.arrayContaining(["salons", "salon-detail"]),
    );
  });

  for (const entry of MIGRATED_PAGES) {
    test(`${entry.path}: heading, axe on the page and on every tab, tab keyboard`, async ({
      page,
      request,
      tenant,
    }) => {
      await signInAsTenantAdmin(page, request, tenant);
      const { url, heading } = await resolvePage(request, tenant, entry);
      await page.setViewportSize({ width: 1440, height: HEIGHT });
      await openPage(page, url);

      await expect(page.locator("header.page-head h1")).toHaveText(heading);
      await expectNoAxeViolations(page, `${entry.path} (page)`);

      if (entry.tabs.length === 0) {
        await expect(page.getByRole("tab"), `${entry.path} offers no tabs`).toHaveCount(0);
        return;
      }
      await verifyTabs(page, entry);
    });

    test(`${entry.path}: no horizontal overflow at 390 and 1440 px`, async ({
      page,
      request,
      tenant,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await signInAsTenantAdmin(page, request, tenant);
      const { url } = await resolvePage(request, tenant, entry);
      const failures: string[] = [];
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: HEIGHT });
        await openPage(page, url);
        failures.push(...(await overflowFailures(page, `${entry.path} @ ${width}`)));
        for (const tab of entry.tabs) {
          await selectTab(page, tab.label);
          failures.push(
            ...(await overflowFailures(page, `${entry.path} @ ${width} tab ${tab.label}`)),
          );
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});

async function verifyTabs(page: Page, entry: MigratedPage): Promise<void> {
  const labels = entry.tabs.map((tab) => tab.label);

  // The strip offers exactly the listed triggers, in order.
  await expect(page.getByRole("tab")).toHaveText(labels);

  // axe once per tab, after the tab is selected and its panel shown.
  for (const label of labels) {
    await selectTab(page, label);
    await expectNoAxeViolations(page, `${entry.path} (tab ${label})`);
  }

  // Keyboard: from each trigger ArrowRight moves focus and selection to the next one; the strip
  // loops, so the last trigger wraps to the first.
  for (const [index, label] of labels.entries()) {
    await selectTab(page, label);
    await tabTrigger(page, label).focus();
    await expect(tabTrigger(page, label)).toBeFocused();
    const next = labels[(index + 1) % labels.length];
    await page.keyboard.press("ArrowRight");
    await expect(tabTrigger(page, next), `ArrowRight on ${label} focuses ${next}`).toBeFocused();
    await expect(tabTrigger(page, next), `ArrowRight on ${label} selects ${next}`).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
}
