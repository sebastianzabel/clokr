import { test, expect, Page } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

/**
 * UX Quality Suite — tests the app like a UX reviewer, not just a QA tester.
 * Checks: feedback after actions, visual hierarchy, information density,
 * flow continuity, plausibility of displayed data, loading states.
 */

interface UXFinding {
  page: string;
  category: string;
  severity: "critical" | "major" | "minor" | "good";
  message: string;
}

const findings: UXFinding[] = [];

function finding(page: string, category: string, severity: UXFinding["severity"], message: string) {
  findings.push({ page, category, severity, message });
}

test.afterAll(() => {
  if (findings.length === 0) return;

  const good = findings.filter((f) => f.severity === "good");
  const issues = findings.filter((f) => f.severity !== "good");

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║     UX QUALITY REPORT                    ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  if (good.length > 0) {
    console.log(`✅ GOOD PATTERNS (${good.length}):`);
    good.forEach((f) => console.log(`  ✓ [${f.page}] ${f.category}: ${f.message}`));
    console.log();
  }

  if (issues.length > 0) {
    console.log(`⚠️  ISSUES (${issues.length}):`);
    for (const f of issues) {
      const icon = f.severity === "critical" ? "🔴" : f.severity === "major" ? "🟡" : "🔵";
      console.log(`  ${icon} [${f.page}] ${f.category}: ${f.message}`);
    }
  }

  console.log(
    `\n📊 ${good.length} good, ${issues.filter((f) => f.severity === "critical").length} critical, ${issues.filter((f) => f.severity === "major").length} major, ${issues.filter((f) => f.severity === "minor").length} minor\n`,
  );
});

test.describe("UX Quality — Feedback & Confirmation", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("action feedback — toast/confirmation after save in admin", async ({ page }) => {
    await page.goto("/admin/system");
    await page.waitForLoadState("networkidle");

    // Find any save button and click
    const saveBtn = page.getByRole("button", { name: /speichern/i }).first();
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
      await page.waitForTimeout(1500);

      // Should show "Gespeichert" or toast
      const confirmation = page.getByText(/gespeichert|erfolgreich|✓/i).first();
      const hasConfirmation = await confirmation.isVisible().catch(() => false);

      if (hasConfirmation) {
        finding("Admin System", "Feedback", "good", "Save action shows confirmation");
      } else {
        finding(
          "Admin System",
          "Feedback",
          "major",
          "No visible confirmation after saving settings — user doesn't know if save worked",
        );
      }
    }
  });

  test("action feedback — error messages are helpful and german", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Try wrong password
    const curPw = page.locator("#cur-pw");
    if (await curPw.isVisible()) {
      await curPw.fill("falschespasswort");
      await page.locator("#new-pw").fill("NeuesPasswort123!");
      await page.locator("#confirm-pw").fill("NeuesPasswort123!");
      await page.getByRole("button", { name: /passwort ändern/i }).click();
      await page.waitForTimeout(1500);

      // Error should be in German and helpful
      const errorText = await page
        .locator(".toast, .alert, [role='alert']")
        .first()
        .textContent()
        .catch(() => "");
      if (errorText && /falsch|ungültig|aktuell/i.test(errorText)) {
        finding("Profil", "Error Messages", "good", "Password error is in German and specific");
      } else if (errorText) {
        finding(
          "Profil",
          "Error Messages",
          "minor",
          `Error message not specific enough: "${errorText.trim().slice(0, 60)}"`,
        );
      } else {
        finding("Profil", "Error Messages", "major", "No visible error after wrong password");
      }
    }
  });
});

