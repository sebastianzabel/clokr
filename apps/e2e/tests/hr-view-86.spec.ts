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
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page, Route } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import { measurePageOverflow } from "../helpers/viewport-geometry";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const SECOND_SALON_NAME = "Zweitsalon Testheim";

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

/** The first day of the next month, as a calendar day. */
function firstOfNextMonth(now = new Date()): string {
  return isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
}

/** A calendar day `n` days before (negative: after) `now`. */
function daysAgo(n: number, now = new Date()): string {
  return isoDay(new Date(now.getTime() - n * 24 * 60 * 60 * 1000));
}

/** A calendar day `n` days after the given calendar day. */
function addDays(day: string, n: number): string {
  return daysAgo(-n, new Date(`${day}T00:00:00.000Z`));
}

/** `YYYY-MM-DD` to the German `DD.MM.YYYY` the pages print. */
function deDate(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}.${m}.${y}`;
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
    // An active account: the month close lists only people whose login is active.
    withPassword: true,
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

async function signInAs(
  page: Page,
  request: APIRequestContext,
  person: CreatedEmployee,
): Promise<SessionAuth> {
  const auth = await loginAs(request, person.email, HR_PASSWORD);
  await hydrate(page, auth);
  return auth;
}

interface SalonRow {
  id: string;
  name: string;
  isActive: boolean;
}

/** The week a salon created through the API gets: Monday to Saturday open, Sunday closed. */
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: "09:00",
  close: "18:00",
  ...(day === 6 ? { closed: true } : {}),
}));

async function createSalonViaApi(
  request: APIRequestContext,
  tenant: TestTenant,
  name: string,
): Promise<SalonRow> {
  const res = await request.post(`${API_BASE}/api/v1/salons`, {
    headers: adminHeaders(tenant),
    data: { name, federalState: "HESSEN", openingHours: WEEK },
  });
  expect(res.status(), `create salon "${name}" (${await res.text()})`).toBe(201);
  return (await res.json()) as SalonRow;
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
  /** Calls with no response: a navigation aborted them (browser-side), only GETs may be among them. */
  unanswered(): ApiCall[];
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
    unanswered: () => calls.filter((c) => c.status === null && c.method !== "GET"),
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
    expect(traffic.unanswered(), "no write call without an answer").toEqual([]);
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

  test("Personalabteilung pflegt Beschäftigung und Salonzuordnungen", async ({
    page,
    request,
    tenant,
  }) => {
    const hr = await createHrPerson(request, tenant);
    const x = await createEmployeeX(request, tenant);
    // A second active salon: from here on the tenant has two, so a new employee needs a Stammsalon.
    const second = await createSalonViaApi(request, tenant, SECOND_SALON_NAME);
    await signInAs(page, request, hr);
    const traffic = recordApiTraffic(page);

    const hireDay = firstOfPreviousMonth();
    const nextFirst = firstOfNextMonth();
    const exitDay = daysAgo(2);

    // ── 1. AC-86-1: create an employee with a chosen Stammsalon in a two-salon tenant ─────────
    await page.goto(`${tenant.baseUrl}/admin/employees`);
    await expect(page.getByTestId(`admin-employees-row-${x.id}`)).toBeVisible();
    await page.getByTestId("admin-employees-add").click();
    await page.locator("#c-firstname").fill("Yvonne");
    await page.locator("#c-lastname").fill("Neuanlage");
    await page.locator("#c-email").fill(`neu.${tenant.tenantId.toLowerCase()}@example.invalid`);
    await page.locator("#c-empno").fill(`E86-neu-${tenant.tenantId.slice(-4)}`);
    await page.getByLabel("Passwort direkt setzen (statt Einladungsmail)").check();
    await page.locator("#c-password").fill(HR_PASSWORD);
    const submit = page.getByRole("button", { name: "Mitarbeiter anlegen", exact: true });
    // The Stammsalon is required with two active salons: nothing chosen, nothing to submit.
    await expect(page.locator("#c-home-salon")).toBeVisible();
    await expect(submit).toBeDisabled();
    await page.locator("#c-home-salon").selectOption({ label: SECOND_SALON_NAME });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("row", { name: /Neuanlage/ })).toBeVisible();
    // The chosen salon is what the server stored as the Stammsalon.
    const listRes = await request.get(`${API_BASE}/api/v1/employees`, {
      headers: adminHeaders(tenant),
    });
    const created = ((await listRes.json()) as { id: string; lastName: string }[]).find(
      (e) => e.lastName === "Neuanlage",
    );
    expect(created, "the new employee is in the admin's list").toBeDefined();
    const createdAssignments = (await (
      await request.get(`${API_BASE}/api/v1/employees/${created?.id}/salon-assignments`, {
        headers: adminHeaders(tenant),
      })
    ).json()) as { assignments: { kind: string; salonId: string }[] };
    expect(createdAssignments.assignments.filter((a) => a.kind === "HOME")).toEqual([
      expect.objectContaining({ salonId: second.id }),
    ]);

    // ── 2. AC-86-2: change the contract from the next month-first ─────────────────────────────
    await page.getByTestId(`admin-employees-row-${x.id}`).getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/admin/employees/${x.id}`));
    await page.getByRole("tab", { name: "Arbeitszeit" }).click();
    const contractHistory = page.getByTestId("contract-history");
    await expect(contractHistory.locator("tbody tr")).toHaveCount(1);
    const mondayHours = page.locator("#emp-day-mo");
    await expect(mondayHours).toBeVisible();
    const before = Number(await mondayHours.inputValue());
    await mondayHours.fill(String(before - 2));
    await page.locator("#e-valid-from").fill(nextFirst);
    const modelSection = page.locator("section").filter({
      has: page.locator(".section-title", { hasText: /^Arbeitszeitmodell$/ }),
    });
    await modelSection.getByRole("button", { name: "Speichern" }).click();
    await expect(modelSection.getByText("Gespeichert")).toBeVisible();
    await expect(contractHistory.locator("tbody tr")).toHaveCount(2);
    await expect(contractHistory.locator("tbody tr").first()).toContainText(
      `seit ${deDate(nextFirst)}`,
    );

    // ── 3. AC-86-5: add an Einsatzsalon, end it; both rows stay listed ───────────────────────
    await page.getByRole("tab", { name: "Salons" }).click();
    const assignments = page.getByTestId("salon-assignments-table");
    await expect(assignments.locator("tbody tr")).toHaveCount(1);
    await expect(assignments).toContainText("Stammsalon");
    await page.getByTestId("salon-assignment-add").click();
    await page.locator("#sa-salon").selectOption({ label: SECOND_SALON_NAME });
    await page.locator("#sa-from").fill(hireDay);
    await page.getByTestId("salon-assignment-submit").click();
    const deployment = assignments.locator("tbody tr").filter({ hasText: SECOND_SALON_NAME });
    await expect(deployment).toHaveCount(1);
    await expect(deployment).toContainText("Einsatzsalon");
    await expect(deployment).not.toContainText("beendet");
    await deployment.getByRole("button", { name: "Beenden" }).click();
    await page.locator("#sa-end").fill(addDays(hireDay, 9));
    await page.getByTestId("salon-assignment-submit").click();
    await expect(deployment).toContainText("beendet");
    await expect(deployment.getByRole("button", { name: "Beenden" })).toHaveCount(0);
    // Nothing was deleted: the Stammsalon row and the ended Einsatzsalon row are both listed.
    await expect(assignments.locator("tbody tr")).toHaveCount(2);

    // ── 3b. the month close shows counts, never dates, for another person's gaps ──────────────
    await page.goto(`${tenant.baseUrl}/admin/month-close`);
    const yearSelect = page.getByTestId("month-close-year");
    await expect(yearSelect).toBeVisible();
    await yearSelect.selectOption(hireDay.slice(0, 4));
    const monthRow = page.getByTestId(`month-close-row-${Number(hireDay.slice(5, 7))}`);
    await expect(monthRow).toBeVisible();
    await monthRow.click();
    const xDetail = page.locator(".detail-table tr").filter({ hasText: x.lastName });
    await expect(xDetail).toBeVisible();
    await expect(xDetail).toContainText(/\d+ Tage? ohne Eintrag/);
    await expect(xDetail).not.toContainText(/\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\./);
    await expect(page.getByTestId("month-close-withheld-hint")).toBeVisible();
    // The redaction follows the person: HR's own row (time-entry:read EIGENE over herself) keeps
    // its dates, which also proves the assertion above is not satisfied by an empty page.
    await expect(page.locator(".detail-table tr").filter({ hasText: hr.lastName })).toContainText(
      /\d{2}\.\d{2}\./,
    );

    // Back to the employee for the exit date.
    await page.goto(`${tenant.baseUrl}/admin/employees/${x.id}`);

    // ── 4. AC-86-6: set the exit date (last, so no assignment rule about it interferes) ───────
    await page.getByRole("tab", { name: "Stammdaten" }).click();
    await page.locator("#e-exitdate").fill(exitDay);
    const personal = page.locator("section").filter({
      has: page.locator(".section-title", { hasText: /^Persönliche Daten$/ }),
    });
    const exitSaved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/v1/employees/${x.id}`),
    );
    await personal.getByRole("button", { name: "Speichern" }).click();
    expect((await exitSaved).status(), "the exit date is saved").toBe(200);
    await expect(personal.getByText("Gespeichert")).toBeVisible();

    // ── 5. the ended employee is found with the filter „Ausgeschieden“ ───────────────────────
    await page.goto(`${tenant.baseUrl}/admin/employees`);
    await expect(page.getByTestId(`admin-employees-row-${hr.id}`)).toBeVisible();
    await page.getByLabel("Nach Beschäftigung filtern").selectOption({ label: "Ausgeschieden" });
    await expect(page.getByTestId(`admin-employees-row-${x.id}`)).toBeVisible();
    await expect(page.getByTestId(`admin-employees-row-${x.id}-employment`)).toHaveText(
      `Ausgeschieden am ${deDate(exitDay)}`,
    );
    await expect(page.getByTestId(`admin-employees-row-${hr.id}`)).toHaveCount(0);

    // ── 6. AC-86-3: „Berichte“ is in the navigation and the reports open without exports ─────
    await page
      .getByRole("navigation", { name: "Team" })
      .getByRole("link", { name: "Berichte" })
      .click();
    await expect(page).toHaveURL(/\/reports/);
    await expect(page.getByText("Urlaubsübersicht", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Lade Urlaubsübersicht…")).toHaveCount(0);
    await expect(page.getByText("DATEV Export", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Urlaubsbericht PDF", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /PDF herunterladen/ })).toHaveCount(0);

    // ── 8. the salon admin opens ──────────────────────────────────────────────────────────────
    await page.goto(`${tenant.baseUrl}/admin/salons`);
    await expect(page.getByRole("link", { name: SECOND_SALON_NAME })).toBeVisible();

    // eslint-disable-next-line no-console
    console.log(`[hr-view-86 walk traffic]\n${traffic.lines().join("\n")}`);
    expect(traffic.failures(), "no API answer >= 400").toEqual([]);
    expect(traffic.unanswered(), "no write call without an answer").toEqual([]);
    expect(traffic.forbidden(), "no time-data request").toEqual([]);
  });
});

// ── Visual matrix: 390/360 px × light/dark, deterministic data through route interception ──────

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;
const MODES = ["light", "dark"] as const;
type Mode = (typeof MODES)[number];
const TOLERANCE_PX = 0.5;
/** Set by the phase runner to keep one screenshot per cell; unset in CI (no screenshot). */
const SHOTS_DIR = process.env.HR_VIEW_SHOTS_DIR;

const LONG_LAST_NAME = "Beispiel-Langnamenberg-Zusammengesetzt";
const LONG_FIRST_NAME = "Maximiliane-Alexandra";

type Json = Record<string, unknown>;

async function getJson<T>(request: APIRequestContext, token: string, path: string): Promise<T> {
  const res = await request.get(`${API_BASE}/api/v1${path}`, { headers: authHeaders(token) });
  expect(res.ok(), `GET ${path} (${res.status()})`).toBe(true);
  return (await res.json()) as T;
}

/**
 * Fulfils (never continues) a GET on exactly `pathname`; any other method on an intercepted path is
 * answered 405, so nothing the matrix intercepts can ever reach the real stack.
 */
async function fulfilGet(page: Page, pathname: string, body: unknown) {
  await page.route(
    (url) => url.pathname === pathname,
    (route: Route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          })
        : route.fulfill({ status: 405, contentType: "application/json", body: "{}" }),
  );
}

/** The deterministic answers of the matrix, shaped like the real ones (cloned from the stack). */
async function interceptMatrixData(
  page: Page,
  request: APIRequestContext,
  token: string,
  x: CreatedEmployee,
  mode: Mode,
) {
  const realList = await getJson<Json[]>(request, token, "/employees");
  const realListX = realList.find((e) => e.id === x.id);
  expect(realListX, "the real list contains the employee").toBeDefined();
  const realX = await getJson<Json>(request, token, `/employees/${x.id}`);
  const realHistory = await getJson<Json[]>(request, token, `/settings/work/${x.id}/history`);
  const realPreferences = await getJson<Json>(request, token, "/me/preferences");
  expect(realHistory.length, "the real contract history is not empty").toBeGreaterThan(0);

  const listItem = (over: Json): Json => ({
    ...realListX,
    userId: randomUUID(),
    ...over,
    user: { ...((realListX as Json).user as Json), ...((over.user as Json | undefined) ?? {}) },
  });
  const people = [
    listItem({
      id: randomUUID(),
      employeeNumber: "E86-0001",
      firstName: LONG_FIRST_NAME,
      lastName: LONG_LAST_NAME,
      exitDate: null,
      user: { email: "maximiliane.alexandra.langnamenberg.zusammengesetzt@example.invalid" },
    }),
    listItem({
      id: randomUUID(),
      employeeNumber: "E86-0002",
      firstName: "Egon",
      lastName: "Ausgeschieden",
      exitDate: `${daysAgo(40)}T00:00:00.000Z`,
      user: { email: "egon.ausgeschieden@example.invalid" },
    }),
    listItem({
      id: randomUUID(),
      employeeNumber: "E86-0003",
      firstName: "Petra",
      lastName: "Planaustritt",
      exitDate: `${daysAgo(-40)}T00:00:00.000Z`,
      user: { email: "petra.planaustritt@example.invalid" },
    }),
  ];

  const nord = { id: randomUUID(), name: "Salon Nord", isActive: true };
  const sued = { id: randomUUID(), name: "Salon Süd", isActive: true };
  const ost = { id: randomUUID(), name: "Salon Ost", isActive: false };
  const assignment = (over: Json): Json => ({
    id: randomUUID(),
    employeeId: x.id,
    kind: "DEPLOYMENT",
    validUntil: null,
    weekdays: [],
    ...over,
  });
  const assignments = [
    assignment({ salonId: nord.id, kind: "HOME", validFrom: "2025-01-01" }),
    assignment({ salonId: sued.id, validFrom: "2026-09-01", weekdays: [1, 3, 5] }),
    assignment({ salonId: ost.id, validFrom: "2025-03-01", validUntil: "2025-05-31" }),
  ];

  const historyRow = (over: Json): Json => ({ ...realHistory[0], id: randomUUID(), ...over });
  const history = [
    historyRow({
      type: "FIXED_SCHEDULE",
      validFrom: "2025-01-01T00:00:00.000Z",
      weeklyHours: "38.50",
    }),
    historyRow({
      type: "MONTHLY_HOURS",
      validFrom: "2025-10-01T00:00:00.000Z",
      weeklyHours: null,
      monthlyHours: "60.00",
    }),
    historyRow({
      type: "SHIFT_BASED",
      validFrom: "2026-07-01T00:00:00.000Z",
      weeklyHours: "38.00",
      contractWorkDaysPerWeek: 5,
      usualWorkDays: [],
    }),
  ];

  const year = new Date().getFullYear();
  const monthNames = [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ];
  const withheld = (name: string, number: string, count: number): Json => ({
    employeeName: name,
    employeeNumber: number,
    missingDates: [],
    missingDateCount: count,
    dayDetailsWithheld: true,
  });
  const months = monthNames.map((name, i) => ({
    month: i + 1,
    name,
    status: i < 2 ? "closed" : i === 2 ? "partial" : "future",
    closedCount: i < 2 ? 3 : i === 2 ? 1 : 0,
    totalCount: 3,
    ...(i === 2
      ? {
          missing: [
            withheld("Probe, Anna", "E86-0101", 4),
            withheld(`${LONG_LAST_NAME}, ${LONG_FIRST_NAME}`, "E86-0001", 2),
          ],
        }
      : {}),
  }));
  const detail = (
    id: string,
    name: string,
    number: string,
    status: string,
    over: Json = {},
  ): Json => ({
    employeeId: id,
    employeeName: name,
    employeeNumber: number,
    status,
    missingDates: [],
    missingDateCount: 0,
    unconfirmedBreakDayCount: 0,
    breakFindingDayCount: 0,
    karenzOverrunDayCount: 0,
    karenzOverrunDays: [],
    breakFindingDays: [],
    dayDetailsWithheld: true,
    ...over,
  });

  // The server's own mode preference would override the stored one after sign-in.
  await fulfilGet(page, "/api/v1/me/preferences", { ...realPreferences, mode });
  await fulfilGet(page, "/api/v1/employees", people);
  await fulfilGet(page, `/api/v1/employees/${x.id}`, {
    ...realX,
    firstName: LONG_FIRST_NAME,
    lastName: LONG_LAST_NAME,
    exitDate: null,
  });
  await fulfilGet(page, `/api/v1/employees/${x.id}/salon-assignments`, { assignments });
  await fulfilGet(page, "/api/v1/salons", { salons: [nord, sued, ost], isMultiSalon: true });
  await fulfilGet(page, `/api/v1/settings/work/${x.id}/history`, history);
  await fulfilGet(page, "/api/v1/overtime/close-month/year-status", {
    year,
    months,
    autoCloseDeadline: 10,
    earliestYear: year,
  });
  await fulfilGet(page, "/api/v1/overtime/close-month/status", {
    year,
    month: 3,
    employees: [
      detail(randomUUID(), "Probe, Anna", "E86-0101", "missing", {
        missingDateCount: 4,
        unconfirmedBreakDayCount: 1,
        breakFindingDayCount: 2,
        karenzOverrunDayCount: 1,
      }),
      detail(randomUUID(), `${LONG_LAST_NAME}, ${LONG_FIRST_NAME}`, "E86-0001", "missing", {
        missingDateCount: 2,
      }),
      detail(randomUUID(), "Muster, Bernd", "E86-0102", "closed"),
    ],
  });
  await fulfilGet(page, "/api/v1/overtime/close-month/deferred", {
    employeeCount: 2,
    oldestOpenMonth: { year, month: 3 },
    monthsBehind: 2,
    gapCount: 6,
    severity: "WARNING",
    employees: [
      {
        employeeId: randomUUID(),
        employeeName: "Probe, Anna",
        oldestOpenMonth: { year, month: 3 },
        monthsBehind: 2,
        reason: "GAPS",
        gapDates: [],
        gapCount: 4,
        dayDetailsWithheld: true,
      },
      {
        employeeId: randomUUID(),
        employeeName: `${LONG_LAST_NAME}, ${LONG_FIRST_NAME}`,
        oldestOpenMonth: { year, month: 3 },
        monthsBehind: 2,
        reason: "GAPS",
        gapDates: [],
        gapCount: 2,
        dayDetailsWithheld: true,
      },
    ],
  });
  return { people, longName: `${LONG_LAST_NAME}, ${LONG_FIRST_NAME}` };
}

/** Waits until no finite animation or transition is still running and webfonts are loaded. */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== "running",
      ),
  );
}

interface CellResult {
  cell: string;
  innerWidth: number;
  scrollWidth: number;
  overflowing: number;
}

/** Asserts the mode under test is active, measures the whole page and keeps one screenshot. */
async function checkCell(
  page: Page,
  pageName: string,
  width: number,
  mode: Mode,
): Promise<CellResult> {
  await settle(page);
  // Anti-vacuity: the mode under test is the one on screen — attribute AND painted background.
  await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
  const luminance = await page.evaluate(() => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(
      getComputedStyle(document.body).backgroundColor,
    );
    return m ? (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000 : -1;
  });
  expect(luminance, `${pageName} ${mode}: body background luminance`).toBeGreaterThanOrEqual(0);
  if (mode === "dark") expect(luminance, `${pageName}: dark background`).toBeLessThan(128);
  else expect(luminance, `${pageName}: light background`).toBeGreaterThan(128);

  const overflow = await measurePageOverflow(page, TOLERANCE_PX);
  const cell = `${pageName} ${width}px ${mode}`;
  expect(overflow.overflowing, `${cell}: ${JSON.stringify(overflow.beyondViewport)}`).toEqual([]);
  expect(overflow.scrollWidth, `${cell}: the document scrolls sideways`).toBeLessThanOrEqual(
    overflow.innerWidth + TOLERANCE_PX,
  );
  // The whole-page probe above counts an element as fine when a clipping ancestor ends inside the
  // viewport; that hides content cut off by an `overflow: hidden` box (found on the Salons tab:
  // buttons and a table column clipped by the card). Content may only leave its box where the box
  // scrolls: a hidden/clipped box whose content is wider than the box is a defect.
  const cutOff = await page.evaluate(() =>
    [...document.body.querySelectorAll("*")]
      .filter((e) => {
        const ox = getComputedStyle(e).overflowX;
        return (ox === "hidden" || ox === "clip") && e.scrollWidth > e.clientWidth + 1;
      })
      .slice(0, 8)
      .map(
        (e) =>
          `${e.tagName.toLowerCase()}${[...e.classList].map((c) => `.${c}`).join("")} (content ${e.scrollWidth} > box ${e.clientWidth})`,
      ),
  );
  expect(cutOff, `${cell}: content cut off by a non-scrolling box`).toEqual([]);
  if (SHOTS_DIR) {
    mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({
      path: join(SHOTS_DIR, `${pageName}-${width}-${mode}.png`),
      fullPage: true,
    });
  }
  // eslint-disable-next-line no-console
  console.log(
    `[hr-view-86 cell] ${cell}: innerWidth=${overflow.innerWidth} scrollWidth=${overflow.scrollWidth} overflowing=${overflow.overflowing.length}`,
  );
  return {
    cell,
    innerWidth: overflow.innerWidth,
    scrollWidth: overflow.scrollWidth,
    overflowing: overflow.overflowing.length,
  };
}

test.describe("Issue #86 — Sichtmatrix 390/360 px, hell/dunkel", () => {
  for (const viewport of VIEWPORTS) {
    for (const mode of MODES) {
      test(`Liste, Detail (Salons, Arbeitszeit) und Monatsabschluss bei ${viewport.width} px, ${
        mode === "light" ? "hell" : "dunkel"
      }`, async ({ page, request, tenant }) => {
        const hr = await createHrPerson(request, tenant);
        const x = await createEmployeeX(request, tenant);
        const auth = await signInAs(page, request, hr);
        await page.addInitScript((m) => {
          try {
            localStorage.setItem("mode", m);
          } catch {
            /* localStorage may be locked; the cell then fails on the mode assertion */
          }
        }, mode);
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: "reduce" });
        const { people } = await interceptMatrixData(page, request, auth.accessToken, x, mode);
        const traffic = recordApiTraffic(page);
        const results: CellResult[] = [];

        // 1. the employee list: a long name, an ended employee, an exit planned
        await page.goto(`${tenant.baseUrl}/admin/employees`);
        for (const p of people) {
          await expect(page.getByTestId(`admin-employees-row-${String(p.id)}`)).toBeVisible();
        }
        await expect(
          page.getByTestId(`admin-employees-row-${String(people[1].id)}-employment`),
        ).toContainText("Ausgeschieden am");
        await expect(
          page.getByTestId(`admin-employees-row-${String(people[2].id)}-employment`),
        ).toContainText("Austritt am");
        results.push(await checkCell(page, "employee-list", viewport.width, mode));

        // 2. the detail page, Salons tab: three rows incl. an inactive salon
        await page.goto(`${tenant.baseUrl}/admin/employees/${x.id}`);
        await expect(page.getByRole("tab", { name: "Salons" })).toBeVisible();
        await expect(page.getByText(/Danger/)).toHaveCount(0);
        await page.getByRole("tab", { name: "Salons" }).click();
        const rows = page.locator('[data-testid^="salon-assignment-row-"]');
        await expect(rows).toHaveCount(3);
        await expect(page.getByTestId("salon-assignments-table")).toContainText(
          "Salon Ost (inaktiv)",
        );
        results.push(await checkCell(page, "employee-salons", viewport.width, mode));

        // 3. the detail page, Arbeitszeit tab: three contract rows
        await page.getByRole("tab", { name: "Arbeitszeit" }).click();
        await expect(page.getByTestId("contract-history").locator("tbody tr")).toHaveCount(3);
        await expect(page.getByText(/Danger/)).toHaveCount(0);
        results.push(await checkCell(page, "employee-arbeitszeit", viewport.width, mode));

        // 4. the month close: counts instead of dates, the withheld hint, the deferred banner
        await page.goto(`${tenant.baseUrl}/admin/month-close`);
        await expect(page.getByTestId("month-close-withheld-hint")).toBeVisible();
        await expect(page.getByTestId("month-close-deferred")).toContainText("4 Tage ohne Eintrag");
        await page.getByTestId("month-close-row-3").click();
        await expect(
          page.locator(".detail-table tr").filter({ hasText: "Probe, Anna" }),
        ).toContainText("4 Tage ohne Eintrag");
        results.push(await checkCell(page, "month-close", viewport.width, mode));

        expect(results).toHaveLength(4);
        // Only data of the intercepted fixtures was shown; no time-data request was made.
        expect(traffic.forbidden(), "no time-data request").toEqual([]);
        expect(traffic.failures(), "no API answer >= 400").toEqual([]);
        expect(traffic.unanswered(), "no write call without an answer").toEqual([]);
      });
    }
  }
});
