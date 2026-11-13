/**
 * Issue #648 / #843 (D-843-11) - the two narrow-viewport defects, fixed by the blocks and pinned here.
 *
 *   1. /shifts: the week header is a PeriodPicker (zoom Woche). At 360 and 390 px the next-week
 *      button lies inside the viewport, is a 44 px target and nothing on the page ends right of
 *      the viewport (an unclipped element beyond it is a failure; a scrolling grid is not).
 *   2. /admin/employees: the person table is a DataTable whose rows become cards below a 760 px
 *      container width. Since #854 (owner review) it is the shared PersonenTable of Team ›
 *      Personen (no e-mail column, one „Öffnen“ link per row). At 360 px the fixture admin's name
 *      and its „Öffnen“ link are visible inside the viewport; at 1440 px (the visual viewport) the
 *      seven columns fit their box and a name stays on one line (843-37).
 *
 * The employee list also keeps its search text and sort in the URL (urlState): the spec types a
 * search, reads it from the URL and reloads to prove the filtered list survives; at desktop width it
 * clicks the sortable head and reads the sort from the URL.
 *
 * Geometry cannot be proven in jsdom (no container queries), which is why this spec exists. It needs
 * only the tenant fixture (no seed) and no date dependency: the checks read positions, not dates.
 * Auth: API login plus addInitScript, the same model as month-bar-narrow-viewport.spec.ts.
 *
 * No fixed sleeps: every wait is an auto-waiting locator assertion or a polled URL.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import { measurePageOverflow } from "../helpers/viewport-geometry";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const TOLERANCE_PX = 0.5;
/** The height of the neighbouring arrow buttons (D-04 of #553). */
const MIN_TOUCH_TARGET_PX = 44;

async function signIn(page: Page, request: APIRequestContext, tenant: TestTenant): Promise<string> {
  const email = `admin@${tenant.tenantId}.test`;
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email, password: PASSWORD },
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
  return email;
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test(`/shifts: the next-week button is inside the viewport at ${viewport.width} px`, async ({
      page,
      request,
      tenant,
    }) => {
      await signIn(page, request, tenant);
      await page.goto("/shifts");
      const week = page.locator('[data-testid="shifts-week"]');
      await expect(week).toBeVisible();
      // Webfonts change the label width; measure only after they are loaded.
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      const next = page.getByTestId("shifts-week-next");
      await expect(next).toBeVisible();

      const box = await next.boundingBox();
      expect(box, "the next-week button has no box").not.toBeNull();
      expect(
        box?.x ?? -1,
        "the next-week button starts left of the viewport",
      ).toBeGreaterThanOrEqual(-TOLERANCE_PX);
      expect(
        (box?.x ?? 0) + (box?.width ?? 0),
        "the next-week button ends right of the viewport",
      ).toBeLessThanOrEqual(viewport.width + TOLERANCE_PX);
      expect(
        Math.round((box?.height ?? 0) * 10) / 10,
        "the next-week button is smaller than the 44 px touch target",
      ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

      const geometry = await measurePageOverflow(page, TOLERANCE_PX);
      expect(geometry.scrollWidth, "the document is wider than the viewport").toBeLessThanOrEqual(
        geometry.innerWidth,
      );
      expect(geometry.overflowing, "elements end right of the viewport").toEqual([]);
    });
  });
}

/** The fixture admin's own row of the list: its employee id and last name, read through the API. */
async function fixtureAdminPerson(
  request: APIRequestContext,
  tenant: TestTenant,
): Promise<{ id: string; lastName: string }> {
  const email = `admin@${tenant.tenantId}.test`;
  const login = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email, password: PASSWORD },
  });
  expect(login.ok(), `login as the tenant admin (${login.status()})`).toBe(true);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const list = await request.get(`${API_BASE}/api/v1/employees`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(list.ok(), `GET /employees (${list.status()})`).toBe(true);
  const people = (await list.json()) as { id: string; lastName: string; user: { email: string } }[];
  const admin = people.find((p) => p.user.email === email);
  expect(admin, "the fixture admin is in the list").toBeDefined();
  return { id: admin!.id, lastName: admin!.lastName };
}

