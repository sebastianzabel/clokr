/**
 * Issue #843, AC-5 (D-843-09, #575) - no route of the app scrolls horizontally on a phone.
 *
 * The route list is apps/e2e/fixtures/route-register-843.json: one entry per `+page.svelte` under
 * apps/web/src/routes, kept complete by apps/web/src/__tests__/routes-overflow-register-843.test.ts.
 * Every entry that is not skipped (with a registered reason) is visited at 360, 390, 1024 and
 * 1440 px. Per route and width the spec proves that
 *   - the page rendered: its anchor (the Seitenkopf unless the entry names another element) is
 *     visible and the browser did not end up on a different path (a guard redirect would measure
 *     the wrong page and pass vacuously),
 *   - document.documentElement.scrollWidth <= window.innerWidth (the wording of AC-5), and
 *   - measurePageOverflow() names no element that ends right of the viewport unclipped. The second
 *     check is the real one: a card that clips its overflow keeps scrollWidth equal to innerWidth
 *     (helpers/viewport-geometry.ts explains the blind spot of scrollWidth alone).
 * A failing route lists route, width and the offending elements (selector + right edge), so the
 * fixes of plan 843-34 start from the CI log.
 *
 * Auth and data:
 *   - tenant-admin: the tenant fixture bootstraps a throwaway tenant, the spec logs in as its admin
 *     through the API and hydrates localStorage with addInitScript (same model as
 *     month-bar-narrow-viewport.spec.ts). A dynamic route first creates its entity through the
 *     API (synthetic names only); the support-access detail has no tenant-side creation path (the
 *     operator grants it), so its one GET is answered in the browser with page.route.
 *   - operator / operator-anonymous: the operator API is mocked in the browser with the shared
 *     helper of operator-console.spec.ts; the four /support routes additionally get a running
 *     support grant. No tenant fixture is created for these routes.
 *   - none: no session.
 * Every route is visited in its own test, the four widths in a loop (one tenant per route, not per
 * width). No fixed sleeps: waits are auto-waiting assertions and one bounded network-idle wait.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import {
  SUPPORT_EMPLOYEE_ID,
  SUPPORT_REASON,
  TENANT_ID,
  mockOperatorApi,
  mockSupportApi,
  newGrant,
  seedOperatorSession,
} from "../helpers/operator-api-mock";
import { measurePageOverflow } from "../helpers/viewport-geometry";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const WIDTHS = [360, 390, 1024, 1440] as const;
const HEIGHT = 900;

interface RouteEntry {
  page: string;
  path: string;
  auth: "tenant-admin" | "operator" | "operator-anonymous" | "none";
  fill?: string;
  anchor?: string;
  sessionStorage?: Record<string, string>;
  skip?: string;
}

interface Register {
  defaultAnchor: string;
  fills: Record<string, string[]>;
  routes: RouteEntry[];
}

const register = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/route-register-843.json"), "utf8"),
) as Register;

// An empty register would define zero tests and report success; refuse to run on one.
if (register.routes.length < 50) {
  throw new Error(`route register has only ${register.routes.length} entries`);
}

const measured = register.routes.filter((entry) => entry.skip === undefined);

// ── Tenant data (API) ────────────────────────────────────────────────────────────────────────

function authHeaders(token: string) {
  return { "content-type": "application/json", Authorization: `Bearer ${token}` };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** First day of the previous month, so a new person has a hire date in the past. */
function firstOfPreviousMonth(): string {
  const now = new Date();
  return isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

const WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: "09:00",
  close: "18:00",
  ...(day === 6 ? { closed: true } : {}),
}));

