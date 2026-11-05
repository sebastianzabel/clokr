/**
 * Issue #92 — a trip between two salons, recorded in a real browser.
 *
 * The component, API and kernel tests prove each piece; this spec proves the promise only a browser
 * can show, on the real test stack (a tenant with two active salons):
 *   a. on a day with 08:00-12:00 in the first salon and 12:30-16:00 in the second (recorded through
 *      the API), a worker opens "Weiteren Eintrag an diesem Tag", switches on "Fahrzeit zwischen
 *      Salons", chooses Von = first salon, Nach = second salon, 12:00-12:30 and saves: the list of
 *      the day shows three rows, one of them with the badge "Fahrzeit" and the route
 *      "{first} → {second}";
 *   b. a second trip 07:00-07:30 from the second to the first salon - before any entry, so a way
 *      from home - is refused with HTTP 409 and the server's German text; the dialog stays open and
 *      the list still holds three rows;
 *   c. a tenant with a single salon is offered no switch at all;
 *   d. (Issue #660) on the same kind of day the day-check panel offers the unclear gap between the two
 *      salons as one button "Fahrzeit 12:00–12:30 von {first} nach {second} erfassen" (the offer is READ
 *      from the real GET /day-breaks/checks answer, never mocked); one click records the trip (HTTP
 *      201), the button is gone and the list holds a row with the badge "Fahrzeit" and the route;
 *   e. (Issue #660) an offer made stale behind the page's back (the second-salon entry is moved to
 *      13:00, so the gap widens) is NOT posted: the page re-loads the day check first, shows the
 *      toast "Das Angebot ist nicht mehr aktuell ...", sends no POST /time-entries, reloads (the
 *      button now names 12:00-13:00) and no trip exists; the single-salon test (c.) additionally
 *      asserts that no offer button is rendered.
 *
 * Auth: same model as multi-entry-day.spec.ts (throwaway tenant, API login, localStorage hydrated
 * with addInitScript). The day is computed from the current day (a weekday inside the 10-day retro
 * window, in the tenant's time zone, which the browser context shares), so there is no fixed date
 * and no fixed sleep: every wait is on an observable condition. Salon names are synthetic.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import { zonedInstant } from "../helpers/tenant-zone";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const TENANT_TZ = "Europe/Berlin";
const SECOND_SALON_NAME = "Zweitsalon Testheim";

// The tenant is provisioned in Europe/Berlin; the browser must read and type times in that zone.
test.use({ timezoneId: TENANT_TZ });

interface SalonRow {
  id: string;
  name: string;
}

/** Today's calendar day in the tenant's zone. */
function todayInTenantZone(): Date {
  const [y, m, d] = new Date()
    .toLocaleDateString("sv-SE", { timeZone: TENANT_TZ })
    .split("-")
    .map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * The most recent weekday among the last nine days (the retro window is ten); `skip` steps over
 * that many weekdays first, so two tests can use two distinct days.
 */
function recentWeekday(skip = 0): string {
  const today = todayInTenantZone();
  let remaining = skip;
  for (let back = 1; back <= 9; back += 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - back);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (remaining === 0) return d.toISOString().slice(0, 10);
    remaining -= 1;
  }
  throw new Error("no weekday in the last nine days");
}

async function signIn(page: Page, request: APIRequestContext, tenant: TestTenant) {
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email: `admin@${tenant.tenantId}.test`, password: PASSWORD },
  });
  expect(res.ok(), `login as the tenant admin (${res.status()})`).toBe(true);
  const auth = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown>;
  };
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

function authHeaders(tenant: TestTenant) {
  return { "content-type": "application/json", Authorization: `Bearer ${tenant.adminToken}` };
}

async function listSalons(request: APIRequestContext, tenant: TestTenant): Promise<SalonRow[]> {
  const res = await request.get(`${API_BASE}/api/v1/salons`, { headers: authHeaders(tenant) });
  expect(res.ok(), `list salons (${res.status()})`).toBe(true);
  return ((await res.json()) as { salons: SalonRow[] }).salons;
}

async function createSecondSalon(
  request: APIRequestContext,
  tenant: TestTenant,
): Promise<SalonRow> {
  const res = await request.post(`${API_BASE}/api/v1/salons`, {
    headers: authHeaders(tenant),
    data: {
      name: SECOND_SALON_NAME,
      federalState: "HESSEN",
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        day,
        open: "09:00",
        close: "18:00",
        ...(day === 6 ? { closed: true } : {}),
      })),
    },
  });
  expect(res.status(), `create the second salon (${await res.text()})`).toBe(201);
  return (await res.json()) as SalonRow;
}

