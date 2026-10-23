/**
 * Issue #612 — the period report page (/reports) in a real browser.
 *
 * The API, mounted and pure-module tests prove each piece; this spec proves what only a browser
 * can show, on the real test stack. Three describes:
 *
 *   functional    — tenant fixture, admin, two people with closed entries in the previous and (when a
 *                   weekday before today exists) the current month, recorded through the people's own
 *                   sessions:
 *                   a. ◀ and a preset issue exactly one `GET /reports/period` each, the URL gains
 *                      `from`/`to`, the KPI "Ist" and the table row follow the answer (the figures are
 *                      READ from the intercepted response, never mocked);
 *                   b. the other tab, reload: period, tab and table survive;
 *                   c. two salons: a shared link with `salonId` selects that salon in the header, a
 *                      header change adds it to the URL and the period request, a reload keeps it;
 *                   d. a name click opens the drill-down with `person=` and Back closes it, a modifier
 *                      click opens a new tab with the drill-down open;
 *                   e. a three-month period: "Exportieren" opens a dialog whose month select defaults
 *                      to the last month.
 *   matrix        — route interception of `/reports/period` (shaped like one real answer, long names,
 *                   big figures, 30 people) at 390 and 360 px × light/dark on both period tabs and the
 *                   drill-down: whole-page geometry, clipped-content probe, and axe `nested-interactive`
 *                   on the two mobile lists (with a positive control, so the rule is proven to see).
 *   layout checks — the month picker is not clipped (`document.elementFromPoint` inside
 *                   `.month-picker`) in editorial/modern × light/dark at 1280 and 390 px; no KPI value
 *                   overflows its tile at 961, 1280 and 1440 px; the sticky table header is never hidden
 *                   behind the period bar (editorial/modern × comfortable/compact).
 *
 * A fourth describe (Issue #714) proves what the salon switch shows where a reader looks: after the
 * header is switched to a salon, the KPI tile "Im Salon gearbeitet", the Stammsalon hint, the row of
 * the person homed there and the section with "Aushilfen aus anderen Salons" are each in the
 * viewport (1280, 390 and 360 px, light and dark), with two controls that show the check can fail.
 *
 * Auth: same model as hr-view-86.spec.ts (throwaway tenant, API login, localStorage hydrated with
 * addInitScript). Names are synthetic. No fixed sleeps: every wait is on an observable condition.
 * Dates of the functional describe are computed from the current day; the matrix and layout checks
 * install the browser clock on 2026-09-16 (the longest German month label, like the month-bar spec).
 */
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, BrowserContext, Locator, Page, Route } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import { measurePageOverflow } from "../helpers/viewport-geometry";
import { zonedInstant } from "../helpers/tenant-zone";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const TENANT_TZ = "Europe/Berlin";
const PERSON_PASSWORD = `Rp-${randomUUID()}!`;

// The tenant is provisioned in Europe/Berlin; the browser must read "today" and the current month
// in that zone, otherwise the bar's default period and the dates created here could differ.
test.use({ timezoneId: TENANT_TZ });

type Json = Record<string, unknown>;
type Skin = "editorial" | "modern";
type Mode = "light" | "dark";
type Density = "comfortable" | "compact";

// ── Dates ───────────────────────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today's calendar day in the tenant's zone, as a UTC-midnight Date. */
function todayInTenantZone(): Date {
  const [y, m, d] = new Date()
    .toLocaleDateString("sv-SE", { timeZone: TENANT_TZ })
    .split("-")
    .map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

interface Ym {
  year: number;
  month: number;
}

function ymOf(d: Date): Ym {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function addMonths(ym: Ym, n: number): Ym {
  const idx = ym.year * 12 + (ym.month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

function ymKey(ym: Ym): string {
  return `${ym.year}-${pad(ym.month)}`;
}

const MONTH_NAMES_DE = [
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

function monthName(ym: Ym): string {
  return `${MONTH_NAMES_DE[ym.month - 1]} ${ym.year}`;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The first weekday on or after the 10th of a month (a day inside the 90-day retro window). */
function weekdayMidMonth(ym: Ym): string {
  const d = new Date(Date.UTC(ym.year, ym.month - 1, 10));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return dayKey(d);
}

/** The latest weekday strictly before today inside the current month, or null (e.g. on the 1st). */
function latestWeekdayBeforeTodayInMonth(): string | null {
  const today = todayInTenantZone();
  for (let back = 1; back < 31; back += 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - back);
    if (d.getUTCMonth() !== today.getUTCMonth()) return null;
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return dayKey(d);
  }
  return null;
}

/** H:MM from whole minutes, the hour part grouped with a dot (mirrors `fmtHoursDe`, unsigned). */
function fmtHours(min: number): string {
  const whole = Math.round(min);
  const h = Math.floor(Math.abs(whole) / 60);
  const m = Math.abs(whole) % 60;
  return `${String(h).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}:${pad(m)}`;
}

// ── Setup through the API ───────────────────────────────────────────────────────────────────

function authHeaders(token: string) {
  return { "content-type": "application/json", Authorization: `Bearer ${token}` };
}

interface SessionAuth {
  accessToken: string;
  refreshToken: string;
  user: Record<string, unknown>;
}

async function loginAs(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<SessionAuth> {
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email, password },
  });
  expect(res.ok(), `login as ${email} (${res.status()} ${await res.text()})`).toBe(true);
  return (await res.json()) as SessionAuth;
}

interface UiPrefs {
  skin?: Skin;
  mode?: Mode;
  density?: Density;
}

/**
 * Signs the tenant admin in and hydrates the browser. The server-side preference wins over
 * localStorage on hydration, so skin, mode and density are stored on the account first.
 */
async function signInAdmin(
  page: Page,
  request: APIRequestContext,
  tenant: TestTenant,
  prefs: UiPrefs = {},
): Promise<SessionAuth> {
  const auth = await loginAs(request, `admin@${tenant.tenantId}.test`, PASSWORD);
  if (Object.keys(prefs).length > 0) {
    const res = await request.put(`${API_BASE}/api/v1/me/preferences`, {
      headers: authHeaders(auth.accessToken),
      data: prefs,
    });
    expect(res.ok(), `store the UI preferences (${res.status()})`).toBe(true);
  }
  await page.addInitScript(
    ({ accessToken, refreshToken, user, ui }) => {
      try {
        localStorage.setItem("accessToken", accessToken);
        localStorage.setItem("refreshToken", refreshToken);
        localStorage.setItem("user", JSON.stringify(user));
        if (ui.skin) localStorage.setItem("skin", ui.skin);
        if (ui.mode) localStorage.setItem("mode", ui.mode);
        if (ui.density) localStorage.setItem("density", ui.density);
      } catch {
        /* localStorage may be locked; the auth store then falls back to the login page */
      }
    },
    { ...auth, ui: prefs },
  );
  return auth;
}

interface Person {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
}

async function createPerson(
  request: APIRequestContext,
  tenant: TestTenant,
  key: string,
  firstName: string,
  lastName: string,
  hireDay: string,
  homeSalonId?: string,
): Promise<Person> {
  const email = `${key}.${tenant.tenantId.toLowerCase()}@example.invalid`;
  const res = await request.post(`${API_BASE}/api/v1/employees`, {
    headers: authHeaders(tenant.adminToken),
    data: {
      email,
      firstName,
      lastName,
      employeeNumber: `E612-${key}-${tenant.tenantId.slice(-4)}`,
      hireDate: `${hireDay}T00:00:00.000Z`,
      scheduleType: "FIXED_SCHEDULE",
      weeklyHours: 40,
      password: PERSON_PASSWORD,
      ...(homeSalonId ? { homeSalonId } : {}),
    },
  });
  expect(res.status(), `create person ${key} (${await res.text()})`).toBe(201);
  const body = (await res.json()) as { id: string };
  return { id: body.id, email, firstName, lastName, fullName: `${firstName} ${lastName}` };
}

/** A closed entry recorded through the PERSON's own session (setup only; the salon is derived). */
async function recordOwnEntry(
  request: APIRequestContext,
  person: Person,
  day: string,
  start: string,
  end: string,
  breakMinutes: number,
  salonId?: string,
) {
  const auth = await loginAs(request, person.email, PERSON_PASSWORD);
  const res = await request.post(`${API_BASE}/api/v1/time-entries`, {
    headers: authHeaders(auth.accessToken),
    data: {
      date: day,
      startTime: zonedInstant(day, start, TENANT_TZ).toISOString(),
      endTime: zonedInstant(day, end, TENANT_TZ).toISOString(),
      breakMinutes,
      ...(salonId ? { salonId } : {}),
    },
  });
  expect(res.status(), `record an entry on ${day} (${await res.text()})`).toBe(201);
}

interface Seeded {
  anna: Person;
  bernd: Person;
  /** Whether the current month holds recorded days (false on the 1st or on a weekend start). */
  currentMonthHasEntries: boolean;
}

/**
 * Two people with closed entries: the previous month always (long days, so the previous month's
 * Ist is clearly different from the current one's), the current month when a weekday before today
 * exists (short days). The retro window is raised to its maximum first, because the previous
 * month's mid-month day lies outside the default ten days.
 */
async function seedTwoPeople(request: APIRequestContext, tenant: TestTenant): Promise<Seeded> {
  const win = await request.put(`${API_BASE}/api/v1/settings/work`, {
    headers: authHeaders(tenant.adminToken),
    data: { retroEntryWindowDays: 90 },
  });
  expect(win.ok(), `raise the retro window (${win.status()})`).toBe(true);

  const now = ymOf(todayInTenantZone());
  const hire = `${ymKey(addMonths(now, -3))}-01`;
  const anna = await createPerson(request, tenant, "anna", "Anna", "Perioden-Alpha", hire);
  const bernd = await createPerson(request, tenant, "bernd", "Bernd", "Perioden-Beta", hire);

  const previousDay = weekdayMidMonth(addMonths(now, -1));
  await recordOwnEntry(request, anna, previousDay, "08:00", "16:00", 30);
  await recordOwnEntry(request, bernd, previousDay, "08:00", "14:00", 30);

  const currentDay = latestWeekdayBeforeTodayInMonth();
  if (currentDay) {
    await recordOwnEntry(request, anna, currentDay, "09:00", "12:00", 0);
    await recordOwnEntry(request, bernd, currentDay, "09:00", "11:00", 0);
  }
  return { anna, bernd, currentMonthHasEntries: currentDay !== null };
}

// ── Request and page helpers ─────────────────────────────────────────────────────────────────

interface PeriodAnswer {
  from: string;
  to: string;
  kpis: { workedMinutes: number; personCount: number; salonWorkedMinutes?: number };
  rows: Array<{ employeeId: string; employeeName: string; workedMinutes: number }>;
  /** Present only under a salon filter (Issue #714). */
  personBasis?: string;
  helpers?: Array<{ employeeId: string; employeeName: string; salonWorkedMinutes: number }>;
}

function isPeriodUrl(url: string): boolean {
  return new URL(url).pathname === "/api/v1/reports/period";
}

/** Records every `GET /reports/period` the page makes (the CSV route is another path). */
function recordPeriodRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "GET" && isPeriodUrl(req.url())) urls.push(req.url());
  });
  return urls;
}