async function createEntity(
  request: APIRequestContext,
  tenant: TestTenant,
  fill: string,
): Promise<string> {
  const headers = authHeaders(tenant.adminToken);
  if (fill === "employee") {
    const res = await request.post(`${API_BASE}/api/v1/employees`, {
      headers,
      data: {
        email: `person-a.${tenant.tenantId.toLowerCase()}@example.invalid`,
        firstName: "Person",
        lastName: "A",
        employeeNumber: `E843-${tenant.tenantId.slice(-4)}`,
        hireDate: `${firstOfPreviousMonth()}T00:00:00.000Z`,
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 40,
      },
    });
    expect(res.status(), `create employee (${await res.text()})`).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }
  if (fill === "salon") {
    const res = await request.post(`${API_BASE}/api/v1/salons`, {
      headers,
      data: { name: "Salon Nord", federalState: "HESSEN", openingHours: WEEK },
    });
    expect(res.status(), `create salon (${await res.text()})`).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }
  if (fill === "shutdown" || fill === "auditLog") {
    const start = new Date(Date.now() + 60 * 24 * 3600 * 1000);
    const end = new Date(start.getTime() + 6 * 24 * 3600 * 1000);
    const res = await request.post(`${API_BASE}/api/v1/company-shutdowns`, {
      headers,
      data: {
        name: "Betriebsurlaub Sommer",
        startDate: isoDay(start),
        endDate: isoDay(end),
        deductsFromVacation: true,
      },
    });
    expect(res.status(), `create shutdown (${await res.text()})`).toBe(201);
    const shutdownId = ((await res.json()) as { id: string }).id;
    if (fill === "shutdown") return shutdownId;
    // The shutdown's CREATE audit row is the audit entry the detail page needs.
    const logs = await request.get(`${API_BASE}/api/v1/audit-logs?limit=1`, { headers });
    expect(logs.status(), `read the audit log (${await logs.text()})`).toBe(200);
    const body = (await logs.json()) as { logs: Array<{ id: string }> };
    expect(body.logs.length, "the shutdown wrote an audit row").toBeGreaterThan(0);
    return body.logs[0].id;
  }
  throw new Error(`unknown tenant fill ${fill}`);
}

/** The tenant-side support-access detail has no tenant creation path; serve its one GET. */
async function mockSupportAccessDetail(page: Page, accessId: string): Promise<void> {
  const now = Date.now();
  await page.route(`**/api/v1/support-accesses/${accessId}`, (route) =>
    route.fulfill({
      status: 200,
      json: {
        access: {
          id: accessId,
          operatorName: "Beispiel Betreiber",
          reason: SUPPORT_REASON,
          startedAt: new Date(now - 3_600_000).toISOString(),
          expiresAt: new Date(now + 3_600_000).toISOString(),
          endedAt: null,
          endedBy: null,
          status: "ACTIVE",
          readCount: 2,
        },
        reads: [
          {
            at: new Date(now - 1_800_000).toISOString(),
            category: "EMPLOYEE_MONTH",
            employee: { id: randomUUID(), name: "Person A", anonymized: false },
            month: "2026-10",
            filters: null,
          },
          {
            at: new Date(now - 900_000).toISOString(),
            category: "AUDIT_LOG",
            employee: null,
            month: null,
            filters: { page: 1 },
          },
        ],
        timezone: "Europe/Berlin",
      },
    }),
  );
}

// ── Session ──────────────────────────────────────────────────────────────────────────────────

async function loginAsAdmin(request: APIRequestContext, tenant: TestTenant, page: Page) {
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email: `admin@${tenant.tenantId}.test`, password: PASSWORD },
  });
  expect(res.ok(), `login as the tenant admin (${res.status()})`).toBe(true);
  const body = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown>;
  };
  await page.addInitScript((auth) => {
    try {
      localStorage.setItem("accessToken", auth.accessToken);
      localStorage.setItem("refreshToken", auth.refreshToken);
      localStorage.setItem("user", JSON.stringify(auth.user));
    } catch {
      /* localStorage may be locked; the auth store then falls back to the login page */
    }
  }, body);
}

// ── Measuring ────────────────────────────────────────────────────────────────────────────────

function fillPath(entry: RouteEntry, values: Record<string, string>): string {
  return entry.path.replace(/:[A-Za-z]+/g, (placeholder) => {
    const value = values[placeholder];
    if (value === undefined) throw new Error(`${entry.page}: no value for ${placeholder}`);
    return value;
  });
}

