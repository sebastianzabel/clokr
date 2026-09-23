/**
 * Leave (Urlaub) UI flow — Phase 73-04 migrated spec.
 *
 * Replaces the v1-era CSS-class + arbitrary-sleep spec with the Phase 73
 * test-tenant fixture + `data-testid` selectors. Each test gets an
 * isolated tenant via `tenant` fixture (Phase 73-02); selectors come
 * from the Phase 73-04 testid surface on `/leave` + `/team/leave`.
 *
 * Migration rules (Plan 73-04 Task 4):
 *   - Use `page.getByTestId(...)` exclusively for interactive elements.
 *   - Import `test` + `expect` from `../fixtures` (NOT `@playwright/test`).
 *   - No arbitrary sleeps — wait on state via `expect().toBeVisible()`
 *     or `page.waitForResponse(...)` (Plan 73-06 ESLint gate enforces it).
 *   - Per-test tenant means no shared state between tests.
 *
 * Auth model:
 *   - The tenant fixture bootstraps a fresh tenant whose admin user has
 *     email `admin@{tenantId}.test` + password `test1234` (Phase 73-01).
 *   - Each test does a UI login with those credentials. Going through
 *     `/login` populates localStorage exactly like the real app, so the
 *     SvelteKit `(app)` layout + authStore work identically.
 */
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";
const TEST_PASSWORD = "test1234";

/**
 * Log in via the public /login form using the bootstrap admin credentials
 * for the fresh tenant. After this call the page is on a post-auth route
 * (the app auto-redirects to /dashboard) with localStorage populated.
 *
 * UI login (not API-shortcut) is intentional: it exercises the exact
 * flow real users take and proves the testids don't break navigation.
 */
async function loginAsTenantAdmin(
  page: import("@playwright/test").Page,
  tenant: TestTenant,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(`admin@${tenant.tenantId}.test`);
  await page.getByLabel("Passwort", { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /anmelden/i }).click();
  // Wait for the app shell to take over — the redirect target may vary
  // (/dashboard, /time-entries, /) so wait on any (app)-layout marker.
  await page.waitForURL(/\/(dashboard|time-entries|leave|$)/, { timeout: 10_000 });
}

/**
 * Helper: hand-off the bootstrap admin token to a `request` call. The
 * spec uses this to seed a second employee + leave request via the API
 * before exercising the UI — way faster than driving the UI to create
 * a second user.
 */
function tenantAuthHeaders(tenant: TestTenant): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${tenant.adminToken}`,
  };
}

/**
 * Pick a future weekday that is guaranteed to stay inside the CURRENT calendar year.
 *
 * Why the year matters: both `/leave` and `/team/leave` load their rows year-scoped
 * (`/leave/requests?year=${calYear}`, and `calYear` is initialised from
 * `now.getFullYear()`). A leave request dated in the NEXT year is created
 * successfully — the API is perfectly happy with it — but the list never loads it,
 * so no row testid ever appears and the assertion fails on a locator rather than on
 * the behaviour under test. A plain `today + N days` therefore turns red for every
 * run in the last N days of the year. Measured: the +100 variant went red on
 * 2026-09-23 and would have stayed red until 2027-01-01 (GitHub issue #319).
 *
 * The time-of-day is pinned to local noon before formatting because
 * `toISOString().slice(0, 10)` cuts in UTC: without it, a morning run in a timezone
 * east of UTC yields the previous calendar day (the midnight-straddle class from
 * issue #34).
 *
 * Fails loudly rather than silently returning a past date: clamping to 31 December
 * and walking back to a weekday can land on or before today when the run itself
 * happens in the last days of the year. A test asserting on a date in the past would
 * still "pass" while proving nothing, which is precisely the failure mode this
 * project keeps paying for.
 */
function futureWeekdayInCurrentYear(preferredOffsetDays: number): string {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const year = today.getFullYear();

  const target = new Date(today);
  target.setDate(target.getDate() + preferredOffsetDays);

  // Inside the year: walk FORWARD, the direction that keeps the date future.
  if (target.getFullYear() === year) {
    while (target.getDay() === 0 || target.getDay() === 6) {
      target.setDate(target.getDate() + 1);
    }
  }

  // Re-checked, NOT an `else`: the forward weekend walk above can itself cross
  // into the next year when the offset lands on a Saturday in late December
  // (measured: 2028-09-21 + 100 days = Sat 2028-12-30, forward-walked to
  // 2029-01-01). Testing the year only once would leave exactly that case broken.
  if (target.getFullYear() !== year) {
    // Clamp into the current year, then walk BACK to the nearest weekday.
    // setFullYear, not setMonth: `target` has already rolled into the NEXT year
    // here, so setting only month+day would land on 31 December of THAT year and
    // reproduce the very bug this helper exists to prevent.
    target.setFullYear(year, 11, 31);
    while (target.getDay() === 0 || target.getDay() === 6) {
      target.setDate(target.getDate() - 1);
    }
  }

  if (target.getTime() <= today.getTime()) {
    const daysLeft = Math.round(
      (new Date(year, 11, 31, 12).getTime() - today.getTime()) / 86_400_000,
    );
    throw new Error(
      `futureWeekdayInCurrentYear(${preferredOffsetDays}) could not find a future weekday ` +
        `inside ${year}: best candidate ${target.toISOString().slice(0, 10)} is not after ` +
        `today ${today.toISOString().slice(0, 10)} (${daysLeft} day(s) left in the year). ` +
        `The year-scoped list cannot render a next-year row — see GitHub issue #319.`,
    );
  }

  return target.toISOString().slice(0, 10);
}

