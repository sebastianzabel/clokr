/**
 * Retroactive BS-Pattern wizard — E2E spec (Phase 103 plan 06).
 *
 * Walks `RetroactiveBSWizard.svelte` (Phase 103 plan 04) end to end against the real
 * `/vocational-school/retroactive-preview` + `/retroactive-apply` endpoints (plan 03) through
 * the admin employee detail page's actual save flow — not a mocked/synthetic preview.
 *
 * Deliberately independent of `apps/e2e/tests/bs-pattern.spec.ts` and its
 * `bs-pattern-*`/`bs-day-*` testids: `deferred-items.md` §6 (plan 02) confirmed by execution
 * that none of those testids exist in the current admin markup. This spec is built ONLY on:
 *   - `apps/e2e/helpers/bs-pattern.ts`'s `createAzubiEmployee()` / `seedBSPattern()` — pure
 *     `fetch()`-based API setup against current, verified-live endpoints.
 *   - The wizard's own `bs-retro-*` testid contract (103-04-SUMMARY.md), which does exist.
 *   - Plain-text/role locators for the BS-pattern editor's weekday chips and Speichern
 *     button — that editor carries NO `data-testid`s at all (verified by a live grep before
 *     writing this spec), so text/role locators are the only stable option there.
 *
 * Every date is computed relative to the run date — never a hardcoded absolute calendar date
 * (this project has a documented history of date-hardcoded e2e tests expiring into false
 * failures, see project memory "API test time-bombs").
 *
 * Setup detail worth calling out: `createAzubiEmployee()`'s default `hireDate` is "today",
 * which would make every backdated BS day fall before hire (`preHire` skip swallows the whole
 * scenario). This spec passes an explicit past `hireDate` — the one deviation from the helper's
 * out-of-the-box defaults, added to `CreateAzubiOpts` in this same plan (Rule 3 — blocking for
 * every scenario below, not just one).
 *
 * "Some already-generated BS days" in the past (the pre-condition every scenario needs, mirroring
 * 103-BEFUND.md's real prod shape) is produced by calling the already-tested
 * `POST /vocational-school/retroactive-apply` endpoint directly once, right after seeding the
 * FIRST pattern — a legitimate use of the feature under test to arrange fixture state, not a
 * hidden shortcut around it. The actual pattern CHANGE under test always happens through real
 * browser interaction with the admin employee detail page afterwards.
 *
 * Browser auth strategy — deliberately NOT `storageState: ".auth/admin.json"` (the
 * `desktop-chrome`/`mobile-chrome`/`tablet` projects' default, `auth.setup.ts`-driven session):
 * that session belongs to a single, statically-seeded dev-stack tenant, while `createAzubiEmployee`
 * creates the fixture inside a FRESH, isolated `tenant` (Phase 73 bootstrap). Navigating a
 * `.auth/admin.json` session to a bootstrap-tenant employee 404s ("Mitarbeiter nicht gefunden") —
 * confirmed by execution against a properly-provisioned local stack while writing this spec, and
 * already independently documented as a known incompatibility by `apps/e2e/tests/visual.spec.ts`'s
 * own header comment for its own project family. This spec reuses THAT project's already-working
 * fix instead of reinventing one: log the bootstrapped tenant's own admin in via a real
 * `POST /auth/login` call and hydrate the SvelteKit auth store through `addInitScript` — the exact
 * technique `apps/e2e/fixtures/visual-seed.ts` + `visual.spec.ts` already use. See
 * `deferred-items.md` for the full writeup of why this was necessary.
 */

import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import type { Page } from "@playwright/test";
import { createAzubiEmployee, seedBSPattern } from "../helpers/bs-pattern";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

function asPatternTenant(tenant: TestTenant): { tenantId: string; adminToken: string } {
  return { tenantId: tenant.tenantId, adminToken: tenant.adminToken };
}

interface BrowserAuthResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    role: "ADMIN" | "MANAGER" | "EMPLOYEE";
    employeeId: string | null;
    firstName?: string;
  };
}

/**
 * Logs the BROWSER in as the bootstrapped tenant's own admin (`admin@{tenantId}.test` /
 * the fixed bootstrap password — see `apps/api/src/routes/test-bootstrap.ts`'s `TEST_PASSWORD`),
 * then hydrates the SvelteKit auth store via `addInitScript` before any navigation. Must be
 * called before the first `page.goto()` in each test.
 */
