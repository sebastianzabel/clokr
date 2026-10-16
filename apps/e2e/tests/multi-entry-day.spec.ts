/**
 * Issue #70 — several time entries on one day, recorded in a real browser.
 *
 * The component and API tests prove each piece; this spec proves the promises only a browser can
 * show, on the real test stack (a tenant with two active salons):
 *   a. a worker records two entries on one day in two salons through the form: "Neuer Eintrag"
 *      with the "Salon" field, then "Weiteren Eintrag an diesem Tag" from the edit dialog of the
 *      first entry (start preset to the first entry's end);
 *   b. the list shows both rows with the "Salon" column naming each salon;
 *   c. the calendar cell of that day carries the tooltip "2 Einträge" and switches to the list
 *      focused on the day instead of opening one entry;
 *   d. a third entry that overlaps the first is refused with the server's German overlap text, the
 *      dialog stays open and the list still has two rows (nothing was written);
 *   e. a cell with exactly ONE entry still opens that entry for editing, with its own salon
 *      preselected;
 *   f. a tenant with a single salon sees none of it: no "Salon" field, no "Salon" column, no
 *      per-day add - and its one-entry cell still opens edit (D-12).
 *
 * Auth: same model as admin-salons.spec.ts (throwaway tenant, API login, localStorage hydrated with
 * addInitScript). Dates are computed from the current day (weekdays inside the 10-day retro window,
 * in the tenant's time zone, which the browser context shares), so there is no fixed date and no
 * fixed sleep: every wait is on an observable condition. Salon names are synthetic.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const TENANT_TZ = "Europe/Berlin";
const SECOND_SALON_NAME = "Zweitsalon Testheim";

// The tenant is provisioned in Europe/Berlin; the browser must read and type times in that zone,
// otherwise the typed "08:00" and the tenant's wording of an overlap would differ.
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

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Two weekdays of the same calendar month inside the last nine days (the retro window is ten), the
 * more recent one first. A window of nine days holds at most one month boundary, so a pair of the
 * same month always exists.
 */
function twoRecentWeekdaysOfOneMonth(): [string, string] {
  const today = todayInTenantZone();
  const weekdays: Date[] = [];
  for (let back = 1; back <= 9; back += 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - back);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) weekdays.push(d);
  }
  for (const first of weekdays) {
    const second = weekdays.find(
      (other) => other !== first && other.getUTCMonth() === first.getUTCMonth(),
    );
    if (second) return [dayKey(first), dayKey(second)];
  }
  throw new Error("no two weekdays of one month in the last nine days");
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

/** A closed entry recorded straight through the API (setup only; the salon is derived). */
async function recordEntryViaApi(
  request: APIRequestContext,
  tenant: TestTenant,
  day: string,
  start: string,
  end: string,
) {
  const res = await request.post(`${API_BASE}/api/v1/time-entries`, {
    headers: authHeaders(tenant),
    data: {
      date: day,
      startTime: new Date(`${day}T${start}:00`).toISOString(),
      endTime: new Date(`${day}T${end}:00`).toISOString(),
      breakMinutes: 0,
    },
  });
  expect(res.status(), `record an entry on ${day} (${await res.text()})`).toBe(201);
}

async function openMonthOf(page: Page, day: string) {
  await page.goto(`/time-entries?date=${day}`);
  await expect(page.getByTestId("time-entries-page")).toBeVisible();
  await expect(page.getByTestId(`calendar-cell-${day}`)).toBeVisible();
}

/** The POST of a manual entry; resolves with its HTTP status. */
function entryPost(page: Page) {
  return page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/time-entries") &&
      !res.url().includes("/clock") &&
      res.request().method() === "POST",
  );
}

