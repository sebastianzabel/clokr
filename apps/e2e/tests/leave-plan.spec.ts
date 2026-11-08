/**
 * Issue #835 — the leave planner (Urlaubsplanung), driven in a real browser on the real test stack.
 *
 * The component, API and kernel tests prove each piece; this spec proves the one promise only a
 * browser can show: a manager opens the plan of a salon for next year, enters a wish for a
 * colleague through the wish dialog, drags the end handle of the wish bar by two day columns
 * (pointer events, the PATCH is awaited, never slept on), takes the plan over and ends with exactly
 * one APPROVED VACATION request on the moved dates.
 *
 * Setup goes through the API with the tenant admin's token (the Admin template holds
 * `leave-plan:manage`): one employee E, homed in the tenant's default salon by the employee
 * creation, and E's VACATION entitlement for the plan year (the entitlement read creates the row,
 * exactly as the app does). Everything the planner does is driven through the UI with `data-testid`
 * selectors.
 *
 * The plan year is NEXT calendar year, computed from the clock, so the spec has no fixed date (the
 * year-scoped lists of #319 never hide the rows, and no wish is ever in the past). The wish week is
 * the second Monday of March: Monday to Wednesday is entered in the dialog, the end handle is
 * dragged two columns to Friday. March has no public holiday before the 20th in any Bundesland, so
 * the priced days are the five weekdays.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const DAY_MS = 24 * 60 * 60 * 1000;

// The plan year: next calendar year, as the planner page itself defaults to.
const YEAR = new Date().getFullYear() + 1;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The second Monday of March of the plan year (UTC date, the day numbers are all we compare). */
function secondMondayOfMarch(): Date {
  const first = new Date(Date.UTC(YEAR, 2, 1));
  const offset = (8 - first.getUTCDay()) % 7;
  return new Date(first.getTime() + (offset + 7) * DAY_MS);
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
      email: `plan-${stamp}@${tenant.tenantId}.test`,
      firstName: "Plan",
      lastName: "Wunsch",
      employeeNumber: `PL-${stamp.toString(36).slice(-6)}`,
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
): Promise<void> {
  const res = await request.get(
    `${API_BASE}/api/v1/leave/entitlements/${employeeId}?year=${YEAR}`,
    { headers: authHeaders(tenant) },
  );
  expect(res.ok(), `read the ${YEAR} entitlement (${res.status()})`).toBe(true);
}

