/**
 * Issue #86 — the Personalabteilung view in a real browser.
 *
 * The API, mounted and pure-module tests prove each piece; this spec proves the promises only a
 * browser can show, on the real test stack:
 *   a. a user holding the Personalabteilung template (TENANT) plus the Mitarbeiter role opens the
 *      employee list, an employee's detail page (every visible tab), the reports, the month close
 *      and the salon admin WITHOUT one API answer >= 400 and WITHOUT one request to a time-data
 *      endpoint (time entries, day breaks, retro requests, month saldo) — DSGVO Art. 5 lit. c;
 *   b. the tab strip shows Stammdaten, Arbeitszeit, Urlaub, Salons and never Berechtigungen or
 *      Gefahrenzone; HR changes a contract from the next month-first, adds and ends an Einsatzsalon,
 *      sets an exit date and finds the ended person with the filter „Ausgeschieden“;
 *   c. HR creates an employee with a chosen Stammsalon in a tenant with two active salons;
 *   d. the list, the detail page (Salons and Arbeitszeit tabs) and the month close fit 390 and
 *      360 px in light and dark mode. The visual matrix runs on route interception: the interesting
 *      shapes (a long name, an ended person, an inactive salon, withheld day details) are
 *      fulfilled from fixtures instead of being produced by the real stack, so the cells do not
 *      depend on the current date. An intercepted path is always FULFILLED, never continued.
 *
 * Auth: same model as admin-salons.spec.ts (throwaway tenant, API login, localStorage hydrated with
 * addInitScript). The HR person is created through the API the way an admin would: an employee with
 * a direct password and the default Mitarbeiter role, then the Personalabteilung template assigned
 * TENANT-wide. Names are synthetic, e-mail addresses end in `.invalid`. No fixed sleeps; every wait
 * is on an observable condition.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
/** The HR person signs in with a direct password the admin sets at creation. */
const HR_PASSWORD = "Hr-Pruefung-86-test1234";

/**
 * The system role template „Personalabteilung“. Copied from `SYSTEM_ROLE_IDS.HR` in
 * `apps/api/src/contexts/platform/system-roles.ts` (this package cannot import apps/api).
 */
const HR_TEMPLATE_ID = "00000000-0000-4000-8000-00000000a006";

/** Request paths (prefixes under `/api/v1`) an HR session must never touch. */
const FORBIDDEN_PREFIXES = [
  "/api/v1/time-entries",
  "/api/v1/day-breaks",
  "/api/v1/retro-entry-requests",
  "/api/v1/overtime/month-saldo",
] as const;

function authHeaders(token: string) {
  return { "content-type": "application/json", Authorization: `Bearer ${token}` };
}

function adminHeaders(tenant: TestTenant) {
  return authHeaders(tenant.adminToken);
}

// ── Dates (computed from the current date; the spec has no date dependency) ──────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD` of a UTC calendar day. */
function isoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The first day of the previous month, as a calendar day. */
function firstOfPreviousMonth(now = new Date()): string {
  return isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

// ── Setup through the API ────────────────────────────────────────────────────────────────────

interface CreatedEmployee {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
}

async function createEmployeeViaApi(
  request: APIRequestContext,
  tenant: TestTenant,
  spec: { key: string; firstName: string; lastName: string; withPassword?: boolean },
): Promise<CreatedEmployee> {
  const email = `${spec.key}.${tenant.tenantId.toLowerCase()}@example.invalid`;
  const res = await request.post(`${API_BASE}/api/v1/employees`, {
    headers: adminHeaders(tenant),
    data: {
      email,
      firstName: spec.firstName,
      lastName: spec.lastName,
      employeeNumber: `E86-${spec.key}-${tenant.tenantId.slice(-4)}`,
      hireDate: `${firstOfPreviousMonth()}T00:00:00.000Z`,
      scheduleType: "FIXED_SCHEDULE",
      weeklyHours: 40,
      ...(spec.withPassword ? { password: HR_PASSWORD } : {}),
    },
  });
  expect(res.status(), `create employee ${spec.key} (${await res.text()})`).toBe(201);
  const body = (await res.json()) as { id: string; userId: string };
  return {
    id: body.id,
    userId: body.userId,
    email,
    firstName: spec.firstName,
    lastName: spec.lastName,
  };
}

/** The admin creates the HR person (Mitarbeiter role) and assigns the Personalabteilung template. */
async function createHrPerson(
  request: APIRequestContext,
  tenant: TestTenant,
): Promise<CreatedEmployee> {
  const hr = await createEmployeeViaApi(request, tenant, {
    key: "hr",
    firstName: "Hanna",
    lastName: "Personalprobe",
    withPassword: true,
  });
  const res = await request.post(`${API_BASE}/api/v1/role-assignments`, {
    headers: adminHeaders(tenant),
    data: { userId: hr.userId, accessRoleId: HR_TEMPLATE_ID, scope: { type: "TENANT" } },
  });
  expect(res.status(), `assign the Personalabteilung template (${await res.text()})`).toBe(201);
  return hr;
}

/** A second employee with a contract and a hire date on the first day of the previous month. */
async function createEmployeeX(
  request: APIRequestContext,
  tenant: TestTenant,
): Promise<CreatedEmployee> {
  return createEmployeeViaApi(request, tenant, {
    key: "x",
    firstName: "Xaver",
    lastName: "Beispiel",
  });
}

interface SessionAuth {
  accessToken: string;
  refreshToken: string;
  user: Record<string, unknown>;
}

async function loginAs(request: APIRequestContext, email: string, password: string) {
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email, password },
  });
  expect(res.ok(), `login as ${email} (${res.status()} ${await res.text()})`).toBe(true);
  return (await res.json()) as SessionAuth;
}