test.describe("several entries on one day (Issue #70)", () => {
  test("two salons on one day: form, list with salon column, calendar cell, overlap refusal, one-entry cell", async ({
    page,
    request,
    tenant,
  }) => {
    const [dayTwo, dayOne] = twoRecentWeekdaysOfOneMonth();
    const second = await createSecondSalon(request, tenant);
    const salons = await listSalons(request, tenant);
    expect(salons).toHaveLength(2);
    const first = salons.find((s) => s.id !== second.id)!;
    // A day with exactly one entry, recorded through the API in the salon the server derives.
    await recordEntryViaApi(request, tenant, dayOne, "08:00", "12:00");

    await signIn(page, request, tenant);
    await openMonthOf(page, dayTwo);
    // The header switcher only exists once the salon context holds several reachable salons: the
    // page then decides by the same state.
    await expect(page.locator("select.salon-switcher-select")).toBeVisible();

    // a. "Neuer Eintrag" with the Salon field: 08:00-12:00 in the first salon.
    await page.getByTestId("time-entries-add").click();
    const modal = page.getByTestId("time-entry-modal");
    await expect(modal).toBeVisible();
    const salonField = page.getByTestId("time-entry-modal-salon");
    await expect(salonField).toBeVisible();
    await salonField.selectOption({ label: first.name });
    await page.getByTestId("time-entry-modal-start").fill("08:00");
    await page.getByTestId("time-entry-modal-end").fill("12:00");
    let posted = entryPost(page);
    await page.getByTestId("time-entry-modal-save").click();
    expect((await posted).status()).toBe(201);
    await expect(modal).toBeHidden();

    // a. The day now has ONE entry (the cell shows its hours once the month reloaded): its cell
    // opens it for editing; "Weiteren Eintrag an diesem Tag" starts a NEW form whose start is the
    // first entry's end.
    await expect(page.getByTestId(`calendar-cell-${dayTwo}`)).toContainText("4:00");
    await page.getByTestId(`calendar-cell-${dayTwo}`).click();
    await expect(modal).toBeVisible();
    await expect(page.locator("[role='dialog'] .modal-eyebrow").first()).toContainText(
      "Eintrag bearbeiten",
    );
    await page.getByTestId("time-entry-modal-add-additional").click();
    await expect(page.locator("[role='dialog'] .modal-eyebrow").first()).toContainText(
      "Neuer Eintrag",
    );
    await expect(page.getByTestId("time-entry-modal-start")).toHaveValue("12:00");
    await salonField.selectOption({ label: second.name });
    await page.getByTestId("time-entry-modal-start").fill("13:00");
    await page.getByTestId("time-entry-modal-end").fill("16:00");
    posted = entryPost(page);
    await page.getByTestId("time-entry-modal-save").click();
    expect((await posted).status()).toBe(201);
    await expect(modal).toBeHidden();

    // c. Two entries: the cell says so and switches to the list focused on the day.
    const cell = page.getByTestId(`calendar-cell-${dayTwo}`);
    await expect(cell).toHaveAttribute("title", "2 Einträge");
    await cell.click();
    await expect(modal).toBeHidden();
    await expect(page.getByTestId("time-entries-list")).toBeVisible();
    const dayRows = page.locator("tr.row-day-focus");
    await expect(dayRows).toHaveCount(2);

    // b. The list names the salon of each row.
    await expect(page.getByRole("columnheader", { name: "Salon", exact: true })).toBeVisible();
    const salonCells = page.locator("tr.row-day-focus td[data-testid$='-salon']");
    await expect(salonCells).toHaveCount(2);
    const names = (await salonCells.allTextContents()).map((t) => t.trim());
    expect([...names].sort()).toEqual([first.name, second.name].sort());
    await expect(page.locator("tr[data-testid^='time-entry-row-']")).toHaveCount(3);

    // d. A third entry overlapping the first is refused with the server's text; nothing is written.
    await page.getByTestId("time-entries-add-additional").click();
    await expect(modal).toBeVisible();
    await salonField.selectOption({ label: first.name });
    await page.getByTestId("time-entry-modal-start").fill("11:00");
    await page.getByTestId("time-entry-modal-end").fill("14:00");
    posted = entryPost(page);
    await page.getByTestId("time-entry-modal-save").click();
    expect((await posted).status()).toBe(409);
    await expect(page.getByTestId("time-entry-modal-error")).toContainText(
      "Überschneidung mit bestehendem Eintrag",
    );
    await expect(modal).toBeVisible();
    await page.getByTestId("time-entry-modal-cancel").click();
    await expect(modal).toBeHidden();
    // Two rows of the day plus the one-entry day recorded through the API.
    await expect(page.locator("tr[data-testid^='time-entry-row-']")).toHaveCount(3);

    // e. The cell of the one-entry day still opens that entry for editing, salon preselected.
    await page.getByTestId("time-entries-view-calendar").click();
    const oneCell = page.getByTestId(`calendar-cell-${dayOne}`);
    await expect(oneCell).not.toHaveAttribute("title", "2 Einträge");
    await oneCell.click();
    await expect(modal).toBeVisible();
    await expect(page.locator("[role='dialog'] .modal-eyebrow").first()).toContainText(
      "Eintrag bearbeiten",
    );
    await expect(salonField).toBeVisible();
    await expect(salonField).not.toHaveValue("");
    await page.getByTestId("time-entry-modal-cancel").click();
    await expect(modal).toBeHidden();
  });

  test("a tenant with one salon sees no salon field, no salon column and no per-day add", async ({
    page,
    request,
    tenant,
  }) => {
    const [day] = twoRecentWeekdaysOfOneMonth();
    await recordEntryViaApi(request, tenant, day, "08:00", "12:00");

    await signIn(page, request, tenant);
    await openMonthOf(page, day);
    await expect(page.getByTestId(`calendar-cell-${day}`)).toContainText("4:00");
    await expect(page.locator("select.salon-switcher-select")).toHaveCount(0);

    // The cell of a day with one entry opens it for editing - no salon field in the dialog.
    await page.getByTestId(`calendar-cell-${day}`).click();
    const modal = page.getByTestId("time-entry-modal");
    await expect(modal).toBeVisible();
    await expect(page.locator("[role='dialog'] .modal-eyebrow").first()).toContainText(
      "Eintrag bearbeiten",
    );
    await expect(page.getByTestId("time-entry-modal-salon")).toHaveCount(0);
    await expect(page.getByTestId("time-entry-modal-add-additional")).toHaveCount(0);
    await page.getByTestId("time-entry-modal-cancel").click();
    await expect(modal).toBeHidden();

    // "Neuer Eintrag" on that day opens the entry as it always did.
    await page.getByTestId("time-entries-add").click();
    await expect(modal).toBeVisible();
    await expect(page.locator("[role='dialog'] .modal-eyebrow").first()).toContainText(
      "Eintrag bearbeiten",
    );
    await page.getByTestId("time-entry-modal-cancel").click();

    // The list has no Salon column and no per-day bar.
    await page.getByTestId("time-entries-view-list").click();
    await expect(page.getByTestId("time-entries-list")).toBeVisible();
    await expect(page.locator("tr[data-testid^='time-entry-row-']")).toHaveCount(1);
    await expect(page.getByRole("columnheader", { name: "Salon", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("time-entries-add-additional")).toHaveCount(0);
  });
});
