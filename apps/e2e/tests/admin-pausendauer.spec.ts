/**
 * Admin Pausendauer flow — Phase 73-05 migration.
 *
 * Phase 65 BREAK-05/06/07 covers tenant-default + per-employee Pausendauer
 * overrides. The original spec used CSS-class selectors (`#sys-break-over6h`)
 * and the shared admin login. This rewrite uses:
 *
 *   - tenant fixture (73-02 D-04) for per-test isolation
 *   - data-testid selectors from 73-05:
 *       admin/system: admin-system-pausendauer-{autoBreakEnabled,over6h,over9h}
 *       admin/employees/[id]: pausendauer-{over6h,over9h,save,azubi-pill,azubi-apply}
 *   - waitForResponse instead of waitForTimeout
 *
 * Flow A — tenant defaults round-trip:
 *   Admin loads /admin/system → Arbeitszeit tab → toggles auto-break ON
 *   if needed, fills 45/60 into the two break inputs, blurs to save, reloads,
 *   asserts values persist.
 *
 * Flow B — employee Pausendauer override:
 *   Admin creates an employee, navigates to the detail page, finds the
 *   Pausendauer Section, fills overrides, saves, reloads, asserts persistence.
 */
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import type { Page } from "@playwright/test";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

// See admin-settings-flow.spec.ts for rationale — login through the real
// form so the JWT + tenant-features hydrate exactly as in production.
async function loginAsTenantAdmin(page: Page, tenant: TestTenant): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(`admin@${tenant.tenantId}.test`);
  await page.getByLabel("Passwort", { exact: true }).fill("test1234");
  await page.getByRole("button", { name: /anmelden/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 10_000 });
}

// The tenant bootstrap (73-01) creates the admin user but no employees.
// We seed a single regular employee via the API so the per-employee
// Pausendauer override test has something to navigate to. The returned id
// drives the URL — no UI scraping required.
async function seedEmployee(
  tenant: TestTenant,
  opts: { firstName?: string; lastName?: string } = {},
): Promise<{ employeeId: string }> {
  const res = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tenant.adminToken}`,
    },
    body: JSON.stringify({
      firstName: opts.firstName ?? "Test",
      lastName: opts.lastName ?? "Mitarbeiter",
      email: `emp-${Date.now()}@${tenant.tenantId}.test`,
      employeeNumber: `EMP-${Date.now()}`,
      hireDate: "2024-01-01",
      role: "EMPLOYEE",
      password: "test1234",
    }),
  });
  if (!res.ok) {
    throw new Error(`seedEmployee failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { employeeId: body.id };
}

test.describe("Admin Pausendauer — Phase 65 (BREAK-05/06/07)", () => {
  test("tenant-default Pausendauer saves and persists across reload", async ({
    page,
    tenant,
  }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/admin/system");
    await expect(page.getByTestId("admin-system-page")).toBeVisible();

    // Auto-break + Pausendauer fields live in the Arbeitszeit tab.
    await page.getByRole("tab", { name: /Arbeitszeit/i }).click();

    // Ensure auto-break is enabled so the >6h / >9h inputs are not disabled.
    const autoBreak = page.getByTestId("admin-system-pausendauer-autoBreakEnabled");
    if (!(await autoBreak.isChecked())) {
      const toggleResponse = page.waitForResponse(
        (res) => res.url().includes("/settings/work") && res.request().method() === "PATCH",
      );
      await page.locator("label.switch", { has: autoBreak }).click();
      await toggleResponse;
    }

    const over6h = page.getByTestId("admin-system-pausendauer-over6h");
    const over9h = page.getByTestId("admin-system-pausendauer-over9h");
    await expect(over6h).toBeVisible();
    await expect(over9h).toBeVisible();

    // Capture baseline so we can leave the tenant in a clean state.
    const baseline6h = await over6h.inputValue();
    const baseline9h = await over9h.inputValue();

    // saveBreakDefaults fires on blur — wait for the PATCH each time so the
    // assertion below doesn't race against the request.
    const save6 = page.waitForResponse(
      (res) => res.url().includes("/settings/work") && res.request().method() === "PATCH",
    );
    await over6h.fill("45");
    await over6h.blur();
    await save6;

    const save9 = page.waitForResponse(
      (res) => res.url().includes("/settings/work") && res.request().method() === "PATCH",
    );
    await over9h.fill("60");
    await over9h.blur();
    await save9;

    // Reload + reopen tab — the values must persist.
    await page.reload();
    await page.getByRole("tab", { name: /Arbeitszeit/i }).click();
    await expect(page.getByTestId("admin-system-pausendauer-over6h")).toHaveValue("45");
    await expect(page.getByTestId("admin-system-pausendauer-over9h")).toHaveValue("60");

    // Restore baseline so any sibling assertion on the tenant sees the
    // original config (tenant is torn down, but explicit is better).
    await page.getByTestId("admin-system-pausendauer-over6h").fill(baseline6h || "30");
    await page.getByTestId("admin-system-pausendauer-over6h").blur();
    await page.getByTestId("admin-system-pausendauer-over9h").fill(baseline9h || "45");
    await page.getByTestId("admin-system-pausendauer-over9h").blur();
  });

  test("employee Pausendauer override saves and persists across reload", async ({
    page,
    tenant,
  }) => {
    const { employeeId } = await seedEmployee(tenant);
    await loginAsTenantAdmin(page, tenant);

    await page.goto(`/admin/employees/${employeeId}`);
    // The Pausendauer Section lives under the Arbeitszeit tab on the detail page.
    await page
      .getByRole("button", { name: /Arbeitszeit/i })
      .or(page.locator(".admin-tab").filter({ hasText: "Arbeitszeit" }))
      .first()
      .click();

    const editor = page.getByTestId("pausendauer-editor");
    await expect(editor).toBeVisible();

    const over6h = page.getByTestId("pausendauer-over6h");
    const over9h = page.getByTestId("pausendauer-over9h");
    await expect(over6h).toBeVisible();
    await expect(over9h).toBeVisible();

    // Regular employee (not Azubi) — the JArbSchG pill must NOT be visible.
    await expect(page.getByTestId("pausendauer-azubi-pill")).toBeHidden();

    // Fill overrides + save + verify the PATCH round-trips.
    const savePromise = page.waitForResponse(
      (res) => res.url().includes(`/employees/${employeeId}`) && res.request().method() === "PATCH",
    );
    await over6h.fill("40");
    await over9h.fill("50");
    await page.getByTestId("pausendauer-save").click();
    await savePromise;

    await page.reload();
    await page
      .getByRole("button", { name: /Arbeitszeit/i })
      .or(page.locator(".admin-tab").filter({ hasText: "Arbeitszeit" }))
      .first()
      .click();
    await expect(page.getByTestId("pausendauer-over6h")).toHaveValue("40");
    await expect(page.getByTestId("pausendauer-over9h")).toHaveValue("50");

    // Restore (clear) the override so the tenant ends in default state.
    await page.getByTestId("pausendauer-over6h").fill("");
    await page.getByTestId("pausendauer-over9h").fill("");
    const clearPromise = page.waitForResponse(
      (res) => res.url().includes(`/employees/${employeeId}`) && res.request().method() === "PATCH",
    );
    await page.getByTestId("pausendauer-save").click();
    await clearPromise;
  });
});
