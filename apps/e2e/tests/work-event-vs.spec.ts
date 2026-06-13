/**
 * /shifts BS-Tag lifecycle — Phase 81 UI-V19-06 (TEST-V19-03 partial).
 *
 * Asserts the Phase 81-01 URL swap from /vocational-school/* to /work-events*:
 *  1. The /shifts page renders a BS cell when a VOCATIONAL_SCHOOL WorkEvent
 *     row exists (read path uses GET /work-events).
 *  2. Click-to-delete on the BS cell hits DELETE /api/v1/work-events/:id (NOT
 *     the legacy BC proxy at /vocational-school/:absenceId).
 *  3. After DELETE, the row is soft-deleted in the DB — confirmed by a
 *     follow-up GET /work-events returning no row with that id (the management
 *     endpoint filters deletedAt:null server-side).
 *  4. Network-listener guard: while /shifts loads, ZERO /vocational-school/*
 *     URLs fire — the canonical no-regression test for the URL-swap class.
 *  5. (Negative) Admin attempts to POST a regular Schicht on the same day as
 *     an existing BS cell → 409/422 (availability bucket from shifts.ts:103-106
 *     stays green; CONTEXT D-03 invariant).
 *
 * Notes on selectors (verified from apps/web/src/routes/(app)/shifts/+page.svelte):
 *  - The BS cell does NOT have data-employeeid / data-date attributes (only the
 *    class `.sp-cell--vs-removable` + role=button + title="Berufsschultag entfernen").
 *    Each test creates a single Azubi + a single BS row, so `.first()` on the
 *    class selector is unambiguous within the tenant-isolated fixture.
 *  - The ConfirmDialog confirm button label is "Entfernen" (not "Bestätigen") —
 *    set via `<ConfirmDialog confirmLabel="Entfernen" .../>` at the BS-removal
 *    site (see shifts/+page.svelte L1760).
 *  - createAzubiEmployee from bs-pattern.ts seeds FIXED_SCHEDULE, but /shifts
 *    only renders SHIFT_BASED employees. The spec uses a tiny local helper
 *    (createShiftBasedAzubi) instead — composing the same auth-header + body
 *    shape as bs-pattern.ts but with scheduleType=SHIFT_BASED. This is the
 *    minimum diff that lets the seeded Azubi appear in the /shifts grid.
 *
 * Uses the Phase-73 tenant fixture (TestTenant) for parallel-worktree isolation.
 */

import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import type { Page } from "@playwright/test";
import {
  createWorkEventBs,
  fetchWorkEventsForEmployee,
  type WorkEventVsTenant,
} from "../helpers/work-event-vs";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

function asWeTenant(t: TestTenant): WorkEventVsTenant {
  return { tenantId: t.tenantId, adminToken: t.adminToken };
}

