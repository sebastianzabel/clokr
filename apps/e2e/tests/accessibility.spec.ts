import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { loginAsAdmin } from "./helpers";

test.describe("Accessibility Audit (axe-core)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  const pages = [
    { name: "Dashboard", url: "/dashboard" },
    { name: "Zeiterfassung", url: "/time-entries" },
    { name: "Abwesenheiten", url: "/leave" },
    { name: "Profil", url: "/settings" },
    { name: "Admin Mitarbeiter", url: "/admin/employees" },
    { name: "Admin Urlaub & Zeiten", url: "/admin/vacation" },
    { name: "Admin System", url: "/admin/system" },
    { name: "Admin Sonderurlaub", url: "/admin/special-leave" },
  ];

  for (const p of pages) {
    test(`${p.name} (${p.url}) has no critical a11y violations`, async ({ page }) => {
      await page.goto(p.url);
      await page.waitForLoadState("networkidle");

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .disableRules(["color-contrast"]) // Disabled initially — too many false positives with themes
        .analyze();

      // Log violations for review
      if (results.violations.length > 0) {
        console.log(`\n⚠ ${p.name}: ${results.violations.length} a11y violations:`);
        for (const v of results.violations) {
          console.log(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} instances)`);
        }
      }

      // Only fail on critical/serious violations
      const critical = results.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );
      expect(critical, `Critical a11y violations on ${p.name}`).toHaveLength(0);
    });
  }
});

test.describe("Accessibility — Login Page (unauthenticated)", () => {
  test("Login page has no critical a11y violations", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .disableRules(["color-contrast"])
      .analyze();

    const critical = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(critical, "Critical a11y violations on Login").toHaveLength(0);
  });
});
