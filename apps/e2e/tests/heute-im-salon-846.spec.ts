/**
 * Issue #846 — Team › Heute im Salon.
 *
 *   AC-1  At 1440×900 and 390×844 the Kennzahlen Anwesend, Erwartet, Abwesend and Aufgaben are on the
 *         first screen (above the phone tab bar).
 *   AC-2  Every Kennzahl is a link to its filtered list (?status=… on the page, Aufgaben to Team ›
 *         Aufgaben).
 *   AC-3  A Salonmanager of one salon sees only the persons of that salon (reach rules #82/#84/#85).
 *   AC-5  „Genehmigen“ decides through the dialog of Aufgaben and acknowledges with a toast; the
 *         request is APPROVED on the server afterwards.
 *
 * Own tenant per test (tenant fixture); persons and the second salon are created through the API,
 * the system role template ids are copied from SYSTEM_ROLE_IDS (this package cannot import apps/api).
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, type TestTenant } from "../fixtures";
import { login, loginAsTenantAdmin } from "./helpers";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = `Heute-${randomUUID()}!`;
const SALON_MANAGER = "00000000-0000-4000-8000-00000000a005";

function adminHeaders(tenant: TestTenant) {
  return { authorization: `Bearer ${tenant.adminToken}`, "content-type": "application/json" };
}

function firstOfPreviousMonth(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString();
}

async function firstSalonId(request: APIRequestContext, tenant: TestTenant): Promise<string> {
  const res = await request.get(`${API_BASE}/api/v1/salons`, { headers: adminHeaders(tenant) });
  expect(res.ok(), `GET /salons (${res.status()})`).toBe(true);
  const body = (await res.json()) as { id: string }[] | { salons: { id: string }[] };
  const rows = Array.isArray(body) ? body : body.salons;
  return rows[0].id;
}

async function createSalon(request: APIRequestContext, tenant: TestTenant): Promise<string> {
  const week = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "09:00", close: "18:00" }));
  const res = await request.post(`${API_BASE}/api/v1/salons`, {
    headers: adminHeaders(tenant),
    data: { name: `Süd ${tenant.tenantId.slice(-4)}`, federalState: "HESSEN", openingHours: week },
  });
  expect(res.status(), `create salon (${await res.text()})`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function createPerson(
  request: APIRequestContext,
  tenant: TestTenant,
  key: string,
  homeSalonId: string,
  managerOf?: string,
): Promise<{ email: string; employeeId: string }> {
  const email = `${key}.${tenant.tenantId.toLowerCase()}@example.invalid`;
  const res = await request.post(`${API_BASE}/api/v1/employees`, {
    headers: adminHeaders(tenant),
    data: {
      email,
      firstName: "Heute",
      lastName: key,
      employeeNumber: `E846-${key}-${tenant.tenantId.slice(-4)}`,
      hireDate: firstOfPreviousMonth(),
      scheduleType: "FIXED_SCHEDULE",
      weeklyHours: 40,
      password: PASSWORD,
      homeSalonId,
    },
  });
  expect(res.status(), `create ${key} (${await res.text()})`).toBe(201);
  const { userId, id } = (await res.json()) as { userId: string; id: string };
  if (managerOf) {
    const assign = await request.post(`${API_BASE}/api/v1/role-assignments`, {
      headers: adminHeaders(tenant),
      data: {
        userId,
        accessRoleId: SALON_MANAGER,
        scope: { type: "SALONS", salonIds: [managerOf] },
      },
    });
    expect(assign.status(), `assign ${key} (${await assign.text()})`).toBe(201);
  }
  return { email, employeeId: id };
}

async function tokenOf(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email, password: PASSWORD },
  });
  expect(res.ok(), `login ${email} (${res.status()})`).toBe(true);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

test.describe("Heute im Salon (#846)", () => {
  test("every Kennzahl links to its filtered list and the four sit on the first screen (AC-1, AC-2)", async ({
    page,
    tenant,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/team/heute");
    for (const id of ["kpi-present", "kpi-expected", "kpi-absent", "kpi-tasks"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} rendered`).not.toBeNull();
      expect(box!.y + box!.height, `${id} on the first screen`).toBeLessThanOrEqual(900);
    }
    for (const [id, status] of [
      ["kpi-present", "anwesend"],
      ["kpi-expected", "erwartet"],
      ["kpi-absent", "abwesend"],
    ] as const) {
      await page.getByTestId(id).getByRole("link").click();
      await expect(page).toHaveURL(new RegExp(`/team/heute\\?status=${status}#jetzt$`));
      await expect(page.getByRole("radio", { checked: true })).toBeVisible();
    }
    await page.getByTestId("kpi-tasks").getByRole("link").click();
    await expect(page).toHaveURL(/\/team\/aufgaben/);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/team/heute");
    await expect(page.getByTestId("kpi-tasks")).toBeVisible();
    const bar = page.locator("nav.bottom-tab-bar");
    const barTop = (await bar.isVisible()) ? ((await bar.boundingBox())?.y ?? 844) : 844;
    for (const id of ["kpi-present", "kpi-expected", "kpi-absent", "kpi-tasks"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.y + box!.height, `${id} above the tab bar`).toBeLessThanOrEqual(barTop);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("a Salonmanager sees only the persons of the own salon and decides through the dialog (AC-3, AC-5)", async ({
    page,
    request,
    tenant,
  }) => {
    const nord = await firstSalonId(request, tenant);
    const sued = await createSalon(request, tenant);
    const manager = await createPerson(request, tenant, "leitung", nord, nord);
    const inReach = await createPerson(request, tenant, "nord", nord);
    await createPerson(request, tenant, "sued", sued);

    // A sick day filed by the person in reach (vacation would trip the entitlement guard of a bare
    // fixture tenant — the leave-flow pattern).
    const day = new Date();
    day.setDate(day.getDate() + 14);
    const dateStr = day.toISOString().slice(0, 10);
    const filed = await request.post(`${API_BASE}/api/v1/leave/requests`, {
      headers: {
        authorization: `Bearer ${await tokenOf(request, inReach.email)}`,
        "content-type": "application/json",
      },
      data: { type: "SICK", startDate: dateStr, endDate: dateStr },
    });
    expect(filed.ok(), `file the request (${await filed.text()})`).toBe(true);
    const leave = (await filed.json()) as { id: string; status: string };
    expect(leave.status).toBe("PENDING");

    await login(page, manager.email, PASSWORD);
    await expect(page).toHaveURL(/\/team\/heute$/);
    const week = page.getByTestId("team-week");
    await expect(week).toContainText("Heute nord");
    await expect(week).not.toContainText("Heute sued");

    // D-03: decided through the dialog of Aufgaben, acknowledged in the toast status region
    await page.getByRole("button", { name: "Genehmigen", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Genehmigen", exact: true }).click();
    await expect(page.getByTestId("toast-region-status")).toContainText(/genehmigt · /);

    const after = await request.get(`${API_BASE}/api/v1/leave/requests?status=APPROVED`, {
      headers: adminHeaders(tenant),
    });
    expect(after.ok()).toBe(true);
    const approved = (await after.json()) as { id: string }[];
    expect(approved.map((r) => r.id)).toContain(leave.id);
  });
});
