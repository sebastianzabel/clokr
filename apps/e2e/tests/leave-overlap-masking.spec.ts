/**
 * Phase 262 (GitHub issue #262) — the checkpoint of plan 262-05, automated.
 *
 * The question this phase opened with was never "what does the page show?" but "what goes over
 * the wire?". A source-level pinning test proves THAT the pages read the value, not WHAT arrives.
 * So this spec reads the actual `GET /api/v1/leave/overlap` response body out of the network
 * layer, in two roles, against the built stack.
 *
 * Proven here:
 *   AC1/AC3  EMPLOYEE gets `typeCode: null` and `typeName: null` — as PRESENT keys, not omitted.
 *   AC4      MANAGER gets the real type, in the inbox dialog and in the team review modal.
 *   AC5      The three overlap panels print what they receive; the neutral word only stands in
 *            for `null`.
 *   D-03     `employeeName` keeps the full name for every role — deliberately not masked.
 *   D-05     No row with `status: "PENDING"` reaches any caller any more.
 *
 * Runs against the docker-compose.test.yml stack (web :3001 / api :4001), on a throwaway tenant
 * that is torn down afterwards. It never touches the dev tenant.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PW = "Pruefung!2026x"; // must satisfy the tenant password policy (12+, upper, special)

/** ISO date `offset` days from today, in the shape the API and the date inputs both use. */
function iso(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** The colleague's absence type — an Art. 9 health datum, the case the issue is built on. */
const ABSENCE_TYPE = "SICK";
const ABSENCE_LABEL = "Krankmeldung";

const RANGE_START = iso(30);
const RANGE_END = iso(32);

interface Actor {
  email: string;
  employeeId: string;
}

interface Fixture {
  tenantId: string;
  adminToken: string;
  colleague: Actor;
  employee: Actor;
  manager: Actor;
  /** The colleague's APPROVED VACATION request — the row whose type must be masked. */
  approvedId: string;
  /** The employee's own PENDING request — the row D-05 must keep off the wire entirely. */
  pendingId: string;
}

async function api(
  request: APIRequestContext,
  method: "get" | "post" | "patch",
  path: string,
  token: string,
  body?: unknown,
) {
  const res = await request[method](`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: body as Record<string, unknown> | undefined,
  });
  if (!res.ok()) {
    throw new Error(`${method.toUpperCase()} ${path} -> ${res.status()}: ${await res.text()}`);
  }
  return res.json();
}

async function createActor(
  request: APIRequestContext,
  adminToken: string,
  tenantId: string,
  name: string,
  role: "EMPLOYEE" | "MANAGER",
): Promise<Actor> {
  const email = `${name}@${tenantId}.test`;
  const created = await api(request, "post", "/api/v1/employees", adminToken, {
    email,
    password: PW,
    role,
    firstName: name === "kollegin" ? "Kim" : name === "mitarbeiter" ? "Alex" : "Robin",
    lastName: name === "kollegin" ? "Kollegin" : name === "mitarbeiter" ? "Mitarbeiter" : "Manager",
    employeeNumber: `${name.slice(0, 3).toUpperCase()}-${tenantId.slice(-4)}`,
    hireDate: `${iso(-400)}T00:00:00Z`,
    weeklyHours: 40,
    scheduleType: "FIXED_SCHEDULE",
  });
  return { email, employeeId: created.id ?? created.employee?.id };
}

async function login(page: Page, email: string) {
  await suppressWhatsNew(page);
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(email);
  await page.getByLabel("Passwort", { exact: true }).fill(PW);
  await page.getByRole("button", { name: /anmelden/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
}

/**
 * The What's-New drawer auto-opens after login and swallows pointer events over the page beneath.
 * It renders only when the release-notes corpus is non-empty (`WhatsNewPanel.svelte:38`), so
 * serving an empty corpus to the browser keeps it out of the way deterministically — dismissing
 * it by click races its entrance animation. Nothing in this phase touches release notes.
 */
async function suppressWhatsNew(page: Page) {
  await page.route("**/api/v1/release-notes*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
}

/** Capture the parsed `/leave/overlap` response body the page actually received. */
function captureOverlap(page: Page): Promise<unknown[]> {
  return page
    .waitForResponse((r) => r.url().includes("/leave/overlap") && r.status() === 200, {
      timeout: 15_000,
    })
    .then((r) => r.json());
}

test.describe("Phase 262 — /leave/overlap masks the absence type over the wire", () => {
  // Each test drives its own logins; the project-level admin storageState must not leak in.
  test.use({ storageState: { cookies: [], origins: [] } });

  // Desktop only. The masking this spec proves is server-side and viewport-independent, while the
  // three overlap panels collapse differently on narrow screens — running it on the mobile and
  // tablet projects would add layout flake without adding evidence.
  test.beforeEach(({ viewport }) => {
    test.skip((viewport?.width ?? 0) < 1024, "desktop-only: layout-independent server assertion");
  });

  let fx: Fixture;

  test.beforeAll(async ({ request }) => {
    const boot = await (await request.post(`${API_BASE}/api/v1/test/bootstrap-tenant`)).json();
    const tenantId: string = boot.tenantId;
    const adminToken: string = boot.adminToken;

    const colleague = await createActor(request, adminToken, tenantId, "kollegin", "EMPLOYEE");
    const employee = await createActor(request, adminToken, tenantId, "mitarbeiter", "EMPLOYEE");
    const manager = await createActor(request, adminToken, tenantId, "manager", "MANAGER");

    // The colleague's APPROVED absence — the row every other caller sees in the overlap panel.
    // SICK on purpose: it is the Art. 9 category the issue is actually about, so the masking is
    // demonstrated on the value that matters, not on a harmless stand-in.
    const approved = await api(request, "post", "/api/v1/leave/requests", adminToken, {
      employeeId: colleague.employeeId,
      type: ABSENCE_TYPE,
      startDate: RANGE_START,
      endDate: RANGE_END,
    });
    await api(request, "patch", `/api/v1/leave/requests/${approved.id}/review`, adminToken, {
      status: "APPROVED",
    });

    // The employee's own PENDING request over the same range — D-05 says it must never be
    // delivered to anyone, and it also gives the manager something to open a review dialog on.
    const pending = await api(request, "post", "/api/v1/leave/requests", adminToken, {
      employeeId: employee.employeeId,
      type: "VACATION",
      startDate: RANGE_START,
      endDate: RANGE_END,
    });

    fx = {
      tenantId,
      adminToken,
      colleague,
      employee,
      manager,
      approvedId: approved.id,
      pendingId: pending.id,
    };
  });

  test.afterAll(async ({ request }) => {
    if (fx?.tenantId) {
      await request.delete(`${API_BASE}/api/v1/test/tenant/${fx.tenantId}`);
    }
  });

  test("EMPLOYEE: the wire carries null, the panel carries the neutral word", async ({ page }) => {
    await login(page, fx.employee.email);
    await page.goto("/leave");
    await page.getByTestId("leave-new-request").click();

    const overlapBody = captureOverlap(page);
    await page.getByTestId("leave-form-from").fill(RANGE_START);
    await page.getByTestId("leave-form-to").fill(RANGE_END);
    const rows = (await overlapBody) as Array<Record<string, unknown>>;

    // --- the actual proof of this phase: what arrived, not what is painted ---
    expect(rows.length, "the colleague's approved absence must be delivered").toBeGreaterThan(0);

    for (const row of rows) {
      // AC1: the field SHAPE is stable — masked means null, never omitted.
      expect(Object.keys(row), "typeCode must be present").toContain("typeCode");
      expect(Object.keys(row), "typeName must be present").toContain("typeName");
      // AC3: the direction that hurts.
      expect(row.typeCode, "EMPLOYEE must not learn a colleague's type").toBeNull();
      expect(row.typeName, "EMPLOYEE must not learn a colleague's type").toBeNull();
      // D-03: the name deliberately stays.
      expect(String(row.employeeName ?? "")).toContain("Kim");
      // D-05: no pending request reaches anyone who does not approve it.
      expect(row.status).toBe("APPROVED");
    }
    expect(
      rows.some((r) => r.id === fx.pendingId),
      "the employee's own PENDING request must not be on the wire",
    ).toBe(false);

    // --- AC5: the panel prints what it received ---
    const panelRow = page.locator(".overlap-row").first();
    await expect(panelRow.locator(".overlap-name")).toContainText("Kim");
    await expect(panelRow.locator(".overlap-type")).toHaveText("abwesend");
  });

  test("MANAGER: the inbox dialog shows the real absence type", async ({ page }) => {
    await login(page, fx.manager.email);
    const overlapBody = captureOverlap(page);
    await page.goto("/inbox");
    await page.getByText("Alex Mitarbeiter", { exact: false }).first().click();
    const rows = (await overlapBody) as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.typeCode === ABSENCE_TYPE)).toBe(true);
    expect(rows.every((r) => r.status === "APPROVED")).toBe(true);

    const chip = page.locator(".overlap-row .chip").first();
    await expect(chip).toHaveText(ABSENCE_LABEL);
    await expect(chip).not.toHaveText("abwesend");
  });

  test("MANAGER: the team review modal shows the real absence type", async ({ page }) => {
    await login(page, fx.manager.email);
    await page.goto("/team/leave");
    // The `leave-team-row-*-review` control lives in the LIST view (`+page.svelte:1459-1533`),
    // not in the approvals cards — the two tabs render different markup for the same data.
    await page.getByTestId("leave-team-view-list").click();

    const overlapBody = captureOverlap(page);
    await page.getByTestId(`leave-team-row-${fx.pendingId}-review`).click();
    const rows = (await overlapBody) as Array<Record<string, unknown>>;

    expect(rows.some((r) => r.typeCode === ABSENCE_TYPE)).toBe(true);

    // Phase 255 (D-21): since both review strecken now render the same shared
    // LeaveReviewDialog.svelte, the absence type uses the global .chip recipe on both — the
    // former .overlap-type vs .chip divergence between /team/leave and /inbox is exactly the
    // drift this phase removes.
    const type = page.locator(".overlap-row .chip").first();
    await expect(type).toHaveText(ABSENCE_LABEL);
    await expect(type).not.toHaveText("abwesend");
  });
});