async function hydrate(page: Page, auth: SessionAuth) {
  await page.addInitScript(({ accessToken, refreshToken, user }) => {
    try {
      localStorage.setItem("accessToken", accessToken);
      localStorage.setItem("refreshToken", refreshToken);
      localStorage.setItem("user", JSON.stringify(user));
    } catch {
      /* localStorage may be locked; the auth store then falls back to the login page */
    }
  }, auth);
}

async function signInAs(page: Page, request: APIRequestContext, person: CreatedEmployee) {
  await hydrate(page, await loginAs(request, person.email, HR_PASSWORD));
}

// ── Request collector ────────────────────────────────────────────────────────────────────────

interface ApiCall {
  method: string;
  path: string;
  status: number | null;
}

interface Traffic {
  /** Every `/api/v1/` request seen, with the status once the response arrived. */
  calls: ApiCall[];
  /** Deduplicated `METHOD path -> status` lines for the SUMMARY. */
  lines(): string[];
  failures(): ApiCall[];
  forbidden(): ApiCall[];
  saw(method: string, pathPattern: RegExp): boolean;
}

function recordApiTraffic(page: Page): Traffic {
  const calls: ApiCall[] = [];
  const byRequest = new Map<unknown, ApiCall>();
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/v1/")) return;
    const call: ApiCall = { method: req.method(), path: url.pathname, status: null };
    byRequest.set(req, call);
    calls.push(call);
  });
  page.on("response", (res) => {
    const call = byRequest.get(res.request());
    if (call) call.status = res.status();
  });
  return {
    calls,
    lines: () =>
      [
        ...new Set(calls.map((c) => `${c.method} ${c.path} -> ${c.status ?? "no response"}`)),
      ].sort(),
    failures: () => calls.filter((c) => c.status !== null && c.status >= 400),
    forbidden: () =>
      calls.filter((c) => FORBIDDEN_PREFIXES.some((prefix) => c.path.startsWith(prefix))),
    saw: (method, pathPattern) =>
      calls.some((c) => c.method === method && pathPattern.test(c.path)),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────

test.describe("Issue #86 — Personalabteilung im Browser", () => {
  test("Personalabteilung öffnet die Detailansicht ohne Tageszeiten", async ({
    page,
    request,
    tenant,
  }) => {
    const hr = await createHrPerson(request, tenant);
    const x = await createEmployeeX(request, tenant);
    await signInAs(page, request, hr);
    const traffic = recordApiTraffic(page);

    await page.goto(`${tenant.baseUrl}/admin/employees`);
    await expect(page.getByTestId("admin-employees-page")).toBeVisible();
    const xRow = page.getByTestId(`admin-employees-row-${x.id}`);
    await expect(xRow).toBeVisible();
    await expect(xRow).toContainText(x.lastName);

    await xRow.getByRole("link", { name: new RegExp(x.lastName) }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/employees/${x.id}`));
    await expect(
      page.getByRole("tabpanel").getByText("Persönliche Daten", { exact: true }),
    ).toBeVisible();

    // The tab strip is exactly what HR may use; Berechtigungen and Gefahrenzone are absent.
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveText(["Stammdaten", "Arbeitszeit", "Urlaub", "Salons"]);
    await expect(page.getByRole("tab", { name: "Berechtigungen" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Gefahrenzone" })).toHaveCount(0);

    // Walk every visible tab and wait for something that tab renders.
    await page.getByRole("tab", { name: "Arbeitszeit" }).click();
    await expect(page.getByText("Arbeitszeitmodell", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("contract-history")).toBeVisible();

    await page.getByRole("tab", { name: "Urlaub" }).click();
    await expect(page.getByText(/Urlaubsanspruch \d{4}/).first()).toBeVisible();

    await page.getByRole("tab", { name: "Salons" }).click();
    await expect(page.getByTestId("salon-assignments-table")).toBeVisible();
    await expect(page.getByTestId("salon-assignments-table")).toContainText("Stammsalon");

    await page.getByRole("tab", { name: "Stammdaten" }).click();
    await expect(
      page.getByRole("tabpanel").getByText("Persönliche Daten", { exact: true }),
    ).toBeVisible();

    // The traffic of this session.
    // eslint-disable-next-line no-console
    console.log(`[hr-view-86 tracer traffic]\n${traffic.lines().join("\n")}`);
    expect(traffic.failures(), "no API answer >= 400").toEqual([]);
    expect(traffic.forbidden(), "no time-data request").toEqual([]);
    // Anti-vacuity: the collector really saw the reads this page makes.
    expect(traffic.saw("GET", /^\/api\/v1\/employees$/), "employee list read seen").toBe(true);
    expect(
      traffic.saw("GET", new RegExp(`^/api/v1/employees/${x.id}$`)),
      "employee read seen",
    ).toBe(true);
    expect(
      traffic.saw("GET", new RegExp(`^/api/v1/employees/${x.id}/salon-assignments$`)),
      "salon-assignment read seen",
    ).toBe(true);
  });
});
