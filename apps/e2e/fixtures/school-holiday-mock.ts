/**
 * Playwright route interceptor for the SchoolHolidays integration.
 *
 * Phase 67.2 introduced KMK-Ferien integration (live `ferienapi.de` /
 * OpenHolidays API → cached per-tenant `SchoolHolidayPeriod` rows). The
 * BS-Pattern generator relies on this data to skip Berufsschultage that fall
 * inside school-holiday windows.
 *
 * Threat T-74-02-01 (Tampering) mitigation: production code calls the live
 * upstream API on a weekly cron + on-demand sync. Letting the E2E suite hit
 * the live API is unacceptable for two reasons:
 *
 *   1. Tests would flake on upstream outages / format changes (T-74-03).
 *   2. Tests would be non-deterministic across CI runs (different years
 *      produce different Ferien windows).
 *
 * This fixture installs a Playwright `page.route()` interceptor that fulfils
 * every `/api/v1/school-holidays/**` request with deterministic, in-memory
 * windows keyed by federal state. The mock is opt-in per test via
 * `mockSchoolHolidayAPI()` — no global beforeAll wiring, so plans that need
 * to test the live integration (none currently) can simply skip calling it.
 *
 * The mock lives in `apps/e2e/fixtures/` — it is NEVER imported by
 * `apps/web` or `apps/api`, so it cannot leak into a production build
 * (T-74-02-02 disposition: accept).
 *
 * Reusable across other azubi-related specs in future phases.
 */

import type { Page } from "@playwright/test";

/**
 * One Schulferien window (matches the API response shape used by the
 * `/api/v1/school-holidays` endpoint per Phase 67.2).
 */
export interface SchoolHolidayWindow {
  /** Slug-style identifier, e.g. "herbstferien-2026". Stable across CI runs. */
  name: string;
  /** Inclusive start date, format YYYY-MM-DD. */
  startDate: string;
  /** Inclusive end date, format YYYY-MM-DD. */
  endDate: string;
  /** ISO-3166-2 federal state code, e.g. "NW" for Nordrhein-Westfalen. */
  federalState: string;
}

/**
 * NW (Nordrhein-Westfalen) Schulferien for tests. The Herbstferien window
 * covers Oct 12–24 2026 so a Tuesday (Oct 13) falls inside it and a Tuesday
 * a week earlier (Oct 06) does not — both are referenced by the BS-Pattern
 * Schulferien-skip test case.
 */
export const MOCK_HOLIDAYS_NW: SchoolHolidayWindow[] = [
  {
    name: "herbstferien-2026",
    startDate: "2026-10-12",
    endDate: "2026-10-24",
    federalState: "NW",
  },
  {
    name: "weihnachtsferien-2026",
    startDate: "2026-12-23",
    endDate: "2027-01-06",
    federalState: "NW",
  },
];

/**
 * BY (Bayern) Schulferien for tests. The Herbstferien window is Nov 02–06
 * 2026, deliberately disjoint from NW's window so the
 * `federalStateOverride` test case can prove the override actually changes
 * which Ferien-window applies to a given BS-Pattern.
 */
export const MOCK_HOLIDAYS_BY: SchoolHolidayWindow[] = [
  {
    name: "herbstferien-2026",
    startDate: "2026-11-02",
    endDate: "2026-11-06",
    federalState: "BY",
  },
];

/**
 * Install the mock on a Playwright page.
 *
 * The interceptor matches `/api/v1/school-holidays/**` (both the cached
 * `GET /api/v1/school-holidays?federalState=...` query and any per-tenant
 * admin sub-routes). It inspects the `federalState` query parameter, falls
 * back to NW if missing, and fulfils with the corresponding window list as
 * JSON. Returns immediately if no entry exists for the requested state
 * (empty array — semantically "no Schulferien known").
 *
 * Must be called BEFORE the page navigates to a route that triggers the
 * underlying API call. Playwright's `page.route()` is per-page state, so
 * each test that needs the mock should install it in `beforeEach`.
 *
 * @example
 *   test.beforeEach(async ({ page }) => {
 *     await mockSchoolHolidayAPI(page, {
 *       NW: MOCK_HOLIDAYS_NW,
 *       BY: MOCK_HOLIDAYS_BY,
 *     });
 *   });
 */
export async function mockSchoolHolidayAPI(
  page: Page,
  perState: Record<string, SchoolHolidayWindow[]>,
): Promise<void> {
  await page.route("**/api/v1/school-holidays/**", async (route) => {
    const url = new URL(route.request().url());
    const state = url.searchParams.get("federalState") ?? "NW";
    const data = perState[state] ?? [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });

  // Also intercept the bare `/api/v1/school-holidays` collection endpoint so
  // tests that omit the federalState param (admin overview) still get a
  // deterministic response. The default `NW` fall-through covers the case.
  await page.route("**/api/v1/school-holidays", async (route) => {
    const url = new URL(route.request().url());
    const state = url.searchParams.get("federalState") ?? "NW";
    const data = perState[state] ?? [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
}
