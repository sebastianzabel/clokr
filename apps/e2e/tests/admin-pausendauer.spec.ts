import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

/**
 * Phase 65 — Pausendauer Admin-UI + Azubi-Defaults (BREAK-05/06/07)
 *
 * Flow A — Tenant defaults round-trip:
 *   Admin loads /admin/system, finds the two new break-default inputs in the
 *   Auto-Pausen card, types 45 and 60, blurs the field, sees "✓ Gespeichert",
 *   reloads the page, values persist as 45 and 60.
 *
 * Flow B — Employee Pausendauer override:
 *   Admin opens any employee detail page, switches to Arbeitszeit tab, finds
 *   the "Pausendauer (Optional)" Section. If employee is AZUBI < 18, the
 *   JArbSchG §9 pill is shown and "Azubi-Vorschlag übernehmen" button fills
 *   30 / 60. Otherwise admin types overrides manually. Save round-trip.
 */
test.describe("Admin Pausendauer — Phase 65 (BREAK-05/06/07)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("tenant-default Pausendauer saves and persists across reload", async ({ page }) => {
    await page.goto("/admin/system");
    await page.waitForLoadState("networkidle");

    // Ensure auto-break is enabled so the new fields are visible
    const autoBreakToggle = page.getByLabel("Pausen automatisch abziehen");
    const isChecked = await autoBreakToggle.isChecked();
    if (!isChecked) {
      await autoBreakToggle.click();
      // Wait for the conditionally-rendered break fields to appear.
      await page.locator("#sys-break-over6h").waitFor({ state: "visible", timeout: 2000 });
    }

    const over6h = page.locator("#sys-break-over6h");
    const over9h = page.locator("#sys-break-over9h");
    await expect(over6h).toBeVisible();
    await expect(over9h).toBeVisible();

    // Capture baseline so we can restore at end of test (no audit-log pollution)
    const baseline6h = await over6h.inputValue();
    const baseline9h = await over9h.inputValue();

    // saveBreakDefaults fires on blur — wait for the actual PUT response instead of a timeout.
    const waitForSave = () =>
      page
        .waitForResponse(
          (r) =>
            r.url().includes("/api/v1") &&
            (r.url().includes("config") || r.url().includes("break") || r.url().includes("system")) &&
            ["POST", "PUT", "PATCH"].includes(r.request().method()),
          { timeout: 3000 },
        )
        .catch(() => null);

    await over6h.fill("45");
    await Promise.all([waitForSave(), over6h.blur()]);
    await over9h.fill("60");
    await Promise.all([waitForSave(), over9h.blur()]);

    await expect(page.getByText("✓ Gespeichert").first()).toBeVisible({ timeout: 3000 });
    await screenshotPage(page, "admin-pausendauer-tenant-saved");

    // Reload and confirm persistence
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#sys-break-over6h")).toHaveValue("45");
    await expect(page.locator("#sys-break-over9h")).toHaveValue("60");

    // Restore baseline — re-use the same save-response watcher so we don't race the next test.
    await page.locator("#sys-break-over6h").fill(baseline6h || "30");
    await Promise.all([waitForSave(), page.locator("#sys-break-over6h").blur()]);
    await page.locator("#sys-break-over9h").fill(baseline9h || "45");
    await Promise.all([waitForSave(), page.locator("#sys-break-over9h").blur()]);
  });

  test("employee Pausendauer override saves and persists across reload", async ({ page }) => {
    // Navigate to first employee detail page (employee list always seeded)
    await page.goto("/admin/employees");
    await page.waitForLoadState("networkidle");

    const firstEmployeeLink = page.locator("a[href*='/admin/employees/']").first();
    await expect(firstEmployeeLink).toBeVisible();
    await firstEmployeeLink.click();
    await page.waitForLoadState("networkidle");

    // Switch to Arbeitszeit tab — wait for the tab panel to mount via its first known label.
    await page
      .getByRole("button", { name: "Arbeitszeit" })
      .or(page.locator(".admin-tab").filter({ hasText: "Arbeitszeit" }))
      .first()
      .click();

    // Pausendauer (Optional) Section must be present
    await expect(page.getByText("Pausendauer (Optional)").first()).toBeVisible();

    const over6h = page.locator("#emp-break-over6h");
    const over9h = page.locator("#emp-break-over9h");
    await expect(over6h).toBeVisible();
    await expect(over9h).toBeVisible();

    // If Azubi-under-18 pill is visible, exercise the one-click suggestion path
    const azubiPill = page.getByText("Azubi unter 18 — JArbSchG §9 Empfehlung");
    const isAzubi = await azubiPill.isVisible().catch(() => false);

    if (isAzubi) {
      await page.getByRole("button", { name: /Azubi-Vorschlag übernehmen/ }).click();
      await expect(over6h).toHaveValue("30");
      await expect(over9h).toHaveValue("60");
      await screenshotPage(page, "admin-pausendauer-azubi-suggestion-applied");
    } else {
      // Fallback: type override manually (still exercises save round-trip)
      await over6h.fill("40");
      await over9h.fill("50");
    }

    // Save and verify
    const saveBtn = page
      .locator("button.btn-primary")
      .filter({ hasText: /Speichern/ })
      .last();
    await saveBtn.click();
    await expect(page.getByText("Gespeichert").last()).toBeVisible({ timeout: 3000 });

    const expectedOver6 = isAzubi ? "30" : "40";
    const expectedOver9 = isAzubi ? "60" : "50";

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page
      .getByRole("button", { name: "Arbeitszeit" })
      .or(page.locator(".admin-tab").filter({ hasText: "Arbeitszeit" }))
      .first()
      .click();
    // Wait for the tab panel to actually mount via the Pausendauer-section heading.
    await expect(page.getByText("Pausendauer (Optional)").first()).toBeVisible();

    await expect(page.locator("#emp-break-over6h")).toHaveValue(expectedOver6);
    await expect(page.locator("#emp-break-over9h")).toHaveValue(expectedOver9);

    // Restore (clear override) for test hygiene — wait for the PUT response on save.
    await page.locator("#emp-break-over6h").fill("");
    await page.locator("#emp-break-over9h").fill("");
    await Promise.all([
      page
        .waitForResponse(
          (r) =>
            r.url().includes("/api/v1") && ["PUT", "PATCH"].includes(r.request().method()),
          { timeout: 3000 },
        )
        .catch(() => null),
      saveBtn.click(),
    ]);
  });
});
