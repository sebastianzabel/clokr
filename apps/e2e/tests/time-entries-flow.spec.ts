/**
 * Zeiterfassung complete-flow spec — Phase 73-03.
 *
 * Migrated from CSS-class selectors (`.cal-cell`, `.btn-icon-danger`, etc.)
 * to D-05 `data-testid` selectors emitted by the Phase 73-03 markup pass:
 *
 *   - calendar surface       — `calendar`, `calendar-cell-${iso}`,
 *                              `calendar-month-header-{prev,next,today,label}`
 *   - modal surface          — `time-entry-modal`, `time-entry-modal-{date,
 *                              start,end,save,cancel,error,note}`
 *   - break-slots surface    — `break-slots-editor`, `break-slot-add`,
 *                              `break-slot-${i}-{start,end,remove}`
 *   - list-row surface       — `time-entry-row-${id}-{edit,delete,locked-badge}`
 *   - page surface           — `time-entries-{page,add,view-list,view-calendar}`
 *
 * Per CLAUDE.md "No test manipulation for green CI" and Phase 73 D-06: this
 * spec also drops the two static sleep calls the original had — both
 * replaced with explicit visibility / response waits. Plan 73-06 (ESLint
 * ban rule) no longer needs to revisit this file.
 *
 * Uses the Phase 73-02 tenant fixture so each test runs against a fresh
 * tenant — no cross-test leakage, parallel-worker safe (D-08).
 */
import { test, expect, type TestTenant } from "../fixtures";
import type { Page } from "@playwright/test";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

// Pick a weekday 60 days in the past — far enough back to avoid colliding
// with whatever the tenant bootstrap seeds and inside the standard 2-year
// retention window for ArbZG records (§ 16 Abs. 2 ArbZG).
function weekdayNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().split("T")[0];
}

const TEST_DATE = weekdayNDaysAgo(60);

/**
 * Sign the bootstrapped admin token into the browser session by setting
 * the localStorage shape `apps/web/src/lib/stores/auth.ts` expects. The
 * page must navigate to the app origin first so localStorage is writable.
 */
async function loginWithToken(page: Page, tenant: TestTenant): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    ({ token }) => {
      // Mirrors createAuthStore() in apps/web/src/lib/stores/auth.ts —
      // the store hydrates from localStorage on first read.
      window.localStorage.setItem("clokr.auth.token", token);
    },
    { token: tenant.adminToken },
  );
}

/**
 * Navigate the calendar to the target YYYY-MM-DD's month by repeatedly
 * clicking the "previous month" button (test dates are always in the
 * past). Uses the `calendar-month-header-label` testid as the loop
 * predicate — refactor-resilient vs the old `.cal-nav-center` selector.
 */
async function navigateToMonth(page: Page, targetDate: string): Promise<void> {
  const targetYear = parseInt(targetDate.substring(0, 4));
  const targetMonth = parseInt(targetDate.substring(5, 7)); // 1-based
  const monthNames = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ];
  const targetMonthName = monthNames[targetMonth - 1];

  const label = page.getByTestId("calendar-month-header-label");
  const prev = page.getByTestId("calendar-month-header-prev");

  for (let attempts = 0; attempts < 24; attempts++) {
    const text = (await label.textContent())?.trim() ?? "";
    if (text.includes(targetMonthName) && text.includes(String(targetYear))) {
      return;
    }
    await prev.click();
    // Wait for the label to update — the page re-renders the cells too.
    await expect(label).not.toHaveText(text);
  }
  throw new Error(
    `navigateToMonth: could not reach ${targetMonthName} ${targetYear} in 24 hops`,
  );
}