test.describe("Leave (Urlaub) UI flow", () => {
  test("page renders the documented testid surface (D-05)", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/leave");

    // Surface anchors — these prove the page-level testid contract.
    await expect(page.getByTestId("leave-page")).toBeAttached();
    await expect(page.getByTestId("leave-new-request")).toBeVisible();
    await expect(page.getByTestId("leave-balance")).toBeVisible();
    await expect(page.getByTestId("leave-view-tabs")).toBeVisible();
    await expect(page.getByTestId("leave-view-calendar")).toBeVisible();
    await expect(page.getByTestId("leave-view-list")).toBeVisible();
  });

  test("switching to list view exposes filter testids", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/leave");

    await page.getByTestId("leave-view-list").click();
    await expect(page.getByTestId("leave-filter-status")).toBeVisible();
    await expect(page.getByTestId("leave-filter-type")).toBeVisible();
  });

  test("opens form modal with full leave-form-* testid coverage", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/leave");

    await page.getByTestId("leave-new-request").click();

    const form = page.getByTestId("leave-form");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("leave-form-modal")).toBeAttached();
    await expect(form.getByTestId("leave-form-type")).toBeVisible();
    await expect(form.getByTestId("leave-form-from")).toBeVisible();
    await expect(form.getByTestId("leave-form-to")).toBeVisible();
    await expect(form.getByTestId("leave-form-note")).toBeVisible();
    await expect(form.getByTestId("leave-form-half-day")).toBeAttached();
    await expect(form.getByTestId("leave-form-submit")).toBeVisible();
    await expect(form.getByTestId("leave-form-cancel")).toBeVisible();
  });

  test("submits a SICK leave request via the testid form and verifies via API", async ({
    page,
    tenant,
  }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/leave");

    await page.getByTestId("leave-new-request").click();
    const form = page.getByTestId("leave-form");
    await expect(form).toBeVisible();

    // SICK avoids the vacation-entitlement guard. A date ~90 days out + tenant
    // isolation prevents collisions across test runs; the helper keeps it inside
    // the current year, which the year-scoped list requires (issue #319).
    const dateStr = futureWeekdayInCurrentYear(90);

    await form.getByTestId("leave-form-type").selectOption("SICK");
    await form.getByTestId("leave-form-from").fill(dateStr);
    await form.getByTestId("leave-form-to").fill(dateStr);

    // Wait on the create response — deterministic stand-in for arbitrary
    // sleeps. The API contract is POST /api/v1/leave/requests; status 201
    // on success.
    const createResponse = page.waitForResponse(
      (r) => r.url().includes("/api/v1/leave/requests") && r.request().method() === "POST",
    );
    await form.getByTestId("leave-form-submit").click();
    const response = await createResponse;
    expect(response.status()).toBe(201);

    // Cross-check via API (use tenant.adminToken, not the UI's token, so we
    // assert the request landed in this tenant's scope).
    const listRes = await page.request.get(`${API_BASE}/api/v1/leave/requests`, {
      headers: tenantAuthHeaders(tenant),
    });
    expect(listRes.ok()).toBeTruthy();
    const requests = (await listRes.json()) as Array<{
      id: string;
      startDate: string;
      typeCode: string;
    }>;
    const created = requests.find((r) => r.startDate.slice(0, 10) === dateStr);
    expect(created, `Created SICK leave on ${dateStr} should be visible via API`).toBeDefined();
    expect(created!.typeCode).toBe("SICK");

    // The list view should now address the new row by its id. The list-view
    // tab is the entry point.
    await page.getByTestId("leave-view-list").click();
    await expect(page.getByTestId(`leave-mine-row-${created!.id}`)).toBeVisible();
    await expect(page.getByTestId(`leave-mine-row-${created!.id}-status-badge`)).toBeVisible();
  });

  test("manager review modal exposes leave-approval-modal-* testids", async ({ page, tenant }) => {
    // Seed a SICK leave for the bootstrap admin's employee via the API so the
    // /team/leave Genehmigungen tab has something to render. Using SICK over
    // VACATION sidesteps the vacation-entitlement guard on bare-bones tenants.
    // Kept inside the current year — /team/leave loads its rows year-scoped, so a
    // next-year request is created but never rendered (issue #319).
    const dateStr = futureWeekdayInCurrentYear(100);

    // Create a second employee in the tenant so the admin (manager) is not
    // looking at their OWN request — `/team/leave` blocks self-approval and
    // hides the approve/reject buttons for the user's own employee row.
    const empRes = await page.request.post(`${API_BASE}/api/v1/employees`, {
      headers: tenantAuthHeaders(tenant),
      data: {
        email: `emp-${Date.now()}@${tenant.tenantId}.test`,
        firstName: "Review",
        lastName: "Target",
        employeeNumber: `RT-${Date.now().toString(36).slice(-6)}`,
        hireDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
        role: "EMPLOYEE",
      },
    });
    expect(empRes.ok()).toBeTruthy();
    const employee = (await empRes.json()) as { id: string };

    const leaveRes = await page.request.post(`${API_BASE}/api/v1/leave/requests`, {
      headers: tenantAuthHeaders(tenant),
      data: {
        type: "SICK",
        startDate: dateStr,
        endDate: dateStr,
        employeeId: employee.id,
      },
    });
    expect(leaveRes.ok()).toBeTruthy();
    const leave = (await leaveRes.json()) as { id: string; status: string };

    await loginAsTenantAdmin(page, tenant);
    await page.goto("/team/leave");

    // Open the review modal via the row's testid action — works regardless
    // of which tab the page lands on (list shows it, approvals tab shows it).
    // Switch to the list view tab first to guarantee a stable row.
    const reviewBtn =
      leave.status === "CANCELLATION_REQUESTED"
        ? page.getByTestId(`leave-team-row-${leave.id}-review-cancel`)
        : page.getByTestId(`leave-team-row-${leave.id}-review`);

    // Switch to the Anträge tab on /team/leave via the testid surface — the
    // resilient path that does not depend on the German tab label or any
    // role/name combo.
    await page.getByTestId("leave-team-view-list").click();
    await expect(reviewBtn).toBeVisible();
    await reviewBtn.click();

    const modal = page.getByTestId("leave-approval-modal");
    await expect(modal).toBeAttached();
    await expect(page.getByTestId("leave-approval-modal-summary")).toBeVisible();
    await expect(page.getByTestId("leave-approval-modal-reason")).toBeVisible();
    await expect(page.getByTestId("leave-approval-modal-approve")).toBeVisible();
    await expect(page.getByTestId("leave-approval-modal-reject")).toBeVisible();
    await expect(page.getByTestId("leave-approval-modal-close")).toBeVisible();
  });

  test("filter testids drive the visible status filter", async ({ page, tenant }) => {
    await loginAsTenantAdmin(page, tenant);
    await page.goto("/leave");
    await page.getByTestId("leave-view-list").click();

    // Select the "Genehmigt" option via the testid wired on the <option>.
    // Playwright's selectOption resolves either by value or by label; here
    // we use value because the testid lives on the option element itself.
    await page.getByTestId("leave-filter-status").selectOption("APPROVED");
    // No assertion on row count — the empty-tenant state has no rows.
    // The contract proven here is "filter-status is addressable + driveable
    // via testid"; row-state behavior is covered by the SICK-create test.
    await expect(page.getByTestId("leave-filter-status")).toHaveValue("APPROVED");
  });
});
