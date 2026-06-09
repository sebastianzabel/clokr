/**
 * Tracking exemption — Phase 76.7 Plan 04 (D-26, UI-V19-04a).
 *
 * Happy-path Playwright coverage for the ADMIN-only § 18 ArbZG exemption
 * toggle on /admin/employees/[id]. Edge cases (MANAGER 403, audit-row shape,
 * no-op suppression, ADMIN role-guard) are covered by the backend
 * integration tests in `apps/api/src/__tests__/time-tracking-exemption.test.ts`
 * (Plan 02) — this spec validates the full UI round-trip.
 *
 * Flow:
 *   - Bootstrap a fresh tenant (via the per-test fixture) → seed one
 *     non-exempt employee via the API.
 *   - Log in as the tenant ADMIN via the real login form.
 *   - Navigate to /admin/employees/{id}; assert the exemption toggle is
 *     present (= ADMIN gate visible).
 *   - Click the toggle → ConfirmDialog opens with the D-18 canonical text
 *     referencing "§ 18 ArbZG" and "BUrlG".
 *   - Click "Bestätigen" → toast `"Befreiung aktualisiert"` appears, toggle
 *     stays checked, PATCH /employees/:id round-trips.
 *   - Reload page → toggle stays checked (server-state persisted).
 *   - Tidy up: toggle OFF + Bestätigen so the tenant ends clean.
 *     (The tenant is torn down anyway by the fixture, but explicit is best.)
 */
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import type { Page } from "@playwright/test";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

// Mirror admin-pausendauer.spec.ts — login through the real form so the
// JWT + tenant-features hydrate exactly as in production.
async function loginAsTenantAdmin(page: Page, tenant: TestTenant): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(`admin@${tenant.tenantId}.test`);
  await page.getByLabel("Passwort", { exact: true }).fill("test1234");
  await page.getByRole("button", { name: /anmelden/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 10_000 });
}

// Seed a single regular employee inside the bootstrap-tenant so we have a
// known UUID to navigate to. Mirrors the helper from admin-pausendauer.spec.
async function seedEmployee(tenant: TestTenant): Promise<{ employeeId: string }> {
  const stamp = Date.now();
  const res = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tenant.adminToken}`,
    },
    body: JSON.stringify({
      firstName: "Test",
      lastName: "Mitarbeiter",
      email: `emp-exempt-${stamp}@${tenant.tenantId}.test`,
      employeeNumber: `EMP-EX-${stamp}`,
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

test.describe("Tracking exemption — admin toggle (Phase 76.7 D-26)", () => {
  test("ADMIN can toggle § 18 ArbZG exemption on a non-exempt employee", async ({
    page,
    tenant,
  }) => {
    const { employeeId } = await seedEmployee(tenant);
    await loginAsTenantAdmin(page, tenant);

    await page.goto(`/admin/employees/${employeeId}`);
    // Stammdaten tab is the default; the exemption toggle lives there.

    // ADMIN gate visible
    const toggle = page.getByTestId("exemption-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    // Hint text + label render with the canonical German strings.
    await expect(page.getByText("Keine Zeiterfassungs-Pflicht (§ 18 ArbZG)")).toBeVisible();
    await expect(
      page.getByText(/Inhaber, Geschäftsführer und leitende Angestellte sind nach § 18 ArbZG/),
    ).toBeVisible();

    // ── Flip ON ──────────────────────────────────────────────────────────
    // Capture the PATCH so we don't race the assertions.
    const patchOn = page.waitForResponse(
      (res) => res.url().includes(`/employees/${employeeId}`) && res.request().method() === "PATCH",
    );
    await toggle.click();

    // ConfirmDialog appears with the canonical D-18 text.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("§ 18 ArbZG");
    await expect(dialog).toContainText("BUrlG");
    await expect(dialog).toContainText("Audit-Log");

    // Confirm → PATCH + toast.
    await dialog.getByRole("button", { name: "Bestätigen" }).click();
    await patchOn;

    // Success toast — match the verbatim message from Task 1.
    await expect(page.getByText("Befreiung aktualisiert")).toBeVisible({
      timeout: 5_000,
    });

    // Toggle is now checked.
    await expect(toggle).toBeChecked();

    // ── Reload — server state persists ───────────────────────────────────
    await page.reload();
    await expect(page.getByTestId("exemption-toggle")).toBeChecked();

    // ── Tidy up: flip OFF so the tenant ends in default state ────────────
    const patchOff = page.waitForResponse(
      (res) => res.url().includes(`/employees/${employeeId}`) && res.request().method() === "PATCH",
    );
    await page.getByTestId("exemption-toggle").click();
    await page.getByRole("dialog").getByRole("button", { name: "Bestätigen" }).click();
    await patchOff;
    await expect(page.getByText("Befreiung aktualisiert")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("exemption-toggle")).not.toBeChecked();
  });
});
