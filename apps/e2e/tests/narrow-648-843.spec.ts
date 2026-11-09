/**
 * Issue #648 / #843 (D-843-11) - the two narrow-viewport defects, fixed by the blocks and pinned here.
 *
 *   1. /shifts: the week header is a PeriodPicker (zoom Woche). At 360 and 390 px the next-week
 *      button lies inside the viewport, is a 44 px target and nothing on the page ends right of
 *      the viewport (an unclipped element beyond it is a failure; a scrolling grid is not).
 *   2. /admin/employees: the person table is a DataTable whose rows become cards below a 760 px
 *      container width. At 360 px the e-mail value of the fixture admin is visible inside the
 *      viewport (before, it sat in a column that scrolled out of sight).
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

test.describe("/admin/employees on the DataTable", () => {
  test("at 360 px the e-mail value of a row is visible inside the viewport", async ({
    page,
    request,
    tenant,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const email = await signIn(page, request, tenant);
    await page.goto("/admin/employees");
    await expect(page.getByTestId("admin-employees-page")).toBeVisible();

    // The value, not the row: before the block the address sat in a column scrolled out of sight.
    const value = page.locator(".col-email").filter({ hasText: email });
    await expect(value).toBeVisible();
    await value.scrollIntoViewIfNeeded();
    const box = await value.boundingBox();
    expect(box, "the e-mail value has no box").not.toBeNull();
    expect(box?.x ?? -1, "the e-mail value starts left of the viewport").toBeGreaterThanOrEqual(
      -TOLERANCE_PX,
    );
    expect(
      (box?.x ?? 0) + (box?.width ?? 0),
      "the e-mail value ends right of the viewport",
    ).toBeLessThanOrEqual(360 + TOLERANCE_PX);
  });

  test("the search text is in the URL and survives a reload", async ({ page, request, tenant }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const email = await signIn(page, request, tenant);
    await page.goto("/admin/employees");
    const search = page.getByTestId("admin-employees-search");
    const row = page.locator(".col-email").filter({ hasText: email });
    await expect(row).toBeVisible();

    // A term that matches the fixture admin: the list keeps the row and the URL carries the term.
    await search.fill("admin");
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("admin");
    await expect(row).toBeVisible();
    await page.reload();
    await expect(search).toHaveValue("admin");
    await expect(row).toBeVisible();

    // A term that matches nobody: the list is empty after the reload as well.
    await search.fill("zzzz-kein-treffer");
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("zzzz-kein-treffer");
    await page.reload();
    await expect(search).toHaveValue("zzzz-kein-treffer");
    await expect(page.locator("[data-testid^='admin-employees-row-']")).toHaveCount(0);
    await expect(page.getByText("Keine Treffer")).toBeVisible();
  });

  test("the sort of the Eintritt column is in the URL", async ({ page, request, tenant }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, request, tenant);
    await page.goto("/admin/employees");
    const sort = page.getByRole("button", { name: "Nach Eintritt sortieren" });
    await expect(sort).toBeVisible();

    await sort.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("hire");
    await sort.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("dir")).toBe("desc");
    await page.reload();
    await expect(page.getByRole("columnheader", { name: /Eintritt/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });
});