async function loginBrowserAsTenantAdmin(page: Page, tenantId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `admin@${tenantId}.test`, password: "test1234" }),
  });
  if (!res.ok) {
    throw new Error(
      `loginBrowserAsTenantAdmin: ${res.status} — ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as BrowserAuthResponse;
  await page.addInitScript(
    ({ accessToken, refreshToken, user }) => {
      try {
        localStorage.setItem("accessToken", accessToken);
        localStorage.setItem("refreshToken", refreshToken);
        localStorage.setItem("user", JSON.stringify(user));
      } catch {
        /* localStorage may be locked in some contexts — auth store falls back to logged-out */
      }
    },
    { accessToken: body.accessToken, refreshToken: body.refreshToken, user: body.user },
  );
}

function authHeaders(t: { adminToken: string }): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${t.adminToken}` };
}

// Schema convention (103-BEFUND.md, `dowMondayBased` in vocational-school-generator.ts):
// 0 = Montag .. 6 = Sonntag. Matches BS_WEEKDAY_LABELS in the admin employee page verbatim.
const WEEKDAY_LABELS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Schema-convention weekday (0=Mo..6=So) for a UTC-midnight date. */
function schemaWeekday(d: Date): number {
  const js = d.getUTCDay(); // 0=Sun..6=Sat
  return js === 0 ? 6 : js - 1;
}

/** First date on or after `start` whose schema weekday matches `weekday`. */
function firstOccurrenceOnOrAfter(start: Date, weekday: number): Date {
  let d = start;
  while (schemaWeekday(d) !== weekday) d = addDays(d, 1);
  return d;
}

async function createTimeEntry(
  tenant: { adminToken: string },
  employeeId: string,
  dateIso: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/time-entries`, {
    method: "POST",
    headers: authHeaders(tenant),
    body: JSON.stringify({
      employeeId,
      date: dateIso,
      startTime: `${dateIso}T08:00:00.000Z`,
      endTime: `${dateIso}T16:00:00.000Z`,
      breakMinutes: 30,
    }),
  });
  if (!res.ok) {
    throw new Error(`createTimeEntry: ${res.status} — ${await res.text().catch(() => "")}`);
  }
}

async function applyRetroactiveDirect(
  tenant: { adminToken: string },
  employeeId: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/vocational-school/retroactive-apply`, {
    method: "POST",
    headers: authHeaders(tenant),
    body: JSON.stringify({ employeeId, overrideDates: null }),
  });
  if (!res.ok) {
    throw new Error(`applyRetroactiveDirect: ${res.status} — ${await res.text().catch(() => "")}`);
  }
}

interface UpcomingRow {
  id: string;
  employeeId: string;
  date: string;
  source: string;
}