test.describe("/admin/employees on the DataTable", () => {
  test("at 360 px the name and the „Öffnen“ link of a row are visible inside the viewport", async ({
    page,
    request,
    tenant,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await signIn(page, request, tenant);
    const admin = await fixtureAdminPerson(request, tenant);
    await page.goto("/admin/employees");
    await expect(page.getByTestId("admin-employees-page")).toBeVisible();

    const row = page.getByTestId(`admin-employees-row-${admin.id}`);
    for (const [label, locator] of [
      ["the name", row.locator(".p-title")],
      ["the „Öffnen“ link", page.getByTestId(`admin-employees-row-${admin.id}-open`)],
    ] as const) {
      await expect(locator, label).toBeVisible();
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      expect(box, `${label} has no box`).not.toBeNull();
      expect(box?.x ?? -1, `${label} starts left of the viewport`).toBeGreaterThanOrEqual(
        -TOLERANCE_PX,
      );
      expect(
        (box?.x ?? 0) + (box?.width ?? 0),
        `${label} ends right of the viewport`,
      ).toBeLessThanOrEqual(360 + TOLERANCE_PX);
    }
  });

  // 843-37: at the visual-test viewport the columns lie inside the card. Found by the visual baseline
  // of /admin/employees: cells wrapped and the last column was cut at the card edge. Since #854 the
  // last column is the quiet „Öffnen“ link of the shared table.
  test("at 1440 px the table fits its box: the last column and its links are not clipped", async ({
    page,
    request,
    tenant,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, request, tenant);
    const admin = await fixtureAdminPerson(request, tenant);
    await page.goto("/admin/employees");
    await expect(page.getByTestId("admin-employees-page")).toBeVisible();
    await expect(page.getByTestId(`admin-employees-row-${admin.id}`)).toBeVisible();
    // Webfonts change the column widths; measure only after they are loaded.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    const scroll = page.locator(".dt-scroll");
    const overflow = await scroll.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      "the table scrolls sideways inside its box at 1440 px",
    ).toBeLessThanOrEqual(overflow.clientWidth + TOLERANCE_PX);

    const frame = await scroll.boundingBox();
    expect(frame, "the table box has no box").not.toBeNull();
    const right = (frame?.x ?? 0) + (frame?.width ?? 0);
    const open = page.locator("[data-testid$='-open']").last();
    await expect(open).toBeVisible();
    const box = await open.boundingBox();
    expect(box, "the „Öffnen“ link has no box").not.toBeNull();
    expect(
      (box?.x ?? 0) + (box?.width ?? 0),
      "the „Öffnen“ link of the last row ends right of the table box (clipped)",
    ).toBeLessThanOrEqual(right + TOLERANCE_PX);
    await expect(page.getByRole("columnheader", { name: /Rollen/ })).toBeVisible();
    // No e-mail or last-login column any more (owner review).
    await expect(page.getByRole("columnheader", { name: /E-Mail|Login/ })).toHaveCount(0);

    // A name stays on one line in table mode (before: "VIS-/004" over two lines).
    const oneLine = await page.evaluate(() =>
      [...document.querySelectorAll(".p-title")].every((el) => {
        const style = getComputedStyle(el);
        const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
        return el.getBoundingClientRect().height <= line * 1.5;
      }),
    );
    expect(oneLine, "a name wraps onto a second line in table mode").toBe(true);
  });

  test("the search text is in the URL and survives a reload", async ({ page, request, tenant }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await signIn(page, request, tenant);
    const admin = await fixtureAdminPerson(request, tenant);
    await page.goto("/admin/employees");
    const search = page.getByRole("searchbox", { name: "Name oder Nummer" });
    const row = page.getByTestId(`admin-employees-row-${admin.id}`);
    await expect(row).toBeVisible();

    // A term that matches the fixture admin: the list keeps the row and the URL carries the term.
    const term = admin.lastName.toLowerCase();
    await search.fill(term);
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(term);
    await expect(row).toBeVisible();
    await page.reload();
    await expect(search).toHaveValue(term);
    await expect(row).toBeVisible();

    // A term that matches nobody: the list is empty after the reload as well.
    await search.fill("zzzz-kein-treffer");
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("zzzz-kein-treffer");
    await page.reload();
    await expect(search).toHaveValue("zzzz-kein-treffer");
    await expect(page.locator("[data-testid^='admin-employees-row-']")).toHaveCount(0);
    await expect(page.getByText("Keine Treffer")).toBeVisible();
  });

  test("the sort of the Std./Woche column is in the URL", async ({ page, request, tenant }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, request, tenant);
    await page.goto("/admin/employees");
    const sort = page.getByRole("button", { name: "Nach Std./Woche sortieren" });
    await expect(sort).toBeVisible();

    await sort.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("stunden");
    await sort.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("dir")).toBe("desc");
    await page.reload();
    await expect(page.getByRole("columnheader", { name: /Std\.\/Woche/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });
});