test.describe("Leave planner (Issue #835)", () => {
  test("open the plan, enter a wish, drag it longer, take the plan over", async ({
    page,
    request,
    tenant,
  }) => {
    const employee = await createEmployee(request, tenant);
    await ensureEntitlement(request, tenant, employee.id);

    const monday = secondMondayOfMarch();
    const wednesday = iso(new Date(monday.getTime() + 2 * DAY_MS));
    const friday = iso(new Date(monday.getTime() + 4 * DAY_MS));
    const mondayIso = iso(monday);

    await loginAsTenantAdmin(page, tenant);
    await page.goto(`/leave/planung?year=${YEAR}`);
    await expect(page.getByTestId("leave-plan-page")).toBeVisible();

    // ── open the plan ──────────────────────────────────────────────────────────────────────
    const openResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/leave/plans") && r.request().method() === "POST",
    );
    await page.getByTestId("leave-plan-open").click();
    expect((await openResponse).status()).toBe(201);
    await expect(page.getByTestId("leave-plan-head")).toBeVisible();

    // ── enter a wish for E through the wish dialog (manager path) ─────────────────────────
    await page.getByTestId("leave-plan-add-wish").click();
    await page.getByTestId("wish-person").selectOption(employee.id);
    await page.getByTestId("wish-start").fill(mondayIso);
    await page.getByTestId("wish-end").fill(wednesday);
    const createResponse = page.waitForResponse(
      (r) => /\/leave\/plans\/[^/]+\/wishes$/.test(r.url()) && r.request().method() === "POST",
    );
    await page.getByTestId("wish-save").click();
    const created = await createResponse;
    expect(created.status(), `create the wish (${await created.text()})`).toBe(201);
    const wishId = ((await created.json()) as { wish: { id: string } }).wish.id;

    // ── the month view of March makes the day columns wide enough to drag ─────────────────
    await page.getByRole("radio", { name: "Monat" }).click();
    await page.locator('select[aria-label="Monat"]').selectOption("2");
    const track = page.getByTestId(`plan-track-${employee.id}`);
    await expect(track).toBeVisible();
    await expect(page.getByTestId(`leave-plan-wish-${wishId}`)).toBeVisible();

    // ── drag the end handle two day columns to the right (Wednesday -> Friday) ────────────
    const handle = page.getByTestId(`leave-plan-wish-handle-end-${wishId}`);
    await handle.scrollIntoViewIfNeeded();
    const handleBox = await handle.boundingBox();
    const trackBox = await track.boundingBox();
    expect(handleBox, "the end handle has a box").not.toBeNull();
    expect(trackBox, "the person's track has a box").not.toBeNull();
    const columnWidth = trackBox!.width / 31; // March has 31 day columns
    const x = handleBox!.x + handleBox!.width / 2;
    const y = handleBox!.y + handleBox!.height / 2;

    const patchResponse = page.waitForResponse(
      (r) => r.url().endsWith(`/wishes/${wishId}`) && r.request().method() === "PATCH",
    );
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + columnWidth, y, { steps: 6 });
    await page.mouse.move(x + 2 * columnWidth, y, { steps: 6 });
    await page.mouse.up();
    const patched = await patchResponse;
    expect(patched.status(), `move the wish (${await patched.text()})`).toBe(200);
    const moved = ((await patched.json()) as { wish: { startDate: string; endDate: string } }).wish;
    expect(moved.startDate.slice(0, 10)).toBe(mondayIso);
    expect(moved.endDate.slice(0, 10)).toBe(friday);

    // ── take the plan over ────────────────────────────────────────────────────────────────
    const takeoverButton = page.getByTestId("leave-plan-takeover");
    await expect(takeoverButton).toBeEnabled();
    await takeoverButton.click();
    await expect(page.getByTestId("takeover-count")).toContainText("1 offener Wunsch");
    const takeoverResponse = page.waitForResponse(
      (r) => /\/leave\/plans\/[^/]+\/takeover$/.test(r.url()) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Übernehmen", exact: true }).click();
    const takeover = await takeoverResponse;
    expect(takeover.status(), `take the plan over (${await takeover.text()})`).toBe(200);

    await expect(page.getByTestId("takeover-result")).toBeVisible();
    await expect(page.getByTestId("takeover-created")).toContainText("Plan Wunsch");
    await expect(page.getByTestId("takeover-plan-status")).toContainText("Übernommen");
    await page.getByTestId("takeover-done").click();

    // ── the API agrees: one APPROVED vacation request on the moved dates, the plan is closed ──
    const listRes = await request.get(
      `${API_BASE}/api/v1/leave/requests?employeeId=${employee.id}&year=${YEAR}`,
      { headers: authHeaders(tenant) },
    );
    expect(listRes.ok(), `list the requests (${listRes.status()})`).toBe(true);
    const requests = (await listRes.json()) as Array<{
      status: string;
      typeCode: string;
      startDate: string;
      endDate: string;
    }>;
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("APPROVED");
    expect(requests[0].typeCode).toBe("VACATION");
    expect(requests[0].startDate.slice(0, 10)).toBe(mondayIso);
    expect(requests[0].endDate.slice(0, 10)).toBe(friday);

    const salonsRes = await request.get(`${API_BASE}/api/v1/salons`, {
      headers: authHeaders(tenant),
    });
    const salonId = ((await salonsRes.json()) as { salons: Array<{ id: string }> }).salons[0].id;
    const plansRes = await request.get(
      `${API_BASE}/api/v1/leave/plans?salonId=${salonId}&year=${YEAR}`,
      { headers: authHeaders(tenant) },
    );
    const plans = ((await plansRes.json()) as { plans: Array<{ status: string }> }).plans;
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe("TAKEN_OVER");
  });
});
