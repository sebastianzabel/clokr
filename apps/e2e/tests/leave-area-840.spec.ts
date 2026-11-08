/**
 * Issue #840 — the Abwesenheiten area, driven in a real browser on the real test stack.
 *
 * Slice 1 (plan 840-02): the Übersicht of `/team/leave`. The API tests prove the masked calendar
 * read and the component tests prove the bars; this spec proves the promise only a browser can
 * show: a manager opens `/team/leave?tab=uebersicht&zoom=monat&datum=<first day>` and sees one
 * row per absent person and one bar per absence of that month on the new timeline — an approved
 * request as a solid bar, a PENDING request as a dashed bar (computed `border-top-style`, so the
 * style is the one the browser really draws, not a class name).
 *
 * Setup goes through the API with the tenant admin's token: one employee, two VACATION requests
 * filed for them, the first approved by `PATCH …/review`, the second left PENDING. The admin
 * reads the whole tenant in detail, so both bars are detailed ones.
 *
 * The month is the month AFTER the current one, computed from the clock, so the spec holds no
 * fixed date and no request lies in the past. The requests sit on the second and the third
 * Monday to Wednesday of it (two different ISO weeks, no overlap); a public holiday inside such
 * a span only changes the priced day count, never the bar.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The first day of the month after the current one (UTC date; only day numbers are compared). */
function firstOfNextMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The n-th Monday (1-based) on or after the first of the month. */
function nthMonday(first: Date, n: number): Date {
  const offset = (8 - first.getUTCDay()) % 7;
  return new Date(first.getTime() + (offset + (n - 1) * 7) * DAY_MS);
}

function authHeaders(tenant: TestTenant) {
  return { "content-type": "application/json", Authorization: `Bearer ${tenant.adminToken}` };
}

async function loginAsTenantAdmin(page: Page, tenant: TestTenant): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(`admin@${tenant.tenantId}.test`);
  await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /anmelden/i }).click();
  await page.waitForURL(/\/(dashboard|time-entries|leave|$)/, { timeout: 10_000 });
}

async function createEmployee(
  request: APIRequestContext,
  tenant: TestTenant,
): Promise<{ id: string }> {
  const stamp = Date.now();
  const res = await request.post(`${API_BASE}/api/v1/employees`, {
    headers: authHeaders(tenant),
    data: {
      usualWorkDays: [1, 2, 3, 4, 5],
      email: `uebersicht-${stamp}@${tenant.tenantId}.test`,
      firstName: "Uebersicht",
      lastName: "Balken",
      employeeNumber: `UE-${stamp.toString(36).slice(-6)}`,
      hireDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
      role: "EMPLOYEE",
    },
  });
  expect(res.status(), `create the employee (${await res.text()})`).toBeLessThan(300);
  return (await res.json()) as { id: string };
}

/** Reading the entitlements of a year creates the regular VACATION row for it, as the app does. */
async function ensureEntitlement(
  request: APIRequestContext,
  tenant: TestTenant,
  employeeId: string,
  year: number,
): Promise<void> {
  const res = await request.get(
    `${API_BASE}/api/v1/leave/entitlements/${employeeId}?year=${year}`,
    {
      headers: authHeaders(tenant),
    },
  );
  expect(res.ok(), `read the ${year} entitlement (${res.status()})`).toBe(true);
}

async function fileVacation(
  request: APIRequestContext,
  tenant: TestTenant,
  employeeId: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/api/v1/leave/requests`, {
    headers: authHeaders(tenant),
    data: { employeeId, type: "VACATION", startDate, endDate },
  });
  expect(res.status(), `file the request (${await res.text()})`).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

test.describe("Abwesenheiten area (Issue #840)", () => {
  test("the Übersicht draws an approved request solid and a pending one dashed", async ({
    page,
    request,
    tenant,
  }) => {
    const first = firstOfNextMonth();
    const employee = await createEmployee(request, tenant);
    await ensureEntitlement(request, tenant, employee.id, first.getUTCFullYear());

    const approvedStart = nthMonday(first, 2);
    const pendingStart = nthMonday(first, 3);
    const approvedId = await fileVacation(
      request,
      tenant,
      employee.id,
      iso(approvedStart),
      iso(new Date(approvedStart.getTime() + 2 * DAY_MS)),
    );
    const pendingId = await fileVacation(
      request,
      tenant,
      employee.id,
      iso(pendingStart),
      iso(new Date(pendingStart.getTime() + 2 * DAY_MS)),
    );
    const review = await request.patch(`${API_BASE}/api/v1/leave/requests/${approvedId}/review`, {
      headers: authHeaders(tenant),
      data: { status: "APPROVED" },
    });
    expect(review.status(), `approve the first request (${await review.text()})`).toBeLessThan(300);

    await loginAsTenantAdmin(page, tenant);
    const calendar = page.waitForResponse(
      (r) => r.url().includes("/api/v1/leave/calendar?from=") && r.status() === 200,
    );
    await page.goto(`/team/leave?tab=uebersicht&zoom=monat&datum=${iso(first)}`);
    await calendar;

    // One row for the one absent person, one bar per absence of the month.
    const track = page.getByTestId(`plan-track-${employee.id}`);
    await expect(track).toBeVisible();
    await expect(page.getByTestId("absence-timeline")).toBeVisible();

    const solid = track.locator('[data-bar-style="gesetzt"]');
    const dashed = track.locator('[data-bar-style="beantragt"]');
    await expect(solid).toHaveCount(1);
    await expect(dashed).toHaveCount(1);
    await expect(track.getByTestId(`absence-bar-${approvedId}`)).toBeVisible();
    await expect(track.getByTestId(`absence-bar-${pendingId}`)).toBeVisible();

    // The browser really draws the pending bar dashed and the approved one solid.
    const borderOf = (bar: typeof solid) =>
      bar.evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(await borderOf(dashed)).toBe("dashed");
    expect(await borderOf(solid)).toBe("solid");
  });
});
