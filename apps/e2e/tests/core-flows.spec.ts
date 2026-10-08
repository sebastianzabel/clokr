import { test, expect } from "../fixtures";
import { loginAsAdmin, loginAsTenantAdmin, screenshotPage } from "./helpers";

interface ClockInBody {
  resolution: { kind: string; entry: { id: string } };
}

interface ClockOutBody {
  resolution: { kind: string };
}

test.describe("Core Flows", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("navigate through all main pages without errors", async ({ page }) => {
    const routes = ["/dashboard", "/time-entries", "/leave", "/settings"];

    // Only records; the assertions on the collected responses run after the walk.
    const responses: { url: string; status: number }[] = [];
    page.on("response", (r) => responses.push({ url: r.url(), status: r.status() }));

    for (const route of routes) {
      const response = await page.goto(route);
      expect(response?.status(), `document response of ${route}`).toBe(200);

      // Every one of these pages renders a PageHead h1.
      await expect(page.locator("h1").first(), `h1 of ${route}`).toBeVisible();

      // The onMount fetches must settle so that a failing one has time to surface as an alert;
      // the dashboard's 5s poll leaves idle windows, so this does not hang.
      await page.waitForLoadState("networkidle");

      await expect(
        page.locator(".alert-error, [role='alert']").filter({ hasText: /fehler|error|500/i }),
        `error alerts on ${route}`,
      ).toHaveCount(0);
    }

    const serverErrors = responses.filter((r) => r.url.includes("/api/") && r.status >= 500);
    expect(serverErrors).toEqual([]);
  });

  test("navigate admin pages without errors", async ({ page }) => {
    const adminRoutes = [
      "/admin/employees",
      "/admin/vacation",
      "/admin/special-leave",
      "/admin/shutdowns",
      "/admin/system",
      "/admin/month-close",
    ];
    for (const route of adminRoutes) {
      const response = await page.goto(route);
      expect(response?.status()).toBeLessThan(500);
    }
  });
});

// A fresh tenant gives a deterministic idle day, while the seed admin's day depends on the demo
// data and on earlier runs — and the old versions of these tests left real time entries on the
// seed admin. No stored login either: the tests log in as their own tenant's admin.
test.describe("Core Flows — clock on an own tenant", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("clock in and verify running state", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);

    // Precondition: nothing recorded today, so the hero card is idle and offers "Einstempeln".
    const header = page.locator(".timer-hd");
    await expect(header).toHaveAttribute("data-day-state", "idle");
    const clockIn = page.getByRole("button", { name: "Einstempeln", exact: true });
    await expect(clockIn).toBeVisible();

    // Register the response wait BEFORE the click so a fast answer cannot be missed.
    const responsePromise = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/time-entries/clock-in" &&
        r.request().method() === "POST",
    );
    await clockIn.click();
    const response = await responsePromise;

    expect(response.status()).toBe(200);
    const body = (await response.json()) as ClockInBody;
    expect(body.resolution.kind).toBe("CLOCKED_IN");
    expect(body.resolution.entry.id).toBeTruthy();

    await expect(header).toHaveAttribute("data-day-state", "running");
    await expect(header).toContainText("Du arbeitest gerade");
    await expect(page.getByRole("button", { name: "Ausstempeln", exact: true })).toBeVisible();

    await screenshotPage(page, "flow-clock-in-active");
  });

  test("clock out and verify stopped state", async ({ page, tenant }) => {
    // Precondition through the API, with the body the dashboard itself sends: an open entry.
    const clockedIn = await page.request.post("/api/v1/time-entries/clock-in", {
      headers: { authorization: `Bearer ${tenant.adminToken}` },
      data: { source: "MOBILE" },
    });
    expect(clockedIn.status()).toBe(200);
    const clockInBody = (await clockedIn.json()) as ClockInBody;
    expect(clockInBody.resolution.kind).toBe("CLOCKED_IN");
    const entryId = clockInBody.resolution.entry.id;

    await loginAsTenantAdmin(page, tenant);

    const header = page.locator(".timer-hd");
    await expect(header).toHaveAttribute("data-day-state", "running");
    const clockOut = page.getByRole("button", { name: "Ausstempeln", exact: true });
    await expect(clockOut).toBeVisible();

    // Register the response wait BEFORE the click so a fast answer cannot be missed.
    const responsePromise = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/v1/time-entries/${entryId}/clock-out` &&
        r.request().method() === "POST",
    );
    await clockOut.click();
    const response = await responsePromise;

    // The dashboard's clock-out is interactive, so the 60s double-tap debounce (resolver.ts:290-310)
    // cannot turn it into a 409, and a single open entry closes as CLOCKED_OUT, not CONSOLIDATED.
    expect(response.status()).toBe(200);
    const body = (await response.json()) as ClockOutBody;
    expect(body.resolution.kind).toBe("CLOCKED_OUT");

    await expect(header).toHaveAttribute("data-day-state", "finished");
    await expect(header).toContainText("Tag abgeschlossen");
    // A finished day offers no primary clock action (day-state.ts:118-124).
    await expect(page.getByRole("button", { name: /^(Ein|Aus)stempeln$/ })).toHaveCount(0);

    await screenshotPage(page, "flow-clock-out-stopped");
  });
});
