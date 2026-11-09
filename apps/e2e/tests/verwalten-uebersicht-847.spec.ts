/**
 * Issue #847 — Verwalten › Übersicht with the setup checklist.
 *
 *   AC-1  At least six setup checks, each with a direct link and a state (erledigt / offen).
 *   AC-2  „E-Mail aktiv, SMTP nicht eingerichtet“ is warned on the overview AND in the mail settings —
 *         exactly when the server says mail cannot be delivered (`GET /settings/smtp` deliveryReady,
 *         which also knows the server's own fallback).
 *   AC-3  Overdue month closes, open invitations and persons without a contract are counted and linked.
 *   AC-4  The Personalabteilung lands here after signing in (Z-02).
 *
 * Own tenant per test (tenant fixture; it books every package, so the terminal check is offered).
 */
import { randomUUID } from "node:crypto";
import { test, expect, type TestTenant } from "../fixtures";
import { login, loginAsTenantAdmin } from "./helpers";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = `Verw-${randomUUID()}!`;
const HR_TEMPLATE = "00000000-0000-4000-8000-00000000a006";

function adminHeaders(tenant: TestTenant) {
  return { authorization: `Bearer ${tenant.adminToken}`, "content-type": "application/json" };
}

test.describe("Verwalten › Übersicht (#847)", () => {
  test("six checks with links and states, the admin tasks counted and linked (AC-1, AC-3)", async ({
    page,
    tenant,
  }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/verwalten");
    const checks = page.getByTestId("setup-checks").locator("[data-check]");
    await expect(checks.first()).toBeVisible();
    expect(await checks.count()).toBeGreaterThanOrEqual(6);
    for (const check of await checks.all()) {
      await expect(check).toHaveAttribute("data-state", /^(erledigt|offen)$/);
      await expect(check.getByRole("link")).toHaveAttribute("href", /^\/verwalten\//);
    }
    for (const [id, href] of [
      ["admin-overdue", "/verwalten/monatsabschluss"],
      ["admin-invitations", "/verwalten/personen"],
      ["admin-no-contract", "/verwalten/personen"],
    ] as const) {
      const cell = page.getByTestId(id);
      await expect(cell).toBeVisible();
      await expect(cell).toContainText(/\d+/);
      await expect(cell.getByRole("link")).toHaveAttribute("href", href);
    }
  });

  test("the mail warning follows the server's delivery answer on both pages (AC-2)", async ({
    page,
    request,
    tenant,
  }) => {
    const on = await request.put(`${API_BASE}/api/v1/settings/security`, {
      headers: adminHeaders(tenant),
      data: { emailNotificationsEnabled: true },
    });
    expect(on.ok(), `switch notification mails on (${await on.text()})`).toBe(true);
    const smtp = await request.get(`${API_BASE}/api/v1/settings/smtp`, {
      headers: adminHeaders(tenant),
    });
    const { deliveryReady } = (await smtp.json()) as { deliveryReady: boolean };

    await loginAsTenantAdmin(page, tenant);
    await page.goto("/verwalten");
    await expect(page.getByTestId("setup-checks")).toBeVisible();
    await expect(page.getByTestId("mail-warning")).toHaveCount(deliveryReady ? 0 : 1);

    await page.goto("/verwalten/system/allgemein");
    await expect(page.getByTestId("admin-system-email-emailNotificationsEnabled")).toBeAttached();
    await expect(page.getByTestId("mail-warning-smtp")).toHaveCount(deliveryReady ? 0 : 1);
  });

  test("the Personalabteilung lands on Verwalten › Übersicht (AC-4)", async ({
    page,
    request,
    tenant,
  }) => {
    const email = `hr.${tenant.tenantId.toLowerCase()}@example.invalid`;
    const res = await request.post(`${API_BASE}/api/v1/employees`, {
      headers: adminHeaders(tenant),
      data: {
        email,
        firstName: "Verw",
        lastName: "hr",
        employeeNumber: `E847-hr-${tenant.tenantId.slice(-4)}`,
        hireDate: new Date().toISOString(),
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 30,
        password: PASSWORD,
      },
    });
    expect(res.status(), `create hr (${await res.text()})`).toBe(201);
    const { userId } = (await res.json()) as { userId: string };
    const assign = await request.post(`${API_BASE}/api/v1/role-assignments`, {
      headers: adminHeaders(tenant),
      data: { userId, accessRoleId: HR_TEMPLATE, scope: { type: "TENANT" } },
    });
    expect(assign.status(), `assign hr (${await assign.text()})`).toBe(201);

    await login(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/verwalten$/);
    await expect(page.getByTestId("verwalten-overview")).toBeVisible();
    // only checks the person may read, and no link into a page the person cannot open
    for (const link of await page.getByTestId("setup-checks").getByRole("link").all()) {
      await expect(link).not.toHaveAttribute("href", "/verwalten/system/rollen");
    }
  });
});