function periodResponse(page: Page, from: Ym, to: Ym, salonId?: string) {
  return page.waitForResponse((res) => {
    if (!isPeriodUrl(res.url())) return false;
    const u = new URL(res.url());
    return (
      u.searchParams.get("from") === ymKey(from) &&
      u.searchParams.get("to") === ymKey(to) &&
      (salonId === undefined || u.searchParams.get("salonId") === salonId)
    );
  });
}

async function answerOf(res: { json(): Promise<unknown> }): Promise<PeriodAnswer> {
  return (await res.json()) as PeriodAnswer;
}

function kpiValue(page: Page, label: string) {
  return page
    .locator("article.kpi", {
      has: page.locator(".kpi-label", { hasText: new RegExp(`^${label}$`) }),
    })
    .locator(".kpi-value");
}

async function waitKpisSettled(page: Page) {
  await expect(page.getByTestId("period-kpis")).toHaveAttribute("aria-busy", "false");
}

/** The cell of a table row under the column whose header starts with `header`. */
async function tableCell(page: Page, rowText: string, header: RegExp) {
  const headers = await page.locator("table.period-table thead th").allInnerTexts();
  const col = headers.findIndex((h) => header.test(h.trim()));
  expect(col, `column ${header} among ${JSON.stringify(headers)}`).toBeGreaterThanOrEqual(0);
  return page.locator("tr.period-row", { hasText: rowText }).locator("th, td").nth(col);
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
// functional
// ═════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Issue #612 — Berichtsseite: Zeitraum im Browser", () => {
  test("◀ und Voreinstellung: je eine Anfrage, Kennzahl und Tabelle folgen, URL trägt den Zeitraum", async ({
    page,
    request,
    tenant,
  }) => {
    const { anna } = await seedTwoPeople(request, tenant);
    await signInAdmin(page, request, tenant);
    const urls = recordPeriodRequests(page);
    const now = ymOf(todayInTenantZone());
    const prev = addMonths(now, -1);

    // The page opens on the first tab with the current month.
    const first = periodResponse(page, now, now);
    await page.goto(`${tenant.baseUrl}/reports`);
    const currentAnswer = await answerOf(await first);
    await expect(page.getByRole("tab", { name: "Zeiten & Konten" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("reports-period-label")).toContainText(monthName(now));
    await waitKpisSettled(page);
    await expect(kpiValue(page, "Ist")).toContainText(fmtHours(currentAnswer.kpis.workedMinutes));

    // ◀: exactly one more request, for the previous month.
    const before = urls.length;
    const prevRes = periodResponse(page, prev, prev);
    await page.getByTestId("reports-period-prev").click();
    const prevAnswer = await answerOf(await prevRes);
    await waitKpisSettled(page);
    expect(urls, "one period request for the arrow").toHaveLength(before + 1);
    await expect(page).toHaveURL(new RegExp(`from=${ymKey(prev)}&to=${ymKey(prev)}`));
    await expect(page.getByTestId("reports-period-label")).toContainText(monthName(prev));

    // Anti-vacuity: the previous month holds the long days, so the figure really changed.
    expect(prevAnswer.kpis.workedMinutes, "previous month has recorded time").toBeGreaterThan(0);
    expect(prevAnswer.kpis.workedMinutes).not.toBe(currentAnswer.kpis.workedMinutes);
    await expect(kpiValue(page, "Ist")).toContainText(fmtHours(prevAnswer.kpis.workedMinutes));
    const annaRow = prevAnswer.rows.find((r) => r.employeeName === anna.fullName);
    expect(annaRow, "the answer lists the seeded person").toBeDefined();
    await expect(page.locator("tr.period-row", { hasText: anna.lastName })).toHaveCount(1);
    await expect(await tableCell(page, anna.lastName, /^ist\b/i)).toContainText(
      fmtHours(annaRow!.workedMinutes),
    );
    expect(urls, "no duplicate request after the answer").toHaveLength(before + 1);

    // The preset "Letzte 3 Monate": one request, a three-month URL and eyebrow.
    const from3 = addMonths(now, -2);
    const beforePreset = urls.length;
    const threeRes = periodResponse(page, from3, now);
    await page.getByRole("button", { name: "Letzte 3 Monate" }).click();
    const threeAnswer = await answerOf(await threeRes);
    await waitKpisSettled(page);
    expect(urls, "one period request for the preset").toHaveLength(beforePreset + 1);
    await expect(page).toHaveURL(new RegExp(`from=${ymKey(from3)}&to=${ymKey(now)}`));
    // Mirrors `periodKind`: the three months are a calendar quarter when the third month ends one
    // (March, June, September, December), otherwise a free range.
    const isQuarter = [3, 6, 9, 12].includes(now.month);
    await expect(page.locator(".month-bar-eyebrow")).toHaveText(
      isQuarter ? "Quartal" : "Zeitraum · 3 Monate",
    );
    expect(threeAnswer.kpis.workedMinutes).toBeGreaterThanOrEqual(prevAnswer.kpis.workedMinutes);
    await expect(kpiValue(page, "Ist")).toContainText(fmtHours(threeAnswer.kpis.workedMinutes));
    const annaThree = threeAnswer.rows.find((r) => r.employeeName === anna.fullName)!;
    await expect(await tableCell(page, anna.lastName, /^ist\b/i)).toContainText(
      fmtHours(annaThree.workedMinutes),
    );
  });

  test("anderer Tab und Neuladen: Zeitraum, Tab und Tabelle bleiben", async ({
    page,
    request,
    tenant,
  }) => {
    const { anna } = await seedTwoPeople(request, tenant);
    await signInAdmin(page, request, tenant);
    const now = ymOf(todayInTenantZone());
    const prev = addMonths(now, -1);

    const first = periodResponse(page, now, now);
    await page.goto(`${tenant.baseUrl}/reports`);
    await first;
    const prevRes = periodResponse(page, prev, prev);
    await page.getByTestId("reports-period-prev").click();
    await prevRes;

    // The tab switch changes the URL but asks nothing new of the period endpoint.
    const urls = recordPeriodRequests(page);
    await page.getByRole("tab", { name: "Urlaub & Abwesenheit" }).click();
    await expect(page).toHaveURL(/tab=urlaub/);
    await expect(page.getByText("Urlaubsübersicht", { exact: true }).first()).toBeVisible();
    expect(urls, "a tab switch makes no period request").toHaveLength(0);

    const reloaded = periodResponse(page, prev, prev);
    await page.reload();
    await reloaded;
    await expect(page.getByRole("tab", { name: "Urlaub & Abwesenheit" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("reports-period-label")).toContainText(monthName(prev));
    await expect(page).toHaveURL(new RegExp(`from=${ymKey(prev)}&to=${ymKey(prev)}&tab=urlaub`));
    await expect(page.getByText("Urlaubsübersicht", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(anna.lastName).first()).toBeVisible();

    // And back to the first tab: the table of the same period is there again.
    await page.getByRole("tab", { name: "Zeiten & Konten" }).click();
    await expect(page.locator("tr.period-row", { hasText: anna.lastName })).toHaveCount(1);
  });

  test("zwei Salons: der Link wählt den Salon, die Kopfauswahl schreibt ihn in URL und Anfrage, Neuladen behält ihn", async ({
    page,
    request,
    tenant,
  }) => {
    const salonsRes = await request.get(`${API_BASE}/api/v1/salons`, {
      headers: authHeaders(tenant.adminToken),
    });
    expect(salonsRes.ok()).toBe(true);
    const firstSalon = ((await salonsRes.json()) as { salons: Array<{ id: string }> }).salons[0];
    const created = await request.post(`${API_BASE}/api/v1/salons`, {
      headers: authHeaders(tenant.adminToken),
      data: {
        name: "Zweitsalon Perioden",
        federalState: "HESSEN",
        openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day,
          open: "09:00",
          close: "18:00",
          ...(day === 6 ? { closed: true } : {}),
        })),
      },
    });
    expect(created.status(), `create the second salon (${await created.text()})`).toBe(201);
    const second = (await created.json()) as { id: string; name: string };
    const now = ymOf(todayInTenantZone());

    await signInAdmin(page, request, tenant);
    const urls = recordPeriodRequests(page);
    const switcher = page.locator("select.salon-switcher-select");

    // A fresh link with the first salon selects it in the header and the request carries it.
    const linked = periodResponse(page, now, now, firstSalon.id);
    await page.goto(
      `${tenant.baseUrl}/reports?from=${ymKey(now)}&to=${ymKey(now)}&salonId=${firstSalon.id}`,
    );
    await linked;
    await expect(switcher).toBeVisible();
    await expect(switcher).toHaveValue(firstSalon.id);

    // Choosing the second salon in the header: URL and request follow.
    const before = urls.length;
    const secondRes = periodResponse(page, now, now, second.id);
    await switcher.selectOption(second.id);
    await secondRes;
    await expect(page).toHaveURL(new RegExp(`salonId=${second.id}`));
    expect(
      urls.slice(before).every((u) => new URL(u).searchParams.get("salonId") === second.id),
    ).toBe(true);
    expect(urls, "exactly one request for the header change").toHaveLength(before + 1);

    // Reload keeps it.
    const reloaded = periodResponse(page, now, now, second.id);
    await page.reload();
    await reloaded;
    await expect(switcher).toHaveValue(second.id);
    await expect(page).toHaveURL(new RegExp(`salonId=${second.id}`));
  });

  test("Name anklicken öffnet die Personenansicht mit person=, Zurück schließt, Strg-Klick öffnet einen neuen Tab", async ({
    page,
    context,
    request,
    tenant,
  }) => {
    const { anna } = await seedTwoPeople(request, tenant);
    await signInAdmin(page, request, tenant);
    const now = ymOf(todayInTenantZone());
    const prev = addMonths(now, -1);

    const first = periodResponse(page, now, now);
    await page.goto(`${tenant.baseUrl}/reports`);
    await first;
    const prevRes = periodResponse(page, prev, prev);
    await page.getByTestId("reports-period-prev").click();
    await prevRes;
    const link = page.getByRole("link", { name: anna.fullName });
    await expect(link).toBeVisible();
    const listUrl = page.url();

    // A plain click: person= in the URL, a dialog named after the person.
    await link.click();
    await expect(page).toHaveURL(/person=[0-9a-f-]{36}/);
    const dialog = page.getByRole("dialog", { name: anna.fullName });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Personenansicht");

    // Back closes it and the URL loses person= (the click was the one history push).
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(page).not.toHaveURL(/person=/);
    expect(page.url()).toBe(listUrl);

    // A modifier click is left to the browser: a new tab with the drill-down open.
    const opened = (context as BrowserContext).waitForEvent("page");
    await link.click({ modifiers: ["ControlOrMeta"] });
    const tab = await opened;
    await expect(tab).toHaveURL(/person=[0-9a-f-]{36}/);
    await expect(tab.getByRole("dialog", { name: anna.fullName })).toBeVisible();
    // The first page was not navigated by the modifier click.
    await expect(page).not.toHaveURL(/person=/);
    await tab.close();
  });

  test("Zeitraum über drei Monate: Exportieren zeigt die Monatsauswahl, vorbelegt mit dem letzten Monat", async ({
    page,
    request,
    tenant,
  }) => {
    await seedTwoPeople(request, tenant);
    await signInAdmin(page, request, tenant);
    const now = ymOf(todayInTenantZone());
    const from3 = addMonths(now, -2);

    const res = periodResponse(page, from3, now);
    await page.goto(`${tenant.baseUrl}/reports?from=${ymKey(from3)}&to=${ymKey(now)}`);
    await res;
    await waitKpisSettled(page);

    await page.getByTestId("reports-period-export").click();
    const dialog = page.getByRole("dialog", { name: "Exportieren" });
    await expect(dialog).toBeVisible();
    const monthSelect = dialog.getByLabel("Monat für Monatsexport und DATEV");
    await expect(monthSelect).toBeVisible();
    await expect(monthSelect).toHaveValue(ymKey(now));
    await expect(monthSelect.locator("option")).toHaveCount(3);
    await expect(dialog.getByText("DATEV-Export", { exact: true })).toBeVisible();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Deterministic data through route interception
// ═════════════════════════════════════════════════════════════════════════════════════════════

const LONG_LAST_NAME = "Beispiel-Langnamenberg-Zusammengesetzt";
const LONG_FIRST_NAME = "Maximiliane-Alexandra";
const FIRST_NAMES = ["Vera", "Jonas", "Lena", "Karim", "Mara", "Tobias", "Ines", "Felix"];
const PEOPLE_COUNT = 30;
/** The browser clock of the matrix and layout checks: September has the longest month label. */
const FIXED_NOW = "2026-09-16T10:00:00";

interface SyntheticPerson {
  id: string;
  first: string;
  last: string;
  number: string;
  fullName: string;
  exitDay: string | null;
}

function monthsBetween(from: string, to: string): Ym[] {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const out: Ym[] = [];
  for (let cur: Ym = { year: fy, month: fm }; cur.year * 12 + cur.month <= ty * 12 + tm;) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

function makePeople(): SyntheticPerson[] {
  return Array.from({ length: PEOPLE_COUNT }, (_, i) => {
    const long = i === 0;
    const first = long ? LONG_FIRST_NAME : FIRST_NAMES[i % FIRST_NAMES.length];
    const last = long ? LONG_LAST_NAME : `Matrix-${pad(i)}`;
    return {
      id: randomUUID(),
      first,
      last,
      number: `E612-${String(1000 + i)}`,
      fullName: `${first} ${last}`,
      exitDay: i === 1 ? "2026-08-31" : null,
    };
  });
}

/**
 * One answer of `GET /reports/period` for `from..to`, shaped like the real one (the row and the
 * envelope are spread from a real answer, so a field the server adds is carried along) with 30
 * people, a long name, an exited person, big figures (KPI overflow) and at-risk vacation rows.
 */
function buildAnswer(template: Json, people: SyntheticPerson[], from: string, to: string): Json {
  const months = monthsBetween(from, to);
  const last = months[months.length - 1];
  const templateRow = ((template.rows as Json[])[0] ?? {}) as Json;
  const rows = people.map((p, i) => {
    let closing = 1000 + i * 37;
    const opening = closing;
    const confirmedAll = i === 3;
    const series = months.map((m, k) => {
      const worked = 9000 + 13 * i + 17 * k;
      const expected = 9600;
      closing += worked - expected;
      return {
        year: m.year,
        month: m.month,
        workedMinutes: worked,
        expectedMinutes: expected,
        balanceMinutes: worked - expected,
        closingBalanceMinutes: closing,
        confirmed: confirmedAll || k < months.length - 1,
        labelled: true,
        sickDays: k === 0 && i % 4 === 0 ? 2 : 0,
      };
    });
    const lastMonth = series[series.length - 1];
    const unconfirmed = series.filter((m) => !m.confirmed).length;
    return {
      ...templateRow,
      employeeId: p.id,
      employeeName: p.fullName,
      employeeNumber: p.number,
      hasRecordedTime: true,
      exitDay: p.exitDay,
      workedMinutes: series.reduce((s, m) => s + m.workedMinutes, 0),
      expectedMinutes: series.reduce((s, m) => s + m.expectedMinutes, 0),
      balanceMinutes: series.reduce((s, m) => s + m.balanceMinutes, 0),
      openingBalanceMinutes: opening,
      closingBalanceMinutes: closing,
      closingConfirmedMinutes: lastMonth.confirmed ? null : closing - lastMonth.balanceMinutes,
      closingOpenMinutes: lastMonth.confirmed ? null : lastMonth.balanceMinutes,
      unconfirmedMonths: unconfirmed,
      monthCount: series.length,
      confirmedMonthCount: series.length - unconfirmed,
      labelled: true,
      sickDays: series.reduce((s, m) => s + m.sickDays, 0),
      sollUnavailableReason: undefined,
      months: series,
    };
  });

  const vacationRows = people.map((p, i) => {
    const placeholder = i === 1;
    const atRisk = !placeholder && i % 5 === 0;
    const none = (v: number | string | null) => (placeholder ? null : v);
    return {
      employeeId: p.id,
      employeeName: p.fullName,
      employeeNumber: p.number,
      year: last.year,
      entitlementId: placeholder ? null : randomUUID(),
      entitlementDays: none(30),
      carriedOverDays: none(atRisk ? 6 : 0),
      carriedOverEffectiveDays: none(atRisk ? 6 : 0),
      carriedOverExpiredDays: none(0),
      exitReductionDays: none(0),
      availableDays: none(atRisk ? 36 : 30),
      takenDays: none(12.5),
      approvedUpcomingDays: none(3),
      pendingDays: none(1),
      remainingDays: none(atRisk ? 19.5 : 13.5),
      atRiskDays: none(atRisk ? 6 : 0),
      carryOverDeadline: atRisk ? `${last.year}-12-31` : null,
      lastWarningSentAt: atRisk && i % 2 === 0 ? `${last.year}-09-01T08:00:00.000Z` : null,
      missingEntitlement: placeholder,
      entitlementWarning: placeholder ? "Kein Urlaubsanspruch hinterlegt." : null,
    };
  });

  return {
    ...template,
    from,
    to,
    months: months.map((m) => ({ year: m.year, month: m.month })),
    kpis: {
      ...((template.kpis as Json | undefined) ?? {}),
      personCount: people.length,
      saldoPersonCount: people.length,
      workedMinutes: 230535,
      expectedMinutes: 245000,
      balanceMinutes: 99999,
      closingBalanceMinutes: -123456,
      closingAsOf: `${ymKey(last)}-28`,
      closingConfirmed: false,
      allMonthsConfirmed: false,
      sickDays: 1234.5,
      vacationYear: last.year,
      vacationAsOf: `${ymKey(last)}-27`,
      vacationTakenDays: 1234.5,
      vacationApprovedDays: 456.5,
      vacationEntitlementDays: 7890,
    },
    rows,
    vacation: {
      year: last.year,
      asOf: `${ymKey(last)}-27`,
      years: [{ year: last.year, asOf: `${ymKey(last)}-27`, rows: vacationRows }],
    },
    absences: [
      { code: "VACATION", unit: "WORKDAYS", personCount: 28, totalDays: 512.5 },
      { code: "SICK", unit: "CALENDAR_DAYS", personCount: 12, totalDays: 77 },
      { code: "SPECIAL", unit: "WORKDAYS", personCount: 4, totalDays: 9 },
      { code: "OVERTIME_COMP", unit: "WORKDAYS", personCount: 3, totalDays: 6.5 },
    ],
  };
}

/** Reads one real answer of the tenant — the shape the synthetic answers are spread from. */
async function realTemplate(request: APIRequestContext, tenant: TestTenant): Promise<Json> {
  const now = ymKey(ymOf(todayInTenantZone()));
  const res = await request.get(`${API_BASE}/api/v1/reports/period?from=${now}&to=${now}`, {
    headers: authHeaders(tenant.adminToken),
  });
  expect(res.ok(), `read a real period answer (${res.status()})`).toBe(true);
  const body = (await res.json()) as Json;
  expect((body.rows as unknown[]).length, "the real answer lists the admin").toBeGreaterThan(0);
  return body;
}

/**
 * Fulfils (never continues) the two reads of the matrix: the period answer, built from the query,
 * and the drill-down's day list. Any other method on an intercepted path is answered 405.
 */
async function interceptPeriodData(page: Page, template: Json, people: SyntheticPerson[]) {
  await page.route(
    (url) => url.pathname === "/api/v1/reports/period",
    (route: Route) => {
      if (route.request().method() !== "GET") {
        return route.fulfill({ status: 405, contentType: "application/json", body: "{}" });
      }
      const u = new URL(route.request().url());
      const from = u.searchParams.get("from") ?? "2026-09";
      const to = u.searchParams.get("to") ?? from;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildAnswer(template, people, from, to)),
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/time-entries",
    (route: Route) => {
      if (route.request().method() !== "GET") {
        return route.fulfill({ status: 405, contentType: "application/json", body: "{}" });
      }
      const day = (d: number) => `2026-09-${pad(d)}`;
      const entry = (d: number, start: string, end: string, extra: Json = {}) => ({
        id: randomUUID(),
        date: day(d),
        startTime: zonedInstant(day(d), start, TENANT_TZ).toISOString(),
        endTime: zonedInstant(day(d), end, TENANT_TZ).toISOString(),
        breakMinutes: 30,
        workingMinutes: 450,
        isInvalid: false,
        activityKind: "UNSPECIFIED",
        ...extra,
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          entry(1, "08:00", "16:00"),
          entry(2, "08:00", "12:00", { workingMinutes: 240, breakMinutes: 0 }),
          entry(2, "13:00", "17:00", { workingMinutes: 240, breakMinutes: 0 }),
          entry(3, "08:00", "16:00", {
            isInvalid: true,
            invalidReason: "Urlaubsstornierung ausstehend",
          }),
        ]),
      });
    },
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// matrix: 390/360 px × light/dark
// ═════════════════════════════════════════════════════════════════════════════════════════════

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;
const MODES: readonly Mode[] = ["light", "dark"];
const TOLERANCE_PX = 0.5;
const MATRIX_PERIOD = "2026-09";

interface CellResult {
  cell: string;
  innerWidth: number;
  scrollWidth: number;
  overflowing: number;
  clipped: number;
  axeViolations: number | null;
  listRows: number;
}

/** Asserts the mode under test is on screen, then measures the whole page and the clipped boxes. */
async function checkCell(
  page: Page,
  pageName: string,
  width: number,
  mode: Mode,
  opts: { axe: boolean; listSelector: string | null },
): Promise<CellResult> {
  await settle(page);
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

  const cell = `${pageName} ${width}px ${mode}`;
  const overflow = await measurePageOverflow(page, TOLERANCE_PX);
  expect(overflow.overflowing, `${cell}: ${JSON.stringify(overflow.beyondViewport)}`).toEqual([]);
  expect(overflow.scrollWidth, `${cell}: the document scrolls sideways`).toBeLessThanOrEqual(
    overflow.innerWidth + TOLERANCE_PX,
  );

  // Content may only leave its box where the box scrolls: a hidden/clipped box whose content is
  // wider than the box is a defect (the whole-page probe above forgives a clipping ancestor).
  const cutOff = await page.evaluate(() =>
    [...document.body.querySelectorAll("*")]
      .filter((e) => {
        const ox = getComputedStyle(e).overflowX;
        // `.sr-only` is the visually-hidden recipe (a 1 px clipped box holding text for screen
        // readers) - clipped by design, not content a user is denied.
        if (e.closest(".sr-only")) return false;
        return (ox === "hidden" || ox === "clip") && e.scrollWidth > e.clientWidth + 1;
      })
      .slice(0, 8)
      .map((e) => {
        const name = (x: Element) =>
          `${x.tagName.toLowerCase()}${[...x.classList].map((c) => `.${c}`).join("")}`;
        // Name the offenders inside the box: a bare "410 > 356" cost a diagnosis round trip.
        const edge = e.getBoundingClientRect().right;
        const beyond = [...e.querySelectorAll("*")]
          .filter((d) => {
            if (d.getBoundingClientRect().right <= edge + 1) return false;
            // A descendant inside a nested scroller/clipper that ends within the box is not what
            // widens this box.
            for (let a = d.parentElement; a && a !== e; a = a.parentElement) {
              if (
                getComputedStyle(a).overflowX !== "visible" &&
                a.getBoundingClientRect().right <= edge + 1
              ) {
                return false;
              }
            }
            return true;
          })
          .slice(0, 4)
          .map((d) => `${name(d)} (right ${Math.round(d.getBoundingClientRect().right)})`);
        return `${name(e)} (content ${e.scrollWidth} > box ${e.clientWidth}; box right ${Math.round(edge)}; beyond: ${beyond.join("; ")})`;
      }),
  );
  expect(cutOff, `${cell}: content cut off by a non-scrolling box`).toEqual([]);

  // Anti-vacuity of the list: the rows the axe run is about are really there.
  let listRows = 0;
  if (opts.listSelector) {
    listRows = await page.locator(opts.listSelector).count();
    expect(listRows, `${cell}: the mobile list renders rows`).toBeGreaterThan(0);
  }
  let axeViolations: number | null = null;
  if (opts.axe) {
    const results = await new AxeBuilder({ page }).withRules(["nested-interactive"]).analyze();
    axeViolations = results.violations.length;
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
      `${cell}: axe nested-interactive`,
    ).toEqual([]);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[reports-period cell] ${cell}: innerWidth=${overflow.innerWidth} scrollWidth=${overflow.scrollWidth} overflowing=${overflow.overflowing.length} clipped=${cutOff.length} axe=${axeViolations ?? "-"} listRows=${listRows}`,
  );
  return {
    cell,
    innerWidth: overflow.innerWidth,
    scrollWidth: overflow.scrollWidth,
    overflowing: overflow.overflowing.length,
    clipped: cutOff.length,
    axeViolations,
    listRows,
  };
}

test.describe("Issue #612 — Sichtmatrix 390/360 px, hell/dunkel", () => {
  for (const viewport of VIEWPORTS) {
    for (const mode of MODES) {
      test(`Zeiten, Urlaub und Personenansicht bei ${viewport.width} px, ${
        mode === "light" ? "hell" : "dunkel"
      }`, async ({ page, request, tenant }) => {
        const template = await realTemplate(request, tenant);
        const people = makePeople();
        await signInAdmin(page, request, tenant, { mode });
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.clock.install({ time: new Date(FIXED_NOW) });
        await interceptPeriodData(page, template, people);
        const results: CellResult[] = [];
        const base = `${tenant.baseUrl}/reports?from=${MATRIX_PERIOD}&to=${MATRIX_PERIOD}`;

        // Positive control of the axe rule: a button wrapping a link IS a nested-interactive
        // violation. Without this the clean runs below could not tell "no violation" from "the rule
        // sees nothing on this page".
        await page.goto(`${base}&tab=zeiten`);
        await expect(page.locator(".period-list li").first()).toBeVisible();
        await page.evaluate(() => {
          const host = document.createElement("div");
          host.id = "axe-control";
          host.innerHTML = '<button type="button"><a href="#x">nested control</a></button>';
          document.body.appendChild(host);
        });
        const control = await new AxeBuilder({ page }).withRules(["nested-interactive"]).analyze();
        expect(control.violations.length, "axe sees a deliberate nested control").toBeGreaterThan(
          0,
        );
        await page.evaluate(() => document.getElementById("axe-control")?.remove());

        // 1. tab „Zeiten & Konten“ — the ApprovalRow list
        await waitKpisSettled(page);
        await expect(page.getByRole("tab", { name: "Zeiten & Konten" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(page.locator(".period-list li")).toHaveCount(25);
        await expect(page.getByTestId("reports-period-label")).toContainText("September 2026");
        results.push(
          await checkCell(page, "zeiten", viewport.width, mode, {
            axe: true,
            listSelector: ".period-list .approval-row--stretched",
          }),
        );

        // 2. tab „Urlaub & Abwesenheit“ — the vacation list incl. the at-risk row with its notice button
        await page.goto(`${base}&tab=urlaub`);
        await waitKpisSettled(page);
        await expect(page.getByText("Urlaubsübersicht", { exact: true }).first()).toBeVisible();
        await expect(page.getByRole("button", { name: /Hinweis senden/ }).first()).toBeVisible();
        results.push(
          await checkCell(page, "urlaub", viewport.width, mode, {
            axe: true,
            listSelector: ".approval-row--stretched",
          }),
        );

        // 3. the drill-down of the person with the long name
        await page.goto(`${base}&tab=zeiten&person=${people[0].id}`);
        const dialog = page.getByRole("dialog", { name: people[0].fullName });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator(".drill-day-list li").first()).toBeVisible();
        results.push(
          await checkCell(page, "drilldown", viewport.width, mode, {
            axe: false,
            listSelector: ".drill-day-list li",
          }),
        );

        expect(results).toHaveLength(3);
      });
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// layout checks
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SKINS: readonly Skin[] = ["editorial", "modern"];

/** Opens /reports on the synthetic answer with the given UI preferences; asserts they are on screen. */
async function openSynthetic(
  page: Page,
  request: APIRequestContext,
  tenant: TestTenant,
  prefs: Required<Pick<UiPrefs, "skin" | "mode">> & Pick<UiPrefs, "density">,
) {
  const template = await realTemplate(request, tenant);
  const people = makePeople();
  await signInAdmin(page, request, tenant, prefs);
  await page.clock.install({ time: new Date(FIXED_NOW) });
  await interceptPeriodData(page, template, people);
  await page.goto(`${tenant.baseUrl}/reports?from=${MATRIX_PERIOD}&to=${MATRIX_PERIOD}&tab=zeiten`);
  await waitKpisSettled(page);
  await expect(page.locator("html")).toHaveAttribute("data-mode", prefs.mode);
  if (prefs.skin === "modern") {
    await expect(page.locator("html")).toHaveAttribute("data-skin", "modern");
  } else {
    await expect(page.locator("html")).not.toHaveAttribute("data-skin", /.*/);
  }
  if (prefs.density) {
    await expect(page.locator("html")).toHaveAttribute("data-density", prefs.density);
  }
  return people;
}

test.describe("Issue #612 — Layoutprüfungen", () => {
  for (const skin of SKINS) {
    for (const mode of MODES) {
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        test(`Monatsauswahl nicht beschnitten — ${skin}, ${mode}, ${viewport.width} px`, async ({
          page,
          request,
          tenant,
        }) => {
          await page.setViewportSize(viewport);
          await openSynthetic(page, request, tenant, { skin, mode });
          await page.getByTestId("reports-period-label").click();
          const picker = page.getByTestId("reports-period-picker");
          await expect(picker).toBeVisible();
          await settle(page);

          const hit = await picker.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const insetPx = 6;
            const points = {
              centre: [r.left + r.width / 2, r.top + r.height / 2],
              topLeft: [r.left + insetPx, r.top + insetPx],
              topRight: [r.right - insetPx, r.top + insetPx],
              bottomLeft: [r.left + insetPx, r.bottom - insetPx],
              bottomRight: [r.right - insetPx, r.bottom - insetPx],
            } as const;
            const out: Record<string, string> = {};
            for (const [name, [x, y]] of Object.entries(points)) {
              const top = document.elementFromPoint(x, y);
              out[name] = top?.closest(".month-picker")
                ? "inside"
                : top
                  ? `covered by ${top.tagName.toLowerCase()}.${[...top.classList].join(".")}`
                  : "outside the viewport";
            }
            return {
              out,
              rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
              viewport: { w: window.innerWidth, h: window.innerHeight },
            };
          });
          // eslint-disable-next-line no-console
          console.log(
            `[reports-period picker] ${skin}/${mode}/${viewport.width}: ${JSON.stringify(hit)}`,
          );
          expect(hit.out, `picker hit test (${JSON.stringify(hit.rect)})`).toEqual({
            centre: "inside",
            topLeft: "inside",
            topRight: "inside",
            bottomLeft: "inside",
            bottomRight: "inside",
          });

          // Control: the hit test tells inside from outside - the top-left corner of the page is
          // not the picker.
          const outside = await page.evaluate(
            () => document.elementFromPoint(2, 2)?.closest(".month-picker") ?? null,
          );
          expect(outside, "a point outside the picker does not resolve into it").toBeNull();
        });
      }
    }
  }

  for (const width of [961, 1280, 1440]) {
    test(`Kennzahlwerte laufen nicht aus der Kachel — ${width} px`, async ({
      page,
      request,
      tenant,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openSynthetic(page, request, tenant, { skin: "editorial", mode: "light" });
      await settle(page);
      const tiles = await page.locator("article.kpi").evaluateAll((els) =>
        els.map((el) => {
          const value = el.querySelector(".kpi-value") as HTMLElement | null;
          const tile = el.getBoundingClientRect();
          const v = value?.getBoundingClientRect();
          return {
            label: el.querySelector(".kpi-label")?.textContent?.trim() ?? "",
            text: value?.textContent?.replace(/\s+/g, " ").trim() ?? "",
            scrollWidth: value?.scrollWidth ?? -1,
            clientWidth: value?.clientWidth ?? -1,
            valueRight: v?.right ?? -1,
            tileRight: tile.right,
            fontSize: value ? parseFloat(getComputedStyle(value).fontSize) : 0,
          };
        }),
      );
      expect(tiles, "eight KPI tiles").toHaveLength(8);
      // eslint-disable-next-line no-console
      console.log(`[reports-period kpi] ${width}px: ${JSON.stringify(tiles)}`);
      for (const t of tiles) {
        expect(
          t.scrollWidth,
          `${width}px "${t.label}" (${t.text}): value wider than its box`,
        ).toBeLessThanOrEqual(t.clientWidth);
        expect(
          t.valueRight,
          `${width}px "${t.label}": value ends right of its tile`,
        ).toBeLessThanOrEqual(t.tileRight + TOLERANCE_PX);
      }
      // Control: the probe sees an overflow when there is one (an oversized, unwrappable value).
      const controlOverflows = await page
        .locator("article.kpi .kpi-value")
        .first()
        .evaluate((el) => {
          (el as HTMLElement).style.fontSize = "64px";
          (el as HTMLElement).style.whiteSpace = "nowrap";
          return el.scrollWidth > el.clientWidth;
        });
      expect(controlOverflows, "the overflow probe detects a deliberately oversized value").toBe(
        true,
      );
    });
  }

  for (const skin of SKINS) {
    for (const density of ["comfortable", "compact"] as const) {
      test(`Tabellenkopf bleibt unter der Zeitraumleiste — ${skin}, ${density}`, async ({
        page,
        request,
        tenant,
      }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await openSynthetic(page, request, tenant, { skin, mode: "light", density });
        await expect(page.locator("tr.period-row")).toHaveCount(25);
        await settle(page);

        // Scroll until the table header would have left the screen without the sticky rule.
        await page.evaluate(() => {
          const head = document.querySelector(".period-table thead tr") as HTMLElement;
          window.scrollTo(0, head.getBoundingClientRect().top + window.scrollY + 500);
        });
        await expect
          .poll(() => page.evaluate(() => Math.round(window.scrollY)), { message: "page scrolled" })
          .toBeGreaterThan(300);

        const geo = await page.evaluate(() => {
          const bar = document.querySelector(".period-sticky") as HTMLElement;
          const headRow = document.querySelector(".period-table thead tr") as HTMLElement;
          const firstTh = headRow.querySelector("th") as HTMLElement;
          const b = bar.getBoundingClientRect();
          const h = headRow.getBoundingClientRect();
          const t = firstTh.getBoundingClientRect();
          const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
          return {
            scrollY: window.scrollY,
            barTop: b.top,
            barBottom: b.bottom,
            headTop: h.top,
            headBottom: h.bottom,
            headHit: hit?.closest("thead") ? "thead" : hit ? hit.className || hit.tagName : "none",
          };
        });
        // eslint-disable-next-line no-console
        console.log(`[reports-period sticky] ${skin}/${density}: ${JSON.stringify(geo)}`);
        // The bar itself stuck below the topbar (not scrolled away) ...
        expect(geo.barTop, "the period bar is stuck near the top").toBeLessThan(120);
        // ... and the header is stuck right under it: never above its bottom edge (hidden behind
        // it), never far below it (not sticky at all).
        expect(geo.headTop, "the header is not hidden behind the bar").toBeGreaterThanOrEqual(
          geo.barBottom - TOLERANCE_PX,
        );
        expect(geo.headTop, "the header sticks right below the bar").toBeLessThanOrEqual(
          geo.barBottom + 3,
        );
        expect(geo.headHit, "the header cell is what the pointer hits").toBe("thead");
      });
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// salon switch (Issue #714): the Stammsalon view is where a reader looks
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SALON_SWITCH_VIEWPORTS = [{ width: 1280, height: 800 }, ...VIEWPORTS] as const;
const STAMMSALON_HINT = "Personensaldo nach Stammsalon, nicht nach Salon aufgeteilt";

/**
 * Scrolls the element to the middle of the screen, then asserts it is in the viewport and that
 * the pointer at its centre hits the element itself (not a sticky bar or an overlay on top of it).
 */
async function expectSeenInViewport(locator: Locator, what: string) {
  await expect(locator, `${what} exists`).toHaveCount(1);
  await locator.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  await expect(locator, `${what} is in the viewport`).toBeInViewport({ ratio: 0.9 });
  const hit = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (el === top || el.contains(top));
  });
  expect(hit, `${what} is not covered by another element`).toBe(true);
}

test.describe("Issue #714 — Salonwechsel: Stammsalon-Sicht im Blick", () => {
  for (const viewport of SALON_SWITCH_VIEWPORTS) {
    for (const mode of MODES) {
      test(`Salonwechsel bei ${viewport.width} px, ${mode === "light" ? "hell" : "dunkel"}`, async ({
        page,
        request,
        tenant,
      }, testInfo) => {
        // ── Seed through the API: two salons, one person homed in each, both worked in the second.
        const win = await request.put(`${API_BASE}/api/v1/settings/work`, {
          headers: authHeaders(tenant.adminToken),
          data: { retroEntryWindowDays: 90 },
        });
        expect(win.ok(), `raise the retro window (${win.status()})`).toBe(true);
        const salonsRes = await request.get(`${API_BASE}/api/v1/salons`, {
          headers: authHeaders(tenant.adminToken),
        });
        expect(salonsRes.ok()).toBe(true);
        const first = ((await salonsRes.json()) as { salons: Array<{ id: string }> }).salons[0];
        const created = await request.post(`${API_BASE}/api/v1/salons`, {
          headers: authHeaders(tenant.adminToken),
          data: {
            name: "Zweitsalon Stammsalon",
            federalState: "HESSEN",
            openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
              day,
              open: "09:00",
              close: "18:00",
              ...(day === 6 ? { closed: true } : {}),
            })),
          },
        });
        expect(created.status(), `create the second salon (${await created.text()})`).toBe(201);
        const second = (await created.json()) as { id: string };

        const now = ymOf(todayInTenantZone());
        const prev = addMonths(now, -1);
        const hire = `${ymKey(addMonths(now, -3))}-01`;
        const sina = await createPerson(
          request,
          tenant,
          "sina",
          "Sina",
          "Stamm-Zwei",
          hire,
          second.id,
        );
        const ali = await createPerson(
          request,
          tenant,
          "ali",
          "Ali",
          "Aushilfe-Eins",
          hire,
          first.id,
        );
        const day = weekdayMidMonth(prev);
        await recordOwnEntry(request, sina, day, "08:00", "16:00", 30, second.id);
        await recordOwnEntry(request, ali, day, "09:00", "13:00", 0, second.id);

        // ── Open the page on the second salon (never mocked: the answer is read).
        await signInAdmin(page, request, tenant, { mode });
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: "reduce" });
        const loaded = periodResponse(page, prev, prev, second.id);
        await page.goto(
          `${tenant.baseUrl}/reports?from=${ymKey(prev)}&to=${ymKey(prev)}&salonId=${second.id}&tab=zeiten`,
        );
        const answer = await answerOf(await loaded);
        expect(answer.personBasis, "the answer is the Stammsalon view").toBe(
          "HOME_SALON_AT_PERIOD_END",
        );
        expect(answer.rows.map((r) => r.employeeId)).toContain(sina.id);
        expect(answer.rows.map((r) => r.employeeId)).not.toContain(ali.id);
        expect((answer.helpers ?? []).map((h) => h.employeeId)).toContain(ali.id);
        const salonMinutes = answer.kpis.salonWorkedMinutes;
        expect(typeof salonMinutes, "the answer carries the salon hours").toBe("number");
        await waitKpisSettled(page);
        await expect(page.getByTestId("salon-worked-section")).toHaveCount(1);
        await settle(page);

        // ── Each element is in the viewport once scrolled to.
        const tile = page.locator("article.kpi", {
          has: page.locator(".kpi-label", { hasText: /^Im Salon gearbeitet$/ }),
        });
        await expectSeenInViewport(tile, "the KPI tile 'Im Salon gearbeitet'");
        await expect(tile.locator(".kpi-value")).toContainText(fmtHours(salonMinutes as number));

        const hint = page.getByTestId("period-kpis-salon-note");
        await expectSeenInViewport(hint, "the Stammsalon hint callout");
        await expect(hint).toContainText(STAMMSALON_HINT);

        const row =
          viewport.width >= 768
            ? page.locator("tr.period-row", { hasText: sina.fullName })
            : page.locator(".period-list li", { hasText: sina.fullName });
        await expectSeenInViewport(row, `the row of ${sina.fullName}`);
        await expect(
          page.locator("tr.period-row, .period-list li", { hasText: ali.fullName }),
          "the helper is not a table row",
        ).toHaveCount(0);

        const sectionTitle = page.locator(".salon-worked .card-title", {
          hasText: /^Im Salon gearbeitet$/,
        });
        await expectSeenInViewport(sectionTitle, "the section heading 'Im Salon gearbeitet'");
        await expectSeenInViewport(
          page.getByRole("heading", { name: "Aushilfen aus anderen Salons" }),
          "the sub-heading 'Aushilfen aus anderen Salons'",
        );
        await expectSeenInViewport(
          page.getByTestId("salon-worked-helpers").getByText(ali.fullName),
          `the helper name ${ali.fullName}`,
        );

        const overflow = await measurePageOverflow(page, TOLERANCE_PX);
        expect(overflow.overflowing, "no element overflows the page").toEqual([]);
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

        // Written into the test's output folder (kept after a green run) and attached as well.
        const shot = testInfo.outputPath(`salonwechsel-${viewport.width}-${mode}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        await testInfo.attach(`salonwechsel-${viewport.width}-${mode}`, {
          path: shot,
          contentType: "image/png",
        });

        // ── Control (a): an element placed off screen is NOT in the viewport.
        await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.id = "offscreen-probe";
          probe.textContent = "probe";
          probe.style.cssText = "position:fixed;left:-10000px;top:0;width:100px;height:20px";
          document.body.appendChild(probe);
        });
        await expect(
          page.locator("#offscreen-probe"),
          "control: the off-screen probe is not in the viewport",
        ).not.toBeInViewport();
        await page.evaluate(() => document.getElementById("offscreen-probe")?.remove());

        // ── Control (b): under "Alle Salons" the salon-only elements do not exist.
        const unfiltered = page.waitForResponse((res) => {
          if (!isPeriodUrl(res.url())) return false;
          const u = new URL(res.url());
          return u.searchParams.get("from") === ymKey(prev) && !u.searchParams.has("salonId");
        });
        await page.locator("select.salon-switcher-select").selectOption("ALL");
        await unfiltered;
        await waitKpisSettled(page);
        await expect(page.getByTestId("period-kpis"), "the KPI card is still shown").toBeVisible();
        await expect(tile, "control: no salon tile under 'Alle Salons'").toHaveCount(0);
        await expect(page.getByTestId("salon-worked-section")).toHaveCount(0);
        await expect(page.getByTestId("period-kpis-salon-note")).toHaveCount(0);
      });
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Issue #726 — the search field of a filter bar keeps its width
// ═════════════════════════════════════════════════════════════════════════════════════════════

test.describe("Issue #726 — Suchfeld der Filterleiste", () => {
  const MIN_SEARCH_PX = 180;
  const TABS = ["zeiten", "urlaub"] as const;

  for (const tab of TABS) {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 360, height: 800 },
      { width: 1280, height: 800 },
    ]) {
      test(`Suchfeld ${tab} — ${viewport.width} px`, async ({ page, request, tenant }) => {
        await page.setViewportSize(viewport);
        await openSynthetic(page, request, tenant, { skin: "editorial", mode: "light" });
        if (tab !== "zeiten") {
          await page.goto(
            `${tenant.baseUrl}/reports?from=${MATRIX_PERIOD}&to=${MATRIX_PERIOD}&tab=${tab}`,
          );
        }
        const search = page.locator(".filter-bar .filter-search");
        await expect(search, "the filter bar offers its search field").toBeVisible();

        const geo = await search.evaluate((el) => {
          const bar = el.closest(".filter-bar") as HTMLElement;
          const r = el.getBoundingClientRect();
          const b = bar.getBoundingClientRect();
          const siblings = [...bar.children]
            .filter((c) => c !== el)
            .map((c) => c.getBoundingClientRect())
            .filter((c) => c.width > 0);
          return {
            width: r.width,
            barWidth: b.width,
            sharesRow: siblings.some((s) => s.top < r.bottom - 1 && s.bottom > r.top + 1),
          };
        });

        if (viewport.width <= 480) {
          expect(geo.width, "search width").toBeGreaterThanOrEqual(MIN_SEARCH_PX);
          expect(geo.sharesRow, "the search field has its own row").toBe(false);
          expect(geo.width, "full row width").toBeGreaterThanOrEqual(geo.barWidth - 1);
        } else {
          // Desktop is unchanged: a flexible field between 180 and 320 px next to its siblings.
          expect(geo.width).toBeGreaterThanOrEqual(MIN_SEARCH_PX);
          expect(geo.width).toBeLessThanOrEqual(320 + 0.5);
          expect(geo.sharesRow, "desktop: count/select stay on the search row").toBe(true);
        }

        if (viewport.width <= 480) {
          const overflow = await measurePageOverflow(page, TOLERANCE_PX);
          expect(overflow.overflowing).toEqual([]);
          expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + TOLERANCE_PX);
        }

        // Control: with the defect re-created (min-width 0, no growth) the same probe reads
        // a stub, so the assertions above can fail.
        await page.addStyleTag({
          content: ".filter-bar .filter-search{min-width:0 !important;flex:0 1 0 !important}",
        });
        const broken = await search.evaluate((el) => el.getBoundingClientRect().width);
        expect(broken, "control: the probe sees a shrunken field").toBeLessThan(MIN_SEARCH_PX);
      });
    }
  }
});