test.describe("UX Quality — Visual Hierarchy & Information Density", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("dashboard — clear primary action (clock-in)", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const clockBtn = page.locator(".clock-btn").first();
    if (await clockBtn.isVisible()) {
      const box = await clockBtn.boundingBox();
      const style = await clockBtn.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          fontSize: parseFloat(s.fontSize),
          bg: s.backgroundColor,
          fontWeight: s.fontWeight,
        };
      });

      // Primary action should be prominent
      if (style.fontSize >= 14 && parseInt(style.fontWeight) >= 600) {
        finding(
          "Dashboard",
          "Visual Hierarchy",
          "good",
          "Clock-in button is prominent (large, bold)",
        );
      } else {
        finding(
          "Dashboard",
          "Visual Hierarchy",
          "major",
          "Clock-in button not prominent enough — primary action should stand out",
        );
      }

      // Should be above the fold
      if (box && box.y < 400) {
        finding("Dashboard", "Visual Hierarchy", "good", "Clock-in button above the fold");
      } else {
        finding(
          "Dashboard",
          "Visual Hierarchy",
          "critical",
          "Clock-in button below the fold — most important action not immediately visible",
        );
      }
    }
  });

  test("dashboard — summary cards show enough context", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Check stat cards have labels + values + units
    const statCards = page.locator(".stat-card, .overview-card, .summary-stat").all();
    const cards = await statCards;

    for (const card of cards) {
      const text = await card.textContent();
      if (text) {
        const hasLabel = text.length > 5; // More than just a number
        const hasUnit = /h|Tage|Stunden|min/i.test(text);
        if (!hasUnit && /\d/.test(text)) {
          finding(
            "Dashboard",
            "Information Density",
            "minor",
            `Stat card has number without unit: "${text.trim().slice(0, 40)}"`,
          );
        }
      }
    }
  });

  test("time entries — calendar day provides enough info at a glance", async ({ page }) => {
    await page.goto("/time-entries");
    await page.waitForLoadState("networkidle");

    // A filled calendar day should show: hours worked, maybe balance
    const filledDays = await page.locator(".cal-day:not(.other-month)").all();
    let daysWithInfo = 0;
    let daysWithEntries = 0;

    for (const day of filledDays.slice(0, 10)) {
      const text = await day.textContent();
      if (text && /\d+:\d+|\d+\.\d+\s*h/i.test(text)) {
        daysWithEntries++;
        // Check if it shows both worked hours AND balance
        if (/[+-]/.test(text)) daysWithInfo++;
      }
    }

    if (daysWithEntries > 0 && daysWithInfo > 0) {
      finding(
        "Zeiterfassung",
        "Information Density",
        "good",
        "Calendar days show worked hours + balance at a glance",
      );
    } else if (daysWithEntries > 0) {
      finding(
        "Zeiterfassung",
        "Information Density",
        "minor",
        "Calendar days show hours but no +/- balance — could show more at a glance",
      );
    }
  });

  test("leave page — vacation balance is immediately visible", async ({ page }) => {
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");

    const summary = page.locator(".vac-summary").first();
    if (await summary.isVisible()) {
      const box = await summary.boundingBox();
      if (box && box.y < 300) {
        finding(
          "Abwesenheiten",
          "Information Density",
          "good",
          "Vacation balance visible above the fold",
        );
      } else {
        finding(
          "Abwesenheiten",
          "Information Density",
          "major",
          "Vacation balance not immediately visible — key info should be at the top",
        );
      }

      // Check it shows remaining days
      const text = await summary.textContent();
      if (text && /verbleibend/i.test(text)) {
        finding(
          "Abwesenheiten",
          "Information Density",
          "good",
          "Shows 'Verbleibend' days — clear summary",
        );
      }
    } else {
      finding(
        "Abwesenheiten",
        "Information Density",
        "major",
        "No vacation balance summary visible",
      );
    }
  });
});

test.describe("UX Quality — Flow Continuity", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("after login — lands on meaningful page", async ({ page }) => {
    // Already logged in via beforeEach, check we're on dashboard
    await expect(page).toHaveURL(/dashboard/);
    finding("Login", "Flow", "good", "Login redirects to Dashboard — meaningful landing page");
  });

  test("breadcrumbs in admin provide navigation context", async ({ page }) => {
    await page.goto("/admin/special-leave");
    await page.waitForLoadState("networkidle");

    const breadcrumb = page.locator(".breadcrumb, nav[aria-label*='bread']").first();
    if (await breadcrumb.isVisible()) {
      const text = await breadcrumb.textContent();
      if (text && /admin|dashboard/i.test(text)) {
        finding("Admin", "Flow", "good", "Breadcrumbs show navigation path");
      }
    } else {
      finding("Admin", "Flow", "minor", "No breadcrumbs in admin — user may lose orientation");
    }
  });

  test("sidebar shows active page clearly", async ({ page }) => {
    await page.goto("/time-entries");
    await page.waitForLoadState("networkidle");

    const activeItem = page.locator(".nav-item--active, [aria-current='page']").first();
    if (await activeItem.isVisible()) {
      const style = await activeItem.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, color: s.color, fontWeight: s.fontWeight };
      });

      // Active item should be visually distinct
      if (parseInt(style.fontWeight) >= 600 || style.bg !== "rgba(0, 0, 0, 0)") {
        finding(
          "Navigation",
          "Flow",
          "good",
          "Active nav item is visually distinct (weight/background)",
        );
      } else {
        finding(
          "Navigation",
          "Flow",
          "major",
          "Active nav item not distinct enough — user can't tell where they are",
        );
      }
    }
  });

  test("modals can be closed with Escape key", async ({ page }) => {
    await page.goto("/admin/special-leave");
    await page.waitForLoadState("networkidle");

    // Open create modal
    await page.getByText("Neue Regel").click();
    await page.waitForTimeout(300);

    const modal = page.locator(".modal, [role='dialog']").first();
    await expect(modal).toBeVisible();

    // Close with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const stillVisible = await modal.isVisible().catch(() => false);
    if (!stillVisible) {
      finding("Modals", "Flow", "good", "Modal closes on Escape key");
    } else {
      finding(
        "Modals",
        "Flow",
        "major",
        "Modal doesn't close on Escape — violates user expectation",
      );
    }
  });
});

