/**
 * Berufsschule (BS-Pattern) admin flows — E2E spec.
 *
 * Phase 67 introduced the BS-Pattern editor (Wöchentlich + Blockunterricht
 * modes) on the admin employee detail page. Phase 67.2 added Schulferien-
 * Integration + Shift Auto-Cleanup (soft-delete + restore via
 * /shifts/conflicts).
 *
 * Per CONTEXT D-06 ("BS-Pattern tests cover Phase 67.2 deliverables
 * specifically") and threat T-74-03 ("BS-Pattern test breaks on
 * Schulferien-API change — mitigate via mock"), this spec:
 *
 *   1. Uses the Phase 73 `tenant` fixture for per-test tenant isolation.
 *   2. Mocks the Schulferien API in `beforeEach` (never hits live
 *      OpenHolidays / ferienapi.de during the test run).
 *   3. Asserts admin-flow behaviour at the UI level — the Phase 67 + 67.2
 *      API-side test suite covers backend correctness exhaustively.
 *
 * Test cases (5):
 *   1. Create a Wöchentlich pattern with Mo-Fr default
 *   2. Switch from Wöchentlich → Blockunterricht and back
 *   3. Schulferien window is skipped in pattern generation (NW)
 *   4. federalStateOverride changes which Schulferien window applies (BY)
 *   5. Soft-delete then restore via /shifts/conflicts UI surface
 *
 * The data-testids referenced (bs-pattern-mode-weekly, bs-pattern-weekday-*,
 * bs-day-{date}, bs-pattern-{id}-delete, bs-pattern-conflict-{id}-restore)
 * are introduced by Phase 73-05 (Admin data-testid migration). This spec is
 * wave 2 of Phase 74 and depends on 73-05 having landed.
 *
 * The Phase 73 tenant fixture exports `test` + `TestTenant` from
 * `../fixtures` (barrel re-export). Specs are intentionally agnostic about
 * the fixture's file layout — they consume only the published interface.
 */

import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import {
  mockSchoolHolidayAPI,
  MOCK_HOLIDAYS_NW,
  MOCK_HOLIDAYS_BY,
} from "../fixtures/school-holiday-mock";
import {
  createAzubiEmployee,
  seedBSPattern,
  openPatternEditor,
} from "../helpers/bs-pattern";

/**
 * Re-shape the Phase 73 `TestTenant` to the contract our helpers consume.
 * The helpers declare a tiny local interface (BSPatternTenant) so they stay
 * parallel-worktree safe; this cast is the single place we bridge the two.
 */
function asPatternTenant(tenant: TestTenant): {
  tenantId: string;
  adminToken: string;
} {
  return { tenantId: tenant.tenantId, adminToken: tenant.adminToken };
}