async function fetchUpcoming(
  tenant: { adminToken: string },
  employeeId: string,
  from: string,
  to: string,
): Promise<UpcomingRow[]> {
  const url = `${API_BASE}/api/v1/vocational-school/upcoming?from=${from}&to=${to}&employeeId=${employeeId}`;
  const res = await fetch(url, { headers: authHeaders(tenant) });
  if (!res.ok) {
    throw new Error(`fetchUpcoming: ${res.status} — ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

interface TimeEntryRow {
  id: string;
  date: string;
  startTime: string;
  endTime: string | null;
}

async function fetchTimeEntries(
  tenant: { adminToken: string },
  employeeId: string,
  from: string,
  to: string,
): Promise<TimeEntryRow[]> {
  const url = `${API_BASE}/api/v1/time-entries?from=${from}&to=${to}&employeeId=${employeeId}`;
  const res = await fetch(url, { headers: authHeaders(tenant) });
  if (!res.ok) {
    throw new Error(`fetchTimeEntries: ${res.status} — ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

test.describe("Retroactive BS-Pattern wizard", () => {
  test("conflict-free path: two clicks, step 2 never enters the DOM (D-02)", async ({
    page,
    tenant,
  }) => {
    test.setTimeout(45_000);
    const pt = asPatternTenant(tenant);

    const today = todayUtcMidnight();
    const validFromDate = addDays(today, -42);
    const validFromIso = isoDate(validFromDate);
    const hireDateIso = isoDate(addDays(today, -60));
    const todayIso = isoDate(today);

    const dayA = schemaWeekday(validFromDate);
    const dayB = (dayA + 2) % 7;

    const { employeeId } = await createAzubiEmployee(pt, { hireDate: hireDateIso });
    await seedBSPattern(pt, employeeId, {
      mode: "WEEKLY",
      validFrom: validFromIso,
      weeklyDays: [dayA],
      // Real school-holiday integration is out of scope here and would make the
      // scenario's create/remove counts depend on the real calendar (e.g. summer break) —
      // opt out so the retroactive diff is deterministic year-round.
      respectSchoolHolidays: false,
    });
    // Backfill "already generated" past BS days for the OLD pattern — see file header.
    await applyRetroactiveDirect(pt, employeeId);

    await loginBrowserAsTenantAdmin(page, tenant.tenantId);
    await page.goto(`/admin/employees/${employeeId}#arbeitszeit`);

    const bsSection = page
      .locator("section")
      .filter({ has: page.locator(".section-title", { hasText: "Berufsschultag (Optional)" }) });

    // Wait for the pattern to hydrate before touching chips.
    await expect(
      bsSection.locator(".bs-chip-row button", {
        hasText: new RegExp(`^${WEEKDAY_LABELS[dayA]}$`),
      }),
    ).toHaveClass(/chip-brand/);
    await expect(page.getByTestId("bs-retro-step-2")).not.toBeAttached();

    await bsSection
      .locator(".bs-chip-row button", { hasText: new RegExp(`^${WEEKDAY_LABELS[dayA]}$`) })
      .click();
    await bsSection
      .locator(".bs-chip-row button", { hasText: new RegExp(`^${WEEKDAY_LABELS[dayB]}$`) })
      .click();
    await bsSection.getByRole("button", { name: /^Speichern/ }).click();

    // Toast success is transient (2s auto-dismiss) and can race the async retroactive-
    // preview fetch that follows it; the wizard's own correct appearance below is a
    // strictly stronger proof the save succeeded, so the toast is not asserted here.

    await expect(page.getByTestId("bs-retro-dialog")).toBeVisible();
    await expect(page.locator(".modal-eyebrow")).toHaveText("Schritt 1 von 2");
    await expect(page.getByTestId("bs-retro-summary")).toHaveText(/entf(ällt|allen)/);
    await expect(page.getByTestId("bs-retro-summary")).toHaveText(/(kommt hinzu|kommen hinzu)/);
    await expect(page.getByTestId("bs-retro-step-2")).not.toBeAttached();

    await page.getByTestId("bs-retro-next").click();
    await expect(page.getByTestId("bs-retro-step-3")).toBeVisible();
    await expect(page.getByTestId("bs-retro-step-2")).not.toBeAttached();

    await page.getByTestId("bs-retro-confirm").click();
    await expect(page.getByTestId("bs-retro-result")).toBeVisible();

    const upcoming = await fetchUpcoming(pt, employeeId, validFromIso, todayIso);
    expect(upcoming.some((r) => schemaWeekday(new Date(`${r.date}T00:00:00.000Z`)) === dayA)).toBe(
      false,
    );
    expect(upcoming.some((r) => schemaWeekday(new Date(`${r.date}T00:00:00.000Z`)) === dayB)).toBe(
      true,
    );
  });

  test("conflict path: TimeEntry day defaults to Überspringen and is left untouched (D-05/D-07)", async ({
    page,
    tenant,
  }) => {
    test.setTimeout(45_000);
    const pt = asPatternTenant(tenant);

    const today = todayUtcMidnight();
    const validFromDate = addDays(today, -42);
    const validFromIso = isoDate(validFromDate);
    const hireDateIso = isoDate(addDays(today, -60));
    const todayIso = isoDate(today);

    const dayA = schemaWeekday(validFromDate);
    const dayB = (dayA + 2) % 7;

    const { employeeId } = await createAzubiEmployee(pt, { hireDate: hireDateIso });
    await seedBSPattern(pt, employeeId, {
      mode: "WEEKLY",
      validFrom: validFromIso,
      weeklyDays: [dayA],
      // Real school-holiday integration is out of scope here and would make the
      // scenario's create/remove counts depend on the real calendar (e.g. summer break) —
      // opt out so the retroactive diff is deterministic year-round.
      respectSchoolHolidays: false,
    });
    await applyRetroactiveDirect(pt, employeeId);

    // Second occurrence of the NEW weekday, comfortably inside the window — the day the
    // switched pattern would newly claim, and where a TimeEntry already exists.
    const conflictDate = addDays(firstOccurrenceOnOrAfter(validFromDate, dayB), 7);
    const conflictDateIso = isoDate(conflictDate);
    await createTimeEntry(pt, employeeId, conflictDateIso);

    await loginBrowserAsTenantAdmin(page, tenant.tenantId);
    await page.goto(`/admin/employees/${employeeId}#arbeitszeit`);
    const bsSection = page
      .locator("section")
      .filter({ has: page.locator(".section-title", { hasText: "Berufsschultag (Optional)" }) });
    await expect(
      bsSection.locator(".bs-chip-row button", {
        hasText: new RegExp(`^${WEEKDAY_LABELS[dayA]}$`),
      }),
    ).toHaveClass(/chip-brand/);

    await bsSection
      .locator(".bs-chip-row button", { hasText: new RegExp(`^${WEEKDAY_LABELS[dayA]}$`) })
      .click();
    await bsSection
      .locator(".bs-chip-row button", { hasText: new RegExp(`^${WEEKDAY_LABELS[dayB]}$`) })
      .click();
    await bsSection.getByRole("button", { name: /^Speichern/ }).click();
    // Toast success is transient (2s auto-dismiss) and can race the async retroactive-
    // preview fetch that follows it; the wizard's own correct appearance below is a
    // strictly stronger proof the save succeeded, so the toast is not asserted here.

    await expect(page.getByTestId("bs-retro-dialog")).toBeVisible();
    await expect(page.locator(".modal-eyebrow")).toHaveText("Schritt 1 von 3");
    await expect(page.getByTestId("bs-retro-conflict-teaser")).toBeVisible();

    await page.getByTestId("bs-retro-next").click();
    await expect(page.getByTestId("bs-retro-step-2")).toBeVisible();

    const conflictRow = page.getByTestId(`bs-retro-conflict-row-${conflictDateIso}`);
    await expect(conflictRow).toBeVisible();
    expect(await page.getByTestId(`bs-retro-conflict-row-${conflictDateIso}`).count()).toBe(1);
    const toggle = page.getByTestId(`bs-retro-conflict-toggle-${conflictDateIso}`);
    await expect(toggle.getByRole("radio", { name: "Überspringen" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await page.getByTestId("bs-retro-next").click();
    await page.getByTestId("bs-retro-confirm").click();
    await expect(page.getByTestId("bs-retro-result")).toBeVisible();

    const upcoming = await fetchUpcoming(pt, employeeId, validFromIso, todayIso);
    expect(upcoming.some((r) => r.date === conflictDateIso)).toBe(false);

    const entries = await fetchTimeEntries(pt, employeeId, conflictDateIso, conflictDateIso);
    expect(entries).toHaveLength(1);
    expect(entries[0].date.slice(0, 10)).toBe(conflictDateIso);
  });

  test("override path: bulk-apply creates the BS day without touching the TimeEntry (D-06)", async ({
    page,
    tenant,
  }) => {
    test.setTimeout(45_000);
    const pt = asPatternTenant(tenant);

    const today = todayUtcMidnight();
    const validFromDate = addDays(today, -42);
    const validFromIso = isoDate(validFromDate);
    const hireDateIso = isoDate(addDays(today, -60));
    const todayIso = isoDate(today);

    const dayA = schemaWeekday(validFromDate);
    const dayB = (dayA + 2) % 7;

    const { employeeId } = await createAzubiEmployee(pt, { hireDate: hireDateIso });
    await seedBSPattern(pt, employeeId, {
      mode: "WEEKLY",
      validFrom: validFromIso,
      weeklyDays: [dayA],
      // Real school-holiday integration is out of scope here and would make the
      // scenario's create/remove counts depend on the real calendar (e.g. summer break) —
      // opt out so the retroactive diff is deterministic year-round.
      respectSchoolHolidays: false,
    });
    await applyRetroactiveDirect(pt, employeeId);

    const conflictDate = addDays(firstOccurrenceOnOrAfter(validFromDate, dayB), 7);
    const conflictDateIso = isoDate(conflictDate);
    await createTimeEntry(pt, employeeId, conflictDateIso);

    await loginBrowserAsTenantAdmin(page, tenant.tenantId);
    await page.goto(`/admin/employees/${employeeId}#arbeitszeit`);
    const bsSection = page
      .locator("section")
      .filter({ has: page.locator(".section-title", { hasText: "Berufsschultag (Optional)" }) });
    await expect(
      bsSection.locator(".bs-chip-row button", {
        hasText: new RegExp(`^${WEEKDAY_LABELS[dayA]}$`),
      }),
    ).toHaveClass(/chip-brand/);

    await bsSection
      .locator(".bs-chip-row button", { hasText: new RegExp(`^${WEEKDAY_LABELS[dayA]}$`) })
      .click();
    await bsSection
      .locator(".bs-chip-row button", { hasText: new RegExp(`^${WEEKDAY_LABELS[dayB]}$`) })
      .click();
    await bsSection.getByRole("button", { name: /^Speichern/ }).click();
    // Toast success is transient (2s auto-dismiss) and can race the async retroactive-
    // preview fetch that follows it; the wizard's own correct appearance below is a
    // strictly stronger proof the save succeeded, so the toast is not asserted here.

    await expect(page.getByTestId("bs-retro-dialog")).toBeVisible();
    await page.getByTestId("bs-retro-next").click();
    await expect(page.getByTestId("bs-retro-step-2")).toBeVisible();

    await page.getByTestId("bs-retro-bulk-apply").click();
    await expect(page.getByTestId("bs-retro-override-warning")).toBeVisible();
    const toggle = page.getByTestId(`bs-retro-conflict-toggle-${conflictDateIso}`);
    await expect(toggle.getByRole("radio", { name: "Übernehmen" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await page.getByTestId("bs-retro-next").click();
    await page.getByTestId("bs-retro-confirm").click();
    await expect(page.getByTestId("bs-retro-result")).toBeVisible();

    const upcoming = await fetchUpcoming(pt, employeeId, validFromIso, todayIso);
    expect(upcoming.some((r) => r.date === conflictDateIso)).toBe(true);

    const entries = await fetchTimeEntries(pt, employeeId, conflictDateIso, conflictDateIso);
    expect(entries).toHaveLength(1);
    expect(entries[0].date.slice(0, 10)).toBe(conflictDateIso);
  });

  test("no-op path: a purely-forward validFrom never opens the dialog (D-01)", async ({
    page,
    tenant,
  }) => {
    test.setTimeout(30_000);
    const pt = asPatternTenant(tenant);

    const today = todayUtcMidnight();
    const futureValidFromIso = isoDate(addDays(today, 30));
    const dayA = schemaWeekday(addDays(today, 30));

    const { employeeId } = await createAzubiEmployee(pt, {});
    await seedBSPattern(pt, employeeId, {
      mode: "WEEKLY",
      validFrom: futureValidFromIso,
      weeklyDays: [dayA],
      // Real school-holiday integration is out of scope here and would make the
      // scenario's create/remove counts depend on the real calendar (e.g. summer break) —
      // opt out so the retroactive diff is deterministic year-round.
      respectSchoolHolidays: false,
    });

    await loginBrowserAsTenantAdmin(page, tenant.tenantId);
    await page.goto(`/admin/employees/${employeeId}#arbeitszeit`);
    const bsSection = page
      .locator("section")
      .filter({ has: page.locator(".section-title", { hasText: "Berufsschultag (Optional)" }) });
    await expect(
      bsSection.locator(".bs-chip-row button", {
        hasText: new RegExp(`^${WEEKDAY_LABELS[dayA]}$`),
      }),
    ).toHaveClass(/chip-brand/);

    // No field changes — a plain re-save of an already-future pattern must stay silent.
    // Toast.svelte carries no data-testid (confirmed by a live grep — 0 hits repo-wide);
    // `.toast-success` is the component's own real class, per its `class="toast toast-{type}"`.
    await bsSection.getByRole("button", { name: /^Speichern/ }).click();
    await expect(page.locator(".toast-success")).toContainText("Berufsschultage gespeichert");
    await expect(page.getByTestId("bs-retro-dialog")).not.toBeAttached();
  });
});