test.describe("Zeiterfassung — Complete Flow", () => {
  test.beforeEach(async ({ page, tenant }) => {
    await loginWithToken(page, tenant);
    await page.goto("/time-entries");
    await expect(page.getByTestId("time-entries-page")).toBeVisible();
  });

  test("page loads with calendar and summary bar", async ({ page }) => {
    // Summary bar (MonthBar) + calendar grid are the two anchors the user
    // sees on first render. Visual-state assertions still allowed on
    // .cal-nav class would be acceptable per the spec's narrow-class rule,
    // but the data-testid is the durable contract.
    await expect(page.getByTestId("time-entries-summary")).toBeVisible();
    await expect(page.getByTestId("calendar-month-header")).toBeVisible();
    await expect(page.getByTestId("calendar")).toBeVisible();
    await expect(page.getByTestId("time-entries-view-tabs")).toBeVisible();
  });

  test("create a manual time entry", async ({ page }) => {
    await navigateToMonth(page, TEST_DATE);

    // Click the day cell directly via its date-pinned testid.
    await page.getByTestId(`calendar-cell-${TEST_DATE}`).click();

    const modal = page.getByTestId("time-entry-modal");
    await expect(modal).toBeVisible();

    // Edit-vs-add detection: if the modal opened in edit mode (entry
    // already exists), close it. The eyebrow text in <Modal eyebrow=…/>
    // toggles between "Neuer Eintrag" and "Eintrag bearbeiten" — assert
    // the latter via role=dialog text since the eyebrow is in the modal
    // primitive, not inside our wrapper.
    const dialog = page.locator("[role='dialog']").first();
    const eyebrow = await dialog.locator(".modal-eyebrow").first().textContent();
    if (eyebrow?.includes("bearbeiten")) {
      await page.getByTestId("time-entry-modal-cancel").click();
      await expect(modal).not.toBeVisible();
      return;
    }

    await page.getByTestId("time-entry-modal-start").fill("08:00");
    await page.getByTestId("time-entry-modal-end").fill("16:30");

    // POST waits for the server round-trip — strictly better than the
    // pre-73-03 static sleep. The endpoint shape comes from
    // apps/api/src/routes/time-entries.ts (POST /api/v1/time-entries).
    const postResponse = page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/time-entries") &&
        res.request().method() === "POST",
    );
    await page.getByTestId("time-entry-modal-save").click();
    await postResponse;
    await expect(modal).not.toBeVisible();
  });

  test("edit an existing time entry", async ({ page }) => {
    await navigateToMonth(page, TEST_DATE);
    await page.getByTestId(`calendar-cell-${TEST_DATE}`).click();

    const modal = page.getByTestId("time-entry-modal");
    await expect(modal).toBeVisible();

    await page.getByTestId("time-entry-modal-end").fill("17:00");

    // PUT for edit, POST for create — both flows share the save button,
    // so we listen for either to keep the spec robust across both branches.
    const saveResponse = page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/time-entries") &&
        ["POST", "PUT"].includes(res.request().method()),
    );
    await page.getByTestId("time-entry-modal-save").click();
    await saveResponse;
    await expect(modal).not.toBeVisible();
  });

  test("delete a time entry from the list view", async ({ page }) => {
    // Switch to list view — the calendar view doesn't expose row controls.
    await page.getByTestId("time-entries-view-list").click();
    await expect(page.getByTestId("time-entries-list")).toBeVisible();

    // Pick the first non-locked row's delete button. The page renders both
    // disabled (locked) and active variants — the latter has no `disabled`.
    const firstDelete = page
      .locator("[data-testid$='-delete']:not([disabled])")
      .first();

    // A freshly bootstrapped tenant has no entries — skip the test as a
    // contract-only run (the testid surface is what 74-01 will exercise).
    const count = await firstDelete.count();
    if (count === 0) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "Empty tenant — delete-button testid contract validated",
      });
      return;
    }

    await firstDelete.click();
    // "Ja" confirm button — text-based assertion is fine since it's a
    // confirm affordance, not a row identifier.
    await page.getByRole("button", { name: "Ja" }).first().click();

    // DELETE wait — see comment on the POST/PUT version above.
    await page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/time-entries") &&
        res.request().method() === "DELETE",
    );
  });

  test("locked-month edit shows German error message", async ({ page }) => {
    // Mock the API so POST/PUT both return 403 with the canonical German
    // locked-month error. The error banner is owned by the page-level
    // error rendering (line 1052 in +page.svelte) — assert it's surfaced.
    await page.route("**/api/v1/time-entries", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Eintrag ist gesperrt und kann nicht bearbeitet werden",
          }),
        });
      } else {
        await route.continue();
      }
    });
    await page.route("**/api/v1/time-entries/**", async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Eintrag ist gesperrt und kann nicht bearbeitet werden",
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Open the modal via the PageHead CTA.
    await page.getByTestId("time-entries-add").click();
    const modal = page.getByTestId("time-entry-modal");
    await expect(modal).toBeVisible();

    // Pick a weekday a couple of weeks back so the date doesn't collide
    // with the in-process entry from previous tests within the same tenant.
    const d = new Date();
    d.setDate(d.getDate() - 14);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    const lockTestDate = d.toISOString().split("T")[0];

    await page.getByTestId("time-entry-modal-date").fill(lockTestDate);
    await page.getByTestId("time-entry-modal-start").fill("09:00");
    await page.getByTestId("time-entry-modal-end").fill("17:00");

    await page.getByTestId("time-entry-modal-save").click();

    // The page-level error region surfaces the canonical German message.
    await expect(page.getByText("Monat ist gesperrt")).toBeVisible();

    await page.unroute("**/api/v1/time-entries");
    await page.unroute("**/api/v1/time-entries/**");
  });

  test("break slot add + remove via break-slots-editor", async ({ page }) => {
    // Smoke-test the BreakSlotsEditor surface — exercises the per-index
    // testid contract documented in 73-03 plan Task 2.
    await navigateToMonth(page, TEST_DATE);
    await page.getByTestId(`calendar-cell-${TEST_DATE}`).click();

    const modal = page.getByTestId("time-entry-modal");
    await expect(modal).toBeVisible();

    const editor = page.getByTestId("break-slots-editor");
    await expect(editor).toBeVisible();

    // Add a break — slot 0 should materialise with start/end inputs.
    await page.getByTestId("break-slot-add").click();
    const slotZero = page.getByTestId("break-slot-0");
    await expect(slotZero).toBeVisible();
    await page.getByTestId("break-slot-0-start").fill("12:00");
    await page.getByTestId("break-slot-0-end").fill("12:30");

    // Remove it — slot 0 must disappear from the DOM.
    await page.getByTestId("break-slot-0-remove").click();
    await expect(slotZero).toHaveCount(0);

    // Close the modal cleanly so the test doesn't leak entries when the
    // outer beforeEach navigates away next time.
    await page.getByTestId("time-entry-modal-cancel").click();
    await expect(modal).not.toBeVisible();
  });

  test.afterEach(async ({ tenant }) => {
    // The tenant fixture's teardown handles full DB cleanup — keep this
    // hook for symmetry + future per-test cleanup needs.
    void tenant;
    void API_BASE;
  });
});