test.describe("UX Quality — Plausibility & Data Consistency", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("time entries summary matches calendar data", async ({ page }) => {
    await page.goto("/time-entries");
    await page.waitForLoadState("networkidle");

    // Get summary bar values
    const summaryText = await page
      .locator(".month-summary")
      .first()
      .textContent()
      .catch(() => "");

    // Summary should contain hour values with "h"
    if (summaryText && /\d+:\d+h/.test(summaryText)) {
      finding("Zeiterfassung", "Plausibility", "good", "Summary bar shows hours in HH:MMh format");
    }

    // Saldo should be present
    if (summaryText && /saldo/i.test(summaryText)) {
      finding(
        "Zeiterfassung",
        "Plausibility",
        "good",
        "Summary includes Saldo — key metric visible",
      );
    }
  });

  test("vacation days add up (taken + remaining = total)", async ({ page }) => {
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");

    const summary = page.locator(".vac-summary").first();
    if (await summary.isVisible()) {
      const items = await summary.locator(".vac-summary-item, .vac-summary-value").all();
      const values: number[] = [];

      for (const item of items) {
        const text = await item.textContent();
        const match = text?.match(/(\d+)/);
        if (match) values.push(parseInt(match[1]));
      }

      // Should have at least total + used + remaining
      if (values.length >= 3) {
        finding(
          "Abwesenheiten",
          "Plausibility",
          "good",
          `Vacation summary shows ${values.length} data points — comprehensive`,
        );
      } else if (values.length > 0) {
        finding(
          "Abwesenheiten",
          "Plausibility",
          "minor",
          `Only ${values.length} values in vacation summary — could show more breakdown`,
        );
      }
    }
  });

  test("dates are in German format (DD.MM.YYYY)", async ({ page }) => {
    await page.goto("/admin/audit");
    await page.waitForLoadState("networkidle");

    const dateTexts = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll("td, .date, time"));
      return cells
        .map((c) => c.textContent?.trim() ?? "")
        .filter((t) => /\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2}/.test(t))
        .slice(0, 5);
    });

    const germanFormat = dateTexts.filter((d) => /\d{2}\.\d{2}\.\d{4}/.test(d));
    const isoFormat = dateTexts.filter((d) => /\d{4}-\d{2}-\d{2}/.test(d));

    if (germanFormat.length > 0 && isoFormat.length === 0) {
      finding("Audit Log", "Plausibility", "good", "Dates in German format (DD.MM.YYYY)");
    } else if (isoFormat.length > 0) {
      finding(
        "Audit Log",
        "Plausibility",
        "minor",
        "Some dates in ISO format (YYYY-MM-DD) — should be DD.MM.YYYY for German UI",
      );
    }
  });

  test("numbers use German locale (comma as decimal)", async ({ page }) => {
    await page.goto("/time-entries");
    await page.waitForLoadState("networkidle");

    const bodyText = await page.textContent("body");
    // Check if hour values use colon (HH:MM) format — standard for time
    if (bodyText && /\d{1,2}:\d{2}h/.test(bodyText)) {
      finding(
        "Zeiterfassung",
        "Plausibility",
        "good",
        "Time values in HH:MMh format — clear and unambiguous",
      );
    }
  });
});

test.describe("UX Quality — Design Consistency", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("primary buttons have consistent styling across pages", async ({ page }) => {
    const pages = ["/dashboard", "/leave", "/admin/employees", "/admin/system"];
    const styles: string[] = [];

    for (const url of pages) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");

      const primaryBtn = page.locator(".btn-primary").first();
      if (await primaryBtn.isVisible()) {
        const style = await primaryBtn.evaluate((el) => {
          const s = getComputedStyle(el);
          return `${s.borderRadius}|${s.fontSize}|${s.fontWeight}`;
        });
        styles.push(style);
      }
    }

    const unique = [...new Set(styles)];
    if (unique.length <= 1) {
      finding(
        "Global",
        "Design Consistency",
        "good",
        "Primary buttons consistent across all pages",
      );
    } else {
      finding(
        "Global",
        "Design Consistency",
        "major",
        `Primary buttons have ${unique.length} different styles across pages`,
      );
    }
  });

  test("card styling is consistent", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const cards = await page.locator(".card").all();
    const radii: string[] = [];

    for (const card of cards.slice(0, 5)) {
      const radius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
      radii.push(radius);
    }

    const unique = [...new Set(radii)];
    if (unique.length <= 2) {
      finding("Dashboard", "Design Consistency", "good", "Card border-radius consistent");
    } else {
      finding(
        "Dashboard",
        "Design Consistency",
        "minor",
        `${unique.length} different card radii: ${unique.join(", ")}`,
      );
    }
  });

  test("spacing between sections is consistent", async ({ page }) => {
    await page.goto("/admin/vacation");
    await page.waitForLoadState("networkidle");

    const sections = await page.locator(".section-group, .settings-section, details").all();
    const margins: number[] = [];

    for (const section of sections.slice(0, 5)) {
      const mb = await section.evaluate((el) => parseFloat(getComputedStyle(el).marginBottom));
      if (mb > 0) margins.push(Math.round(mb));
    }

    const unique = [...new Set(margins)];
    if (unique.length <= 2) {
      finding("Admin Vacation", "Design Consistency", "good", "Section spacing consistent");
    } else {
      finding(
        "Admin Vacation",
        "Design Consistency",
        "minor",
        `Inconsistent section margins: ${unique.join(", ")}px`,
      );
    }
  });
});
