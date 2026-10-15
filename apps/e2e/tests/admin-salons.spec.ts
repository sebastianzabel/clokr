/**
 * Issue #563 — the tenant salon admin in a real browser.
 *
 * The component and API tests prove each piece; this spec proves the promises only a browser can
 * show, on the real test stack:
 *   a. the tenant admin reaches "Salons" from the PLANUNG navigation group and the list shows the
 *      salon with its Bundesland and "Aktiv";
 *   b. a salon's opening hours are edited on its detail page, survive a reload and are what
 *      `GET /api/v1/salons/:id` returns (AC-563-2);
 *   c. the header salon switcher follows a create and a deactivation WITHOUT a page reload
 *      (AC-563-4; a window marker proves no full load happened);
 *   d. without the CHAIN module and with the salon limit reached, the module hint replaces
 *      "Salon anlegen" (one intercepted `/me/context`, display only);
 *   e. `/admin/system` keeps only the shift check mode: three radios, no opening-hours table, and
 *      saving sends nothing but `shiftStoreHoursMode`;
 *   f. `/shifts` with two salons and "Alle Salons" asks for a salon choice, and choosing one hides
 *      the hint;
 *   g. the list and the detail page do not scroll sideways at 390 and 360 px and every row of the
 *      opening-hours editor keeps its two time inputs inside the row box.
 *
 * Auth: same model as admin-tabs-narrow-viewport.spec.ts (throwaway tenant, API login,
 * localStorage hydrated with addInitScript). The bootstrap tenant books every module with quota
 * 500, so a second active salon can be created for real. No fixed sleeps; every wait is on an
 * observable condition. Salon names are synthetic.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const TOLERANCE_PX = 0.5;

const SECOND_SALON_NAME = "Zweitsalon Testheim";

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;

/** The week a salon created through the API gets: Monday to Saturday open, Sunday closed. */
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: "09:00",
  close: "18:00",
  ...(day === 6 ? { closed: true } : {}),
}));

interface SalonRow {
  id: string;
  name: string;
  isActive: boolean;
  openingHours: { day: number; open: string; close: string; closed?: boolean }[];
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
  const res = await request.get(`${API_BASE}/api/v1/salons?includeInactive=true`, {
    headers: authHeaders(tenant),
  });
  expect(res.ok(), `list salons (${res.status()})`).toBe(true);
  return ((await res.json()) as { salons: SalonRow[] }).salons;
}

async function createSalonViaApi(
  request: APIRequestContext,
  tenant: TestTenant,
  name: string,
): Promise<SalonRow> {
  const res = await request.post(`${API_BASE}/api/v1/salons`, {
    headers: authHeaders(tenant),
    data: { name, federalState: "HESSEN", openingHours: WEEK },
  });
  expect(res.status(), `create salon "${name}" (${await res.text()})`).toBe(201);
  return (await res.json()) as SalonRow;
}

/**
 * The planner's grid lists SHIFT_BASED employees only, and its opening-hours hint sits inside the
 * grid; the tenant's admin is therefore put on a shift-based contract (valid from the 1st of the
 * current month, as every contract change must be).
 */
async function makeAdminShiftBased(request: APIRequestContext, tenant: TestTenant) {
  const list = await request.get(`${API_BASE}/api/v1/employees`, { headers: authHeaders(tenant) });
  expect(list.ok(), `list employees (${list.status()})`).toBe(true);
  const [admin] = (await list.json()) as { id: string }[];
  const res = await request.put(`${API_BASE}/api/v1/settings/work/${admin.id}`, {
    headers: authHeaders(tenant),
    data: {
      type: "SHIFT_BASED",
      weeklyHours: 38,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: 5,
      usualWorkDays: [1, 2, 3, 4, 5],
    },
  });
  expect(res.ok(), `put the shift-based contract (${res.status()} ${await res.text()})`).toBe(true);
}

/** The header salon switcher; rendered only while the tenant has several reachable salons. */
function switcher(page: Page) {
  return page.locator("select.salon-switcher-select");
}