/** Webfonts change text widths; the layout is measured only after fonts and two frames settled. */
async function settle(page: Page): Promise<void> {
  // A page that polls never goes network-idle; the wait is bounded and a timeout is not an error
  // (the anchor assertion above already proved the page rendered).
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
    );
  });
}

async function measureRoute(page: Page, entry: RouteEntry, url: string): Promise<string[]> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const anchor = entry.anchor ?? register.defaultAnchor;
  const wantedPath = new URL(url, "http://localhost").pathname;
  const failures: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.goto(url);
    await expect(
      page.locator(anchor).first(),
      `${entry.path} @ ${width}: anchor ${anchor}`,
    ).toBeVisible({ timeout: 15_000 });
    // A guard or redirect would leave us on another page; measuring that one proves nothing.
    expect(new URL(page.url()).pathname, `${entry.path} @ ${width}: stayed on the route`).toBe(
      wantedPath,
    );
    await settle(page);
    const geometry = await measurePageOverflow(page);
    if (geometry.scrollWidth > geometry.innerWidth) {
      failures.push(
        `${entry.path} @ ${width}: scrollWidth ${geometry.scrollWidth} > innerWidth ${geometry.innerWidth}` +
          ` (beyond viewport: ${geometry.beyondViewport.join("; ") || "none"})`,
      );
    }
    if (geometry.overflowing.length > 0) {
      failures.push(`${entry.path} @ ${width}: overflowing ${geometry.overflowing.join("; ")}`);
    }
  }
  return failures;
}

// ── The tests ────────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "parallel" });

test.describe("all routes fit the viewport (#843 D-843-09)", () => {
  // Four page loads, each with a bounded network-idle wait, plus the entity setup.
  test.describe.configure({ timeout: 120_000 });

  test("the register measures the operator console and the tenant app", () => {
    expect(measured.length).toBeGreaterThanOrEqual(45);
    expect(measured.filter((entry) => entry.auth.startsWith("operator")).length).toBe(7);
  });

  for (const entry of measured.filter((e) => e.auth === "tenant-admin")) {
    test(`${entry.path} fits 360/390/1024/1440 px`, async ({ page, request, tenant }) => {
      await loginAsAdmin(request, tenant, page);
      const values: Record<string, string> = {};
      if (entry.fill === "supportAccess") {
        const accessId = randomUUID();
        await mockSupportAccessDetail(page, accessId);
        values[":supportAccessId"] = accessId;
      } else if (entry.fill !== undefined) {
        const placeholder = register.fills[entry.fill][0];
        values[placeholder] = await createEntity(request, tenant, entry.fill);
      }
      const failures = await measureRoute(page, entry, fillPath(entry, values));
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }

  for (const entry of measured.filter(
    (e) => e.auth === "operator" || e.auth === "operator-anonymous",
  )) {
    test(`${entry.path} fits 360/390/1024/1440 px`, async ({ page }) => {
      await mockOperatorApi(page);
      if (entry.path.includes("/support")) {
        const support = await mockSupportApi(page);
        const grant = newGrant(SUPPORT_REASON, 4);
        support.active = grant;
        support.history = [grant];
      }
      if (entry.auth === "operator") await seedOperatorSession(page);
      const url = fillPath(entry, {
        ":tenantId": TENANT_ID,
        ":operatorEmployeeId": SUPPORT_EMPLOYEE_ID,
      });
      const failures = await measureRoute(page, entry, url);
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }

  for (const entry of measured.filter((e) => e.auth === "none")) {
    test(`${entry.path} fits 360/390/1024/1440 px`, async ({ page }) => {
      if (entry.sessionStorage) {
        await page.addInitScript((items) => {
          for (const [key, value] of Object.entries(items)) sessionStorage.setItem(key, value);
        }, entry.sessionStorage);
      }
      const failures = await measureRoute(page, entry, entry.path);
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});