function authHeaders(t: WorkEventVsTenant): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${t.adminToken}`,
  };
}

/**
 * Create a SHIFT_BASED Azubi so the employee actually appears in the /shifts
 * grid. createAzubiEmployee from bs-pattern.ts seeds FIXED_SCHEDULE; the
 * /shifts page filters those out (shiftEmployees derived list).
 */
async function createShiftBasedAzubi(
  tenant: WorkEventVsTenant,
  firstName: string,
): Promise<{ employeeId: string }> {
  const stamp = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
  const body = {
    firstName,
    lastName: "Azubi",
    email: `azubi-${stamp}@${tenant.tenantId}.test`,
    employeeNumber: `AZB-${stamp}`,
    hireDate: new Date().toISOString(),
    role: "EMPLOYEE",
    classification: "AZUBI",
    scheduleType: "SHIFT_BASED",
    weeklyHours: 40,
    workDays: [1, 2, 3, 4, 5],
  };
  const res = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers: authHeaders(tenant),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "<no body>");
    throw new Error(
      `createShiftBasedAzubi: ${res.status} (tenant=${tenant.tenantId}) — ${detail}`,
    );
  }
  const e = (await res.json()) as { id: string };
  return { employeeId: e.id };
}

/**
 * Returns a Tuesday in the upcoming week (Mon-Sun grid). Tuesday is the
 * canonical BS day in fixtures across the codebase (see vocational-school
 * tests + Phase 67 BS-Pattern defaults).
 */
function nextTuesdayIso(): string {
  const d = new Date();
  // Move forward 1 week so the cell is unambiguously future (avoids isPastDay
  // branch in the /shifts page rendering, which would skip the click handler).
  d.setUTCDate(d.getUTCDate() + 7);
  const diff = (2 + 7 - d.getUTCDay()) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

test.describe("Phase 81 — /shifts BS-Tag lifecycle on /work-events", () => {
  test("admin clicks an existing BS cell → DELETE /work-events/:id → calendar refreshes", async ({
    page,
    tenant,
  }) => {
    const we = asWeTenant(tenant);
    const { employeeId } = await createShiftBasedAzubi(we, "Tom");
    const date = nextTuesdayIso();
    const created = await createWorkEventBs(we, employeeId, date);

    // Navigate to /shifts for the week containing `date` so the BS cell renders.
    // The page derives the visible week from cursorMonday(new Date()); since
    // nextTuesdayIso() lives in the upcoming week, we may need to advance the
    // week navigator. Simpler: hit the URL fresh and trust that the BS row
    // belongs to a week the user can navigate to — for the upcoming Tuesday,
    // we click "Nächste Woche" once.
    await page.goto("/shifts");
    // Wait for the initial /work-events GET to fire so we know the read path
    // is on the canonical endpoint (this also serves as part of guard #2).
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/work-events") && r.request().method() === "GET",
      { timeout: 10_000 },
    );
    // Advance one week so the next-Tuesday BS cell is in the visible week.
    await page.getByRole("button", { name: /Nächste Woche/i }).click();
    // Wait for the post-navigation GET to settle.
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/work-events") && r.request().method() === "GET",
      { timeout: 10_000 },
    );

    // BS cell selector: the only `.sp-cell--vs-removable` in the visible grid
    // (the tenant has one Azubi + one BS row). The role="button" + class makes
    // this unambiguous within the per-test tenant.
    const cell = page.locator(".sp-cell--vs-removable").first();
    await expect(cell).toBeVisible({ timeout: 10_000 });

    // Capture the DELETE response BEFORE clicking — proves the click hit
    // /work-events/:id (NOT /vocational-school/:id). T-81-10 mitigation.
    const deletePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes(`/api/v1/work-events/${created.id}`) &&
        resp.request().method() === "DELETE",
      { timeout: 10_000 },
    );

    await cell.click();
    // ConfirmDialog opens — confirmLabel="Entfernen" (NOT "Bestätigen") per
    // the BS-removal site in shifts/+page.svelte L1760.
    await page.getByRole("button", { name: /^Entfernen$/i }).click();

    const delResp = await deletePromise;
    expect(delResp.status()).toBe(204);

    // Calendar refresh — the BS cell is gone from the visible week.
    await expect(page.locator(".sp-cell--vs-removable")).toHaveCount(0);

    // DB soft-delete assertion via API: the management endpoint filters
    // deletedAt:null, so a soft-deleted row no longer surfaces.
    const rows = await fetchWorkEventsForEmployee(we, employeeId, date, date);
    expect(rows.find((r) => r.id === created.id)).toBeUndefined();
  });

  test("/shifts page does NOT call /vocational-school/* anymore", async ({
    page,
    tenant,
  }) => {
    // Lightweight contract test: load /shifts, observe network — no
    // /vocational-school URL is ever requested by the page. This guards the
    // regression class where a forgotten code path silently falls back to
    // the BC proxy. T-81-07 mitigation.
    const we = asWeTenant(tenant);
    const { employeeId } = await createShiftBasedAzubi(we, "Eva");
    await createWorkEventBs(we, employeeId, nextTuesdayIso());

    const vsRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/v1/vocational-school/")) {
        vsRequests.push(`${req.method()} ${req.url()}`);
      }
    });

    await page.goto("/shifts");
    // Wait for the calendar to fully load (Plan 81-01 GET fires here).
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/work-events") && r.request().method() === "GET",
      { timeout: 10_000 },
    );
    // Advance one week so the BS cell also renders — covers the second
    // GET path through the same code (defense in depth).
    await page.getByRole("button", { name: /Nächste Woche/i }).click();
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/work-events") && r.request().method() === "GET",
      { timeout: 10_000 },
    );

    expect(
      vsRequests,
      "Expected ZERO /vocational-school/* requests after Phase 81-01 URL swap",
    ).toEqual([]);
  });

  test("admin POSTing a Schicht on an existing BS day is rejected (409/422)", async ({
    tenant,
  }) => {
    // Negative case — the CONTEXT D-03 invariant: server-side availability
    // bucket switch in shifts.ts:103-106 keeps BS days unassignable. The
    // canonical regression check is API-level (per T-81-09: Playwright
    // drag-and-drop is historically flaky, and what we actually want to verify
    // is the bucket switch, NOT the drag UI).
    const we = asWeTenant(tenant);
    const { employeeId } = await createShiftBasedAzubi(we, "Max");
    const date = nextTuesdayIso();
    await createWorkEventBs(we, employeeId, date);

    const res = await fetch(`${API_BASE}/api/v1/shifts`, {
      method: "POST",
      headers: authHeaders(we),
      body: JSON.stringify({
        employeeId,
        date,
        startTime: "09:00",
        endTime: "12:00",
        label: "Reguläre Schicht",
      }),
    });
    // 409 (SHIFT_CONFLICT_*) or 422 (ARBZG / bucket conflict) — both indicate
    // the bucket switch at shifts.ts:103-106 worked. The exact code depends on
    // the existing conflict resolution path; we assert NOT 201.
    expect(
      [409, 422],
      `Expected 409/422 for POST /shifts on BS day, got ${res.status}`,
    ).toContain(res.status);
  });
});

// ── Phase 82 helpers ──────────────────────────────────────────────────────────

/**
 * Sign the bootstrapped admin token into the browser session via localStorage.
 * Mirrors the loginWithToken pattern from time-entries-flow.spec.ts.
 */
async function loginWithToken(page: Page, token: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(({ t }) => {
    window.localStorage.setItem("clokr.auth.token", t);
  }, { t: token });
}

/**
 * Returns yesterday as YYYY-MM-DD (UTC). Ensures isFuture() guard in
 * MyWeekView returns false so the BS chip renders without suppression.
 */
function yesterdayIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the Monday of the current week (UTC) as YYYY-MM-DD.
 * Always in the past or today — never future — and always visible in the
 * MyWeekView week-strip whose cursorMonday starts at mondayOfWeek(new Date()).
 */
function thisWeekMondayIso(): string {
  const d = new Date();
  const dow = d.getUTCDay(); // 0=Sun
  const offset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setUTCDate(monday.getUTCDate() + offset);
  return monday.toISOString().slice(0, 10);
}

/**
 * Short label for the day-row anchor in MyWeekView (matches fmtShort(iso)).
 * Uses LOCAL time (same as the component) to build the "DD.MM." label.
 */
function fmtShort(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}.${m}.`;
}