test.describe("BS-Pattern admin flows", () => {
  // Phase 67.2: install the Schulferien mock per-page so every test gets a
  // deterministic Ferien window list. T-74-03 mitigation.
  test.beforeEach(async ({ page }) => {
    await mockSchoolHolidayAPI(page, {
      NW: MOCK_HOLIDAYS_NW,
      BY: MOCK_HOLIDAYS_BY,
    });
  });

  test("create a Wöchentlich pattern with Mo-Fr default", async ({
    page,
    tenant,
  }) => {
    const pt = asPatternTenant(tenant);
    const { employeeId } = await createAzubiEmployee(pt, { firstName: "Anna" });
    await openPatternEditor(page, employeeId);

    // Phase 67 editor: Wöchentlich is the default mode but we explicitly
    // click it so the test does not silently depend on the default flipping.
    await page.getByTestId("bs-pattern-mode-weekly").click();

    // Mo-Fr should be checked by default; Sa-So unchecked. The weekday
    // indices match the Phase 67 editor's labels: mo, di, mi, do, fr, sa, so.
    for (const day of ["mo", "di", "mi", "do", "fr"]) {
      await expect(
        page.getByTestId(`bs-pattern-weekday-${day}`),
        `Wöchentlich default should pre-tick ${day.toUpperCase()}`,
      ).toBeChecked();
    }
    for (const day of ["sa", "so"]) {
      await expect(
        page.getByTestId(`bs-pattern-weekday-${day}`),
        `Wöchentlich default should NOT pre-tick ${day.toUpperCase()}`,
      ).not.toBeChecked();
    }

    // Choose a future month-1st so CLAUDE.md "validFrom MUST be the 1st of
    // a calendar month for every contract change" passes.
    await page.getByTestId("bs-pattern-validFrom").fill("2026-07-01");
    await page.getByTestId("bs-pattern-submit").click();

    // Phase 67 success toast text: "Muster gespeichert" (per
    // 67-02-SUMMARY save-handler implementation).
    await expect(page.getByTestId("toast-success")).toContainText(
      "Muster gespeichert",
    );
  });

  test("switch from Wöchentlich to Blockunterricht and back", async ({
    page,
    tenant,
  }) => {
    const pt = asPatternTenant(tenant);
    const { employeeId } = await createAzubiEmployee(pt, {});
    // Seed a WEEKLY pattern via API so the editor hydrates with that mode.
    await seedBSPattern(pt, employeeId, {
      mode: "WEEKLY",
      validFrom: "2026-07-01",
      weeklyDays: [1, 2, 3, 4, 5],
    });
    await openPatternEditor(page, employeeId);

    // Switch to Blockunterricht — the weekly chip-picker should disappear and
    // the block-Zeitraum fields should appear.
    await page.getByTestId("bs-pattern-mode-block").click();
    await expect(
      page.getByTestId("bs-pattern-block-start"),
      "Block start input must appear in Blockunterricht mode",
    ).toBeVisible();
    await expect(
      page.getByTestId("bs-pattern-weekday-mo"),
      "Weekday chip should NOT be visible in Blockunterricht mode",
    ).toBeHidden();

    // Fill block dates: Mo-Fr of an arbitrary future week.
    await page.getByTestId("bs-pattern-block-start").fill("2026-09-07");
    await page.getByTestId("bs-pattern-block-end").fill("2026-09-18");
    await page.getByTestId("bs-pattern-submit").click();
    await expect(page.getByTestId("toast-success")).toBeVisible();

    // Switch back to Wöchentlich — weekday chips must reappear. This is the
    // round-trip invariant from Phase 67: switching modes preserves no stale
    // payload (see BSPatternPicker.setMode).
    await page.getByTestId("bs-pattern-mode-weekly").click();
    await expect(page.getByTestId("bs-pattern-weekday-mo")).toBeVisible();
  });

  test("Schulferien window is skipped in pattern generation", async ({
    page,
    tenant,
  }) => {
    const pt = asPatternTenant(tenant);
    const { employeeId } = await createAzubiEmployee(pt, {
      federalState: "NW",
    });
    // Pattern starts before the herbstferien window so the generator has a
    // chance to mark days inside the Ferien window as "skipped".
    await seedBSPattern(pt, employeeId, {
      mode: "WEEKLY",
      validFrom: "2026-10-01",
      weeklyDays: [1, 2, 3, 4, 5],
    });

    await page.goto(`/admin/employees/${employeeId}?month=2026-10`);
    // herbstferien-2026 (NW) covers Oct 12-24 per MOCK_HOLIDAYS_NW.
    // Tuesday Oct 13 falls INSIDE the Ferien window → state=ferien.
    // Tuesday Oct 06 falls OUTSIDE the Ferien window → state=scheduled.
    await expect(
      page.getByTestId("bs-day-2026-10-13"),
      "2026-10-13 falls inside NW Herbstferien (Oct 12-24) — expected state=ferien",
    ).toHaveAttribute("data-state", "ferien");
    await expect(
      page.getByTestId("bs-day-2026-10-06"),
      "2026-10-06 is BEFORE NW Herbstferien — expected state=scheduled",
    ).toHaveAttribute("data-state", "scheduled");
  });

  test("federalStateOverride changes Schulferien window", async ({
    page,
    tenant,
  }) => {
    const pt = asPatternTenant(tenant);
    // Tenant is in NW (the default Schulferien-mock state) but the AZUBI's
    // BS-Pattern uses BY as override — typical Pendler-Azubi situation per
    // Phase 67.2 BERSCH-16 (D-13).
    const { employeeId } = await createAzubiEmployee(pt, {
      federalState: "NW",
    });
    await seedBSPattern(pt, employeeId, {
      mode: "WEEKLY",
      validFrom: "2026-10-01",
      weeklyDays: [1, 2, 3, 4, 5],
      federalStateOverride: "BY",
    });

    await page.goto(`/admin/employees/${employeeId}?month=2026-10`);
    // With BY override, NW's Herbstferien (Oct 12-24) MUST NOT apply.
    // BY's Herbstferien is Nov 2-6 — outside the Oct view. So Oct 13 should
    // be a regular scheduled BS-day, NOT a Ferien day.
    await expect(
      page.getByTestId("bs-day-2026-10-13"),
      "With federalStateOverride=BY, NW Herbstferien must NOT apply on 2026-10-13",
    ).toHaveAttribute("data-state", "scheduled");
  });

  test("soft-delete then restore via /shifts/conflicts UI", async ({
    page,
    tenant,
  }) => {
    const pt = asPatternTenant(tenant);
    const { employeeId } = await createAzubiEmployee(pt, {});
    const { patternId } = await seedBSPattern(pt, employeeId, {
      mode: "WEEKLY",
      validFrom: "2026-07-01",
      weeklyDays: [1, 2, 3, 4, 5],
    });

    // 1. Soft-delete the pattern from the editor (Phase 67.2 auto-cleanup
    //    soft-deletes the generated BS-Shifts as a side effect — that's
    //    what /shifts/conflicts surfaces).
    await openPatternEditor(page, employeeId);
    await page.getByTestId(`bs-pattern-${patternId}-delete`).click();
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("toast-success")).toContainText(
      "Muster gelöscht",
    );

    // 2. Navigate to the conflicts overview — the soft-deleted shifts (or
    //    the pattern itself, depending on Phase 73-05's chosen surface)
    //    must appear in the queue with a restore action.
    await page.goto(`/shifts/conflicts?type=bs-pattern-deleted`);
    await expect(
      page.getByTestId(`bs-pattern-conflict-${patternId}`),
      "Soft-deleted BS-Pattern must surface in /shifts/conflicts",
    ).toBeVisible();

    // 3. Restore via the per-row restore button. Phase 67.2 success toast
    //    contains "wiederhergestellt" (German for "restored").
    await page
      .getByTestId(`bs-pattern-conflict-${patternId}-restore`)
      .click();
    await expect(page.getByTestId("toast-success")).toContainText(
      "wiederhergestellt",
    );

    // 4. Returning to the editor — the pattern row must be back as a
    //    visible (active) row.
    await openPatternEditor(page, employeeId);
    await expect(
      page.getByTestId(`bs-pattern-${patternId}`),
      "Restored BS-Pattern must reappear in the editor as an active row",
    ).toBeVisible();
  });
});