/** Marks the current document; a full page load drops the marker, a client-side navigation keeps it. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });
}

async function documentIsMarked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true);
}

test.describe("admin salons (Issue #563)", () => {
  test("the PLANUNG navigation leads to the salon list with Bundesland and status", async ({
    page,
    request,
    tenant,
  }) => {
    await signIn(page, request, tenant);
    await page.goto("/dashboard");

    const link = page
      .getByRole("navigation", { name: "PLANUNG" })
      .getByRole("link", { name: "Salons", exact: true });
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/admin\/salons$/);
    await expect(page.getByRole("heading", { name: "Salons", level: 1 })).toBeVisible();
    const row = page.getByRole("row", { name: /Niedersachsen/ });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Aktiv");
    await expect(page.getByRole("link", { name: "Salon anlegen" })).toBeVisible();
  });

  test("a salon's opening hours are edited, persisted and returned by the API", async ({
    page,
    request,
    tenant,
  }) => {
    await signIn(page, request, tenant);
    const [salon] = await listSalons(request, tenant);
    // The provisioned default week closes Sunday; this test opens it.
    expect(salon.openingHours.find((d) => d.day === 6)?.closed).toBe(true);

    await page.goto("/admin/salons");
    await page
      .getByRole("row", { name: /Niedersachsen/ })
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(new RegExp(`/admin/salons/${salon.id}$`));

    const closed = page.getByLabel("Geschlossen Sonntag");
    await expect(closed).toBeChecked();
    await closed.uncheck();
    await page.getByLabel("Öffnung Sonntag").fill("10:00");
    await page.getByLabel("Schließung Sonntag").fill("14:00");

    const saved = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/v1/salons/${salon.id}`) && res.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Öffnungszeiten speichern" }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByText("Öffnungszeiten gespeichert.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Geschlossen Sonntag")).not.toBeChecked();
    await expect(page.getByLabel("Öffnung Sonntag")).toHaveValue("10:00");
    await expect(page.getByLabel("Schließung Sonntag")).toHaveValue("14:00");

    const res = await request.get(`${API_BASE}/api/v1/salons/${salon.id}`, {
      headers: authHeaders(tenant),
    });
    expect(res.ok()).toBe(true);
    const sunday = ((await res.json()) as SalonRow).openingHours.find((d) => d.day === 6);
    expect(sunday?.open).toBe("10:00");
    expect(sunday?.close).toBe("14:00");
    expect(sunday?.closed ?? false).toBe(false);
  });

  test("the header salon switcher follows a create and a deactivation without a reload", async ({
    page,
    request,
    tenant,
  }) => {
    await signIn(page, request, tenant);
    await page.goto("/admin/salons");
    await expect(page.getByRole("row", { name: /Niedersachsen/ })).toBeVisible();
    await expect(switcher(page)).toHaveCount(0);
    await markDocument(page);

    // Create: the list's own link navigates client-side.
    await page.getByRole("link", { name: "Salon anlegen" }).click();
    await expect(page).toHaveURL(/\/admin\/salons\/neu$/);
    await page.getByLabel("Name *").fill(SECOND_SALON_NAME);
    await page.getByLabel("Bundesland *").selectOption("HESSEN");
    await page.getByRole("button", { name: "Salon anlegen" }).click();

    await expect(page.getByText("Salon angelegt.")).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/salons\/(?!neu$)[0-9a-f-]{36}$/);
    await expect(switcher(page)).toBeVisible();
    await expect(switcher(page).locator("option")).toHaveText([
      "Alle Salons",
      /.+/,
      SECOND_SALON_NAME,
    ]);
    expect(await documentIsMarked(page), "the page was not reloaded by the create").toBe(true);

    // Deactivate through the Danger Zone and its confirmation.
    await page.getByRole("button", { name: "Salon deaktivieren" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deaktivieren" }).click();

    await expect(page.getByText("Salon deaktiviert.")).toBeVisible();
    await expect(switcher(page)).toHaveCount(0);
    expect(await documentIsMarked(page), "the page was not reloaded by the deactivation").toBe(
      true,
    );
  });

  test("without the Ketten-Paket and at the salon limit the module hint replaces the create action", async ({
    page,
    request,
    tenant,
  }) => {
    await signIn(page, request, tenant);
    await page.route("**/api/v1/me/context", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: { ...body, packages: { bookedModules: [], salonLimit: 1 } },
      });
    });

    await page.goto("/admin/salons");
    await expect(page.getByRole("row", { name: /Niedersachsen/ })).toBeVisible();
    await expect(page.getByText(/Ketten-Paket/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Salon anlegen" })).toHaveCount(0);
  });

  test("admin/system keeps only the shift check mode and saves nothing else", async ({
    page,
    request,
    tenant,
  }) => {
    await signIn(page, request, tenant);
    await page.goto("/admin/system");

    await expect(page.getByText("Schichtprüfung gegen Öffnungszeiten")).toBeVisible();
    await expect(page.locator('input[name="shiftStoreHoursMode"]')).toHaveCount(3);
    await expect(page.getByText("Wochentag", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Öffnung", { exact: true })).toHaveCount(0);

    await page.getByRole("radio", { name: /Strikt/ }).check();
    const request$ = page.waitForRequest(
      (req) => req.url().includes("/api/v1/settings/work") && req.method() === "PUT",
    );
    await page.getByRole("button", { name: "Prüfmodus speichern" }).click();
    const sent = await request$;
    expect(Object.keys(sent.postDataJSON() as Record<string, unknown>)).toEqual([
      "shiftStoreHoursMode",
    ]);
    await expect(page.getByText("Prüfmodus gespeichert.")).toBeVisible();
  });

  test("/shifts asks for a salon choice with several salons and hides the hint once one is chosen", async ({
    page,
    request,
    tenant,
  }) => {
    await makeAdminShiftBased(request, tenant);
    await createSalonViaApi(request, tenant, SECOND_SALON_NAME);
    await signIn(page, request, tenant);
    await page.goto("/shifts");

    const hint = page.getByText(
      "Öffnungszeiten je Salon – Salon wählen, um geschlossene Tage zu sehen.",
    );
    await expect(switcher(page)).toBeVisible();
    await expect(switcher(page)).toHaveValue(/.+/);
    await expect(hint).toBeVisible();

    await switcher(page).selectOption({ label: SECOND_SALON_NAME });
    await expect(hint).toHaveCount(0);
  });

  for (const viewport of VIEWPORTS) {
    test(`the list and the detail page fit ${viewport.width} px`, async ({
      page,
      request,
      tenant,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const [salon] = await listSalons(request, tenant);
      await signIn(page, request, tenant);

      for (const path of ["/admin/salons", `/admin/salons/${salon.id}`]) {
        const where = `${path} at ${viewport.width} px`;
        await page.goto(path);
        if (path === "/admin/salons") {
          // Below 640 px the Bundesland column is hidden (it is no longer in the row's name); the
          // status badge is what this view must keep.
          await expect(page.getByRole("row", { name: /Aktiv/ })).toBeVisible();
        } else {
          await expect(page.getByLabel("Geschlossen Sonntag")).toBeVisible();
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
        });

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        // Recorded in the JSON report so the measured value, not only the verdict, is kept.
        testInfo.annotations.push({ type: "overflow", description: `${where}: ${overflow} px` });
        expect(overflow, `${where}: the document does not scroll sideways`).toBeLessThanOrEqual(
          TOLERANCE_PX,
        );

        if (path === "/admin/salons") {
          // The list's own scroll box must not hide the status column either (measured at 390 px
          // before the Bundesland column gave way: the badge sat cut off inside `.table-wrap`).
          const inner = await page
            .locator(".table-wrap")
            .first()
            .evaluate((el) => ({
              overflow: el.scrollWidth - el.clientWidth,
            }));
          expect(
            inner.overflow,
            `${where}: the table does not scroll inside its card`,
          ).toBeLessThanOrEqual(TOLERANCE_PX);
        }

        if (path !== "/admin/salons") {
          const rows = page.locator(".ohe-row:not(.ohe-row--head)");
          expect(await rows.count(), `${where}: seven weekday rows`).toBe(7);
          const geometry = await rows.evaluateAll((els) =>
            els.map((row) => {
              const box = row.getBoundingClientRect();
              const inputs = Array.from(row.querySelectorAll<HTMLInputElement>("input[type=time]"));
              return {
                left: box.left,
                right: box.right,
                inputs: inputs.map((input) => {
                  const b = input.getBoundingClientRect();
                  return { left: b.left, right: b.right, width: b.width };
                }),
              };
            }),
          );
          for (const [index, row] of geometry.entries()) {
            expect(row.inputs.length, `${where}: row ${index} has two time inputs`).toBe(2);
            for (const input of row.inputs) {
              expect(input.width, `${where}: row ${index} input is rendered`).toBeGreaterThan(0);
              expect(
                input.left,
                `${where}: row ${index} input starts inside the row`,
              ).toBeGreaterThanOrEqual(row.left - TOLERANCE_PX);
              expect(
                input.right,
                `${where}: row ${index} input ends inside the row`,
              ).toBeLessThanOrEqual(row.right + TOLERANCE_PX);
            }
          }
        }
      }
    });
  }
});
