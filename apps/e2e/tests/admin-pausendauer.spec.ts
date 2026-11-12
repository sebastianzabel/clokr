/**
 * Admin Pausendauer flow — Phase 73-05 migration.
 *
 * Phase 65 BREAK-05/06/07 covers tenant-default + per-employee Pausendauer
 * overrides. The original spec used CSS-class selectors (`#sys-break-over6h`)
 * and the shared admin login. This rewrite uses:
 *
 *   - tenant fixture (73-02 D-04) for per-test isolation
 *   - data-testid selectors from 73-05:
 *       Regeln › Arbeitszeit & Verträge (Issue #854): arbeitszeit-pausen-{autoBreakEnabled,over6h,over9h}
 *       admin/employees/[id]: pausendauer-{over6h,over9h,save,azubi-pill,azubi-apply}
 *   - waitForResponse instead of waitForTimeout
 *
 * Flow A — tenant defaults round-trip:
 *   Admin loads Regeln › Arbeitszeit & Verträge, fills 45/60 into the two break
 *   inputs, saves the Pausen section with its SaveBar, reloads, asserts values persist.
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
  await page.waitForURL(/\/(ich|team|verwalten)(\/|$)/, { timeout: 10_000 }); // #844: the start page
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
      usualWorkDays: [1, 2, 3, 4, 5], // Issue #481 R5
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
  test("tenant-default Pausendauer saves and persists across reload", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    // Issue #854: the Pausen section lives on Regeln › Arbeitszeit & Verträge and saves through its
    // own SaveBar (one request for the whole section).
    await page.goto("/verwalten/regeln/arbeitszeit");
    await expect(page.getByRole("heading", { level: 2, name: "Pausen" })).toBeVisible();

    const over6h = page.getByTestId("arbeitszeit-pausen-over6h");
    const over9h = page.getByTestId("arbeitszeit-pausen-over9h");
    await expect(over6h).toBeVisible();
    await expect(over9h).toBeVisible();

    // Capture baseline so we can leave the tenant in a clean state.
    const baseline6h = await over6h.inputValue();
    const baseline9h = await over9h.inputValue();

    const save = page.waitForResponse(
      (res) => res.url().includes("/settings/work") && res.request().method() === "PUT",
    );
    await over6h.fill("45");
    await over9h.fill("60");
    await page.getByRole("button", { name: "Pausen speichern" }).click();
    await save;

    // Reload — the values must persist.
    await page.reload();
    await expect(page.getByTestId("arbeitszeit-pausen-over6h")).toHaveValue("45");
    await expect(page.getByTestId("arbeitszeit-pausen-over9h")).toHaveValue("60");

    // Restore baseline so any sibling assertion on the tenant sees the
    // original config (tenant is torn down, but explicit is better).
    const restore = page.waitForResponse(
      (res) => res.url().includes("/settings/work") && res.request().method() === "PUT",
    );
    await page.getByTestId("arbeitszeit-pausen-over6h").fill(baseline6h || "30");
    await page.getByTestId("arbeitszeit-pausen-over9h").fill(baseline9h || "45");
    await page.getByRole("button", { name: "Pausen speichern" }).click();
    await restore;
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

    // An adult employee (no birth date under 18) — the § 11 JArbSchG pill must NOT be visible.
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