/**
 * Returns the admin employee's ID for the bootstrapped tenant.
 * The bootstrap always seeds firstName="Admin", lastName="Test".
 */
async function getAdminEmployeeId(
  tenant: WorkEventVsTenant,
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/v1/employees`, {
    headers: { authorization: `Bearer ${tenant.adminToken}` },
  });
  if (!res.ok) throw new Error(`GET /employees failed: ${res.status}`);
  const list = (await res.json()) as Array<{ id: string; firstName: string; lastName: string }>;
  const admin = list.find((e) => e.firstName === "Admin" && e.lastName === "Test");
  if (!admin) throw new Error("Admin employee not found in bootstrap tenant");
  return admin.id;
}

// ── Phase 82 test describe block ─────────────────────────────────────────────

test.describe("Phase 82 — Consumer UI Touchpoints", () => {
  /**
   * UI-V19-07: /time-entries page does NOT call /vocational-school/* anymore.
   *
   * After Plan 82-02 lands, the page uses workEvents.loadMine() →
   * GET /api/v1/work-events/mine. This test asserts:
   *  1. Zero /vocational-school/* network requests during page load.
   *  2. At least one /work-events/mine GET fires (proves the URL swap landed).
   *  3. The BS cell is present in the calendar (cal-abs-vocational_school class).
   */
  test("UI-V19-07: /time-entries does NOT call /vocational-school/* (uses /work-events/mine)", async ({
    page,
    tenant,
  }) => {
    const we = asWeTenant(tenant);
    const adminEmpId = await getAdminEmployeeId(we);
    // Seed a BS WorkEvent for yesterday so the calendar cell renders without
    // isFuture() suppression. Use yesterdayIso() for consistency — the
    // /time-entries calendar renders the current month so yesterday is visible.
    const bsDate = yesterdayIso();
    await createWorkEventBs(we, adminEmpId, bsDate);

    // Attach network listener BEFORE navigation to catch all requests.
    const vsRequests: string[] = [];
    const workEventsMineUrls: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/v1/vocational-school/")) {
        vsRequests.push(`${req.method()} ${url}`);
      }
      if (url.includes("/api/v1/work-events/mine")) {
        workEventsMineUrls.push(url);
      }
    });

    await loginWithToken(page, tenant.adminToken);
    await page.goto("/time-entries");

    // Wait for the /work-events/mine GET to confirm the URL swap is live.
    // (If Plan 82-02 has NOT landed yet, this waitForResponse will timeout —
    //  intentional: the test gates on the post-plan-02 state.)
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/work-events/mine") && r.request().method() === "GET",
      { timeout: 15_000 },
    );

    // Network guard: no /vocational-school/* requests.
    expect(
      vsRequests,
      "Expected ZERO /vocational-school/* requests — UI-V19-07 regression guard",
    ).toEqual([]);

    // Positive guard: /work-events/mine was called.
    expect(
      workEventsMineUrls.length,
      "Expected at least one /work-events/mine GET",
    ).toBeGreaterThan(0);

    // Visual guard: the BS calendar cell is visible (cal-abs-vocational_school).
    // The cell appears in the month view for bsDate. Since yesterday is in the
    // current month, navigate to the current month (default view).
    const bsCell = page.locator(".cal-cell.cal-abs-vocational_school");
    await expect(bsCell.first()).toBeVisible({ timeout: 10_000 });
  });

  /**
   * UI-V19-08: /team/time-entries calls /work-events?employeeId= (not /mine).
   *
   * After Plan 82-03 lands, the management page uses workEvents.loadByEmployee()
   * → GET /api/v1/work-events?employeeId=<selected>. This test asserts:
   *  1. At least one /work-events?employeeId= GET fires after employee selection.
   *  2. Zero /work-events/mine URLs fire on this management page.
   *  3. The BS cell is present in the management calendar after employee selection.
   */
  test("UI-V19-08: /team/time-entries calls /work-events?employeeId= (not /mine)", async ({
    page,
    tenant,
  }) => {
    const we = asWeTenant(tenant);
    // Create a FIXED_SCHEDULE Azubi for the management view.
    const stamp = Date.now().toString().slice(-8);
    const createRes = await fetch(`${API_BASE}/api/v1/employees`, {
      method: "POST",
      headers: authHeaders(we),
      body: JSON.stringify({
        firstName: "KlausBS",
        lastName: "Azubi",
        email: `azubi-v08-${stamp}@${we.tenantId}.test`,
        employeeNumber: `AZ-V08-${stamp}`,
        hireDate: new Date().toISOString(),
        role: "EMPLOYEE",
        classification: "AZUBI",
        scheduleType: "FIXED_WEEKLY",
        weeklyHours: 40,
        workDays: [1, 2, 3, 4, 5],
      }),
    });
    if (!createRes.ok) throw new Error(`Create employee failed: ${createRes.status}`);
    const { id: azubiId } = (await createRes.json()) as { id: string };

    const bsDate = yesterdayIso();
    await createWorkEventBs(we, azubiId, bsDate);

    // Attach network listener BEFORE navigation.
    const workEventsMineUrls: string[] = [];
    const workEventsByEmpUrls: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/v1/work-events/mine")) {
        workEventsMineUrls.push(url);
      }
      if (url.includes("/api/v1/work-events") && url.includes("employeeId=")) {
        workEventsByEmpUrls.push(url);
      }
    });

    await loginWithToken(page, tenant.adminToken);
    await page.goto("/team/time-entries");

    // The employee combobox uses .emp-input-wrap to open; .emp-dropdown-item
    // to pick (role="option" inside role="listbox" .emp-dropdown). Select the
    // Azubi named "KlausBS Azubi".
    const empInputWrap = page.locator(".emp-input-wrap").first();
    await empInputWrap.click();
    // Wait for the dropdown to open (listbox appears).
    const listbox = page.locator("[role='listbox'].emp-dropdown");
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    // Select the Azubi option.
    const azubiOption = page.locator("[role='option']").filter({ hasText: "KlausBS" });
    await azubiOption.click();

    // After employee selection, the page fetches /work-events?employeeId=<azubiId>.
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/work-events") &&
        r.url().includes(`employeeId=${azubiId}`) &&
        r.request().method() === "GET",
      { timeout: 15_000 },
    );

    // Guard: /work-events?employeeId= was called (management endpoint).
    expect(
      workEventsByEmpUrls.some((u) => u.includes(`employeeId=${azubiId}`)),
      "Expected /work-events?employeeId= GET on /team/time-entries — UI-V19-08",
    ).toBe(true);

    // Guard: /work-events/mine was NOT called (self-view endpoint must not appear).
    expect(
      workEventsMineUrls,
      "Expected ZERO /work-events/mine on the management page — UI-V19-08 regression guard",
    ).toEqual([]);

    // Visual guard: BS cell is visible in the management calendar.
    const bsCell = page.locator(".cal-cell.cal-abs-vocational_school");
    await expect(bsCell.first()).toBeVisible({ timeout: 10_000 });
  });

  /**
   * UI-V19-09: Dashboard ↔ /time-entries calendar parity (PITFALLS.md U-2).
   *
   * The same seeded BS date must appear as:
   *  (a) a .bs-chip in the MyWeekView week-strip on /dashboard
   *  (b) a .cal-abs-vocational_school cell in the /time-entries calendar
   *
   * Both surfaces share the same data source (/work-events/mine) after Phase 82.
   * This test structurally prevents the multi-surface drift described in
   * PITFALLS.md U-2: "calendar shows BS but dashboard doesn't, or vice versa."
   */
  test("UI-V19-09: dashboard BS chip and /time-entries BS cell match for the same date", async ({
    page,
    tenant,
  }) => {
    const we = asWeTenant(tenant);
    const adminEmpId = await getAdminEmployeeId(we);

    // Use the Monday of the current week — always visible in the dashboard
    // week-strip (cursorMonday defaults to mondayOfWeek(new Date())) and
    // never suppressed by isFuture() since Monday ≤ today.
    const bsDate = thisWeekMondayIso();
    await createWorkEventBs(we, adminEmpId, bsDate);

    // ── Step 1: Dashboard ────────────────────────────────────────────
    await loginWithToken(page, tenant.adminToken);
    await page.goto("/dashboard");

    // Wait for the /work-events/mine GET from MyWeekView (Task 1 of this plan).
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/work-events/mine") && r.request().method() === "GET",
      { timeout: 15_000 },
    );

    // The BS chip (.bs-chip) should be visible in the day-row matching bsDate.
    // Selector: find the .day-row whose .date span contains the short label
    // "DD.MM." matching bsDate, then assert .bs-chip is inside it.
    // fmtShort replicates the component's fmtShort helper (DD.MM. format).
    const dayLabel = fmtShort(bsDate);
    const bsDayRow = page.locator(".day-row").filter({ hasText: dayLabel });
    const bsChip = bsDayRow.locator(".bs-chip");
    await expect(bsChip).toBeVisible({ timeout: 10_000 });
    await expect(bsChip).toHaveText("BS");

    // ── Step 2: /time-entries calendar ───────────────────────────────
    await page.goto("/time-entries");

    // Wait for the /work-events/mine GET from /time-entries (Plan 82-02).
    await page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/work-events/mine") && r.request().method() === "GET",
      { timeout: 15_000 },
    );

    // The calendar cell for bsDate must have the cal-abs-vocational_school class.
    // bsDate is in the current month so the default calendar view shows it.
    const bsCalCell = page.locator(".cal-cell.cal-abs-vocational_school");
    await expect(bsCalCell.first()).toBeVisible({ timeout: 10_000 });
  });
});