/** A closed entry recorded straight through the API in an explicit salon (setup only). */
async function recordEntryViaApi(
  request: APIRequestContext,
  tenant: TestTenant,
  day: string,
  start: string,
  end: string,
  salonId?: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/api/v1/time-entries`, {
    headers: authHeaders(tenant),
    data: {
      date: day,
      startTime: zonedInstant(day, start, TENANT_TZ).toISOString(),
      endTime: zonedInstant(day, end, TENANT_TZ).toISOString(),
      breakMinutes: 0,
      ...(salonId ? { salonId } : {}),
    },
  });
  expect(res.status(), `record an entry on ${day} (${await res.text()})`).toBe(201);
  return ((await res.json()) as { entry: { id: string } }).entry.id;
}

/** The POST of a manual entry; resolves with its HTTP response. */
function entryPost(page: Page) {
  return page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/time-entries") &&
      !res.url().includes("/clock") &&
      res.request().method() === "POST",
  );
}

/** The GET of the day checks the time-entry page issues; resolves with its HTTP response. */
function checksGet(page: Page) {
  return page.waitForResponse(
    (res) => res.url().includes("/api/v1/day-breaks/checks") && res.request().method() === "GET",
  );
}

interface ServedOffer {
  startTime: string;
  endTime: string;
  departureSalonId: string;
  arrivalSalonId: string;
  departureSalonName: string;
  arrivalSalonName: string;
}

/** The travel offers the server served for one day of a checks answer (READ, never mocked). */
async function offersOfDay(
  res: Awaited<ReturnType<typeof checksGet>>,
  day: string,
): Promise<ServedOffer[]> {
  const body = (await res.json()) as { days: { date: string; travelOffers?: ServedOffer[] }[] };
  return body.days.find((d) => d.date === day)?.travelOffers ?? [];
}

test.describe("a trip between two salons (Issue #92)", () => {
  test("records a trip in the form, lists it with badge and route, and refuses a trip from home", async ({
    page,
    request,
    tenant,
  }) => {
    const day = recentWeekday();
    const second = await createSecondSalon(request, tenant);
    const salons = await listSalons(request, tenant);
    expect(salons).toHaveLength(2);
    const first = salons.find((s) => s.id !== second.id)!;
    await recordEntryViaApi(request, tenant, day, "08:00", "12:00", first.id);
    await recordEntryViaApi(request, tenant, day, "12:30", "16:00", second.id);

    await signIn(page, request, tenant);
    await page.goto(`/time-entries?date=${day}`);
    await expect(page.getByTestId("time-entries-page")).toBeVisible();
    await expect(page.getByTestId(`calendar-cell-${day}`)).toBeVisible();
    await expect(page.locator("select.salon-switcher-select")).toBeVisible();

    // The day holds two entries: its cell switches to the list focused on the day.
    const cell = page.getByTestId(`calendar-cell-${day}`);
    await expect(cell).toHaveAttribute("title", "2 Einträge");
    await cell.click();
    await expect(page.getByTestId("time-entries-list")).toBeVisible();
    await expect(page.locator("tr[data-testid^='time-entry-row-']")).toHaveCount(2);

    // a. "Weiteren Eintrag an diesem Tag" -> switch on -> Von / Nach -> 12:00-12:30 -> save.
    await page.getByTestId("time-entries-add-additional").click();
    const modal = page.getByTestId("time-entry-modal");
    await expect(modal).toBeVisible();
    // Without the switch the form is the ordinary one: Salon field, break editor.
    await expect(page.getByTestId("time-entry-modal-salon")).toBeVisible();
    await expect(page.getByTestId("break-slots-editor")).toBeVisible();
    await page.getByTestId("time-entry-modal-travel-switch").check();
    await expect(page.getByTestId("time-entry-modal-salon")).toHaveCount(0);
    await expect(page.getByTestId("break-slots-editor")).toHaveCount(0);
    await expect(page.getByTestId("time-entry-modal-travel-hint")).toContainText(
      "Der Weg von oder nach Hause ist keine Arbeitszeit.",
    );
    await page.getByTestId("time-entry-modal-travel-from").selectOption({ label: first.name });
    await page.getByTestId("time-entry-modal-travel-to").selectOption({ label: second.name });
    await page.getByTestId("time-entry-modal-start").fill("12:00");
    await page.getByTestId("time-entry-modal-end").fill("12:30");
    let posted = entryPost(page);
    await page.getByTestId("time-entry-modal-save").click();
    const created = await posted;
    expect(created.status(), await created.text()).toBe(201);
    await expect(modal).toBeHidden();

    // The list of the day: three rows, one with the badge and the route.
    await expect(page.locator("tr[data-testid^='time-entry-row-']")).toHaveCount(3);
    const badges = page.locator("[data-testid$='-travel-badge']");
    await expect(badges).toHaveCount(1);
    await expect(badges.first()).toHaveText("Fahrzeit");
    await expect(page.locator("[data-testid$='-travel-route']")).toHaveText(
      `${first.name} → ${second.name}`,
    );

    // b. A trip from home (before any entry of the day) is refused in German; nothing is written.
    await page.getByTestId("time-entries-add-additional").click();
    await expect(modal).toBeVisible();
    await page.getByTestId("time-entry-modal-travel-switch").check();
    await page.getByTestId("time-entry-modal-travel-from").selectOption({ label: second.name });
    await page.getByTestId("time-entry-modal-travel-to").selectOption({ label: first.name });
    await page.getByTestId("time-entry-modal-start").fill("07:00");
    await page.getByTestId("time-entry-modal-end").fill("07:30");
    posted = entryPost(page);
    await page.getByTestId("time-entry-modal-save").click();
    const refused = await posted;
    expect(refused.status()).toBe(409);
    await expect(page.getByTestId("time-entry-modal-error")).toContainText(
      "Der Weg von zu Hause oder nach Hause ist keine Arbeitszeit.",
    );
    await expect(modal).toBeVisible();
    await page.getByTestId("time-entry-modal-cancel").click();
    await expect(modal).toBeHidden();
    await expect(page.locator("tr[data-testid^='time-entry-row-']")).toHaveCount(3);
  });

  test("takes the gap between two salons over as a trip with one click (Issue #660)", async ({
    page,
    request,
    tenant,
  }) => {
    const day = recentWeekday(1);
    const second = await createSecondSalon(request, tenant);
    const salons = await listSalons(request, tenant);
    expect(salons).toHaveLength(2);
    const first = salons.find((s) => s.id !== second.id)!;
    await recordEntryViaApi(request, tenant, day, "08:00", "12:00", first.id);
    await recordEntryViaApi(request, tenant, day, "12:30", "16:00", second.id);

    await signIn(page, request, tenant);
    const checks = checksGet(page);
    await page.goto(`/time-entries?date=${day}`);
    await expect(page.getByTestId("time-entries-page")).toBeVisible();

    // The offer is READ from the real answer: exactly the 12:00-12:30 gap, first -> second.
    const offers = await offersOfDay(await checks, day);
    expect(offers, "the server served one offer for the day").toHaveLength(1);
    expect(offers[0].departureSalonId).toBe(first.id);
    expect(offers[0].arrivalSalonId).toBe(second.id);

    const button = page.getByTestId("day-break-travel-offer");
    await expect(button).toHaveCount(1);
    await expect(button).toBeVisible();
    await expect(button).toHaveText(
      `Fahrzeit 12:00\u201312:30 von ${first.name} nach ${second.name} erfassen`,
    );

    const posted = entryPost(page);
    const reloaded = checksGet(page);
    await button.click();
    const created = await posted;
    expect(created.status(), await created.text()).toBe(201);
    await reloaded;
    await expect(page.getByTestId("day-break-travel-offer")).toHaveCount(0);

    // The list of the day: three rows, one with the badge and the route.
    await page.getByTestId("time-entries-view-list").click();
    await expect(page.getByTestId("time-entries-list")).toBeVisible();
    await expect(page.locator("tr[data-testid^='time-entry-row-']")).toHaveCount(3);
    const badges = page.locator("[data-testid$='-travel-badge']");
    await expect(badges).toHaveCount(1);
    await expect(badges.first()).toHaveText("Fahrzeit");
    await expect(page.locator("[data-testid$='-travel-route']")).toHaveText(
      `${first.name} \u2192 ${second.name}`,
    );
  });

  test("a stale offer is not written; the page says so and reloads (Issue #660)", async ({
    page,
    request,
    tenant,
  }) => {
    const day = recentWeekday(2);
    const second = await createSecondSalon(request, tenant);
    const salons = await listSalons(request, tenant);
    const first = salons.find((s) => s.id !== second.id)!;
    await recordEntryViaApi(request, tenant, day, "08:00", "12:00", first.id);
    const arrivalId = await recordEntryViaApi(request, tenant, day, "12:30", "16:00", second.id);

    await signIn(page, request, tenant);
    const checks = checksGet(page);
    await page.goto(`/time-entries?date=${day}`);
    await expect(page.getByTestId("time-entries-page")).toBeVisible();
    expect(await offersOfDay(await checks, day)).toHaveLength(1);
    const button = page.getByTestId("day-break-travel-offer");
    await expect(button).toBeVisible();
    await expect(button).toHaveText(
      `Fahrzeit 12:00\u201312:30 von ${first.name} nach ${second.name} erfassen`,
    );

    // Widen the gap behind the page's back: the arrival entry is moved to start at 13:00. The panel
    // still shows 12:00-12:30; the write rule alone would accept that interval (its anchors still
    // hold), which is why the page re-checks the day before writing.
    const moved = await request.put(`${API_BASE}/api/v1/time-entries/${arrivalId}`, {
      headers: authHeaders(tenant),
      data: {
        startTime: zonedInstant(day, "13:00", TENANT_TZ).toISOString(),
        endTime: zonedInstant(day, "16:00", TENANT_TZ).toISOString(),
        reason: "Veraltetes Angebot im Browsertest",
      },
    });
    expect(moved.status(), `move the arrival entry (${await moved.text()})`).toBeLessThan(300);

    // Every POST /time-entries the page sends from here on is recorded; none must be sent.
    const posts: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes("/api/v1/time-entries") &&
        !req.url().includes("/clock")
      ) {
        posts.push(req.url());
      }
    });
    await button.click();
    await expect(page.locator(".toast-container")).toContainText(
      "Das Angebot ist nicht mehr aktuell",
    );
    // The reload serves the widened gap as the new offer (positive control: the page did reload).
    await expect(page.getByTestId("day-break-travel-offer")).toHaveText(
      `Fahrzeit 12:00\u201313:00 von ${first.name} nach ${second.name} erfassen`,
    );
    expect(posts, "no trip was posted from the stale panel").toHaveLength(0);

    // Nothing was written: no trip exists for the day.
    const list = await request.get(`${API_BASE}/api/v1/time-entries?from=${day}&to=${day}`, {
      headers: authHeaders(tenant),
    });
    expect(list.ok(), `list the day (${list.status()})`).toBe(true);
    const body = (await list.json()) as unknown;
    const rows = (
      Array.isArray(body) ? body : ((body as { entries?: unknown[] }).entries ?? [])
    ) as {
      activityKind?: string;
    }[];
    expect(rows.length, "the day still lists its first entry").toBeGreaterThan(0);
    expect(rows.filter((r) => r.activityKind === "TRAVEL")).toHaveLength(0);
  });

  test("a tenant with one salon is offered no trip switch", async ({ page, request, tenant }) => {
    const day = recentWeekday();
    await recordEntryViaApi(request, tenant, day, "08:00", "12:00");

    await signIn(page, request, tenant);
    await page.goto(`/time-entries?date=${day}`);
    await expect(page.getByTestId("time-entries-page")).toBeVisible();
    await expect(page.locator("select.salon-switcher-select")).toHaveCount(0);
    // Issue #660 (AC-660-6): no offer button either (the positive control is the two-salon test d.).
    await expect(page.getByTestId("day-break-travel-offer")).toHaveCount(0);
    await page.getByTestId(`calendar-cell-${day}`).click();
    const modal = page.getByTestId("time-entry-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("time-entry-modal-travel-switch")).toHaveCount(0);
    await page.getByTestId("time-entry-modal-cancel").click();
    await expect(modal).toBeHidden();
    // The list of a single-salon tenant shows no trip badge.
    await page.getByTestId("time-entries-view-list").click();
    await expect(page.getByTestId("time-entries-list")).toBeVisible();
    await expect(page.locator("[data-testid$='-travel-badge']")).toHaveCount(0);
  });
});
