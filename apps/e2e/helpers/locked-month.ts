import { expect, type Page, type Locator } from "@playwright/test";

/**
 * UI surfaces that surface a "Monat ist gesperrt" interaction.
 *
 * Each surface is expected to render two things when the user is looking at a
 * date that falls inside a closed (Monatsabschluss-locked) month:
 *   1. The shared banner with data-testid `locked-month-error-banner`
 *   2. A per-surface marker `locked-month-error-{surface}` (introduced by
 *      Phase 73-05 data-testid migration), so a regression on one surface is
 *      detectable independently of the others.
 */
export type LockedSurface = "time-entry" | "leave" | "absence" | "schedule";

/**
 * Cross-surface assertion helper for the locked-month error UX.
 *
 * Per CLAUDE.md "Immutability after lock": once `isLocked=true` for a month,
 * the API rejects every mutation across all surfaces (time entry / leave /
 * absence / schedule). The UI MUST reflect this with a single canonical
 * German error banner + a hint to the recovery path (reopen request) — no
 * matter which surface the user is on.
 *
 * This helper is the single source of truth for that invariant. Plans 74-01,
 * 74-04, 74-05 and 74-06 (this plan's spec) all call it, so a regression in
 * any one surface fails loudly.
 *
 * Assertions made:
 *   1. The shared banner `locked-month-error-banner` is visible.
 *   2. Its text contains the canonical German message
 *      (`Eintrag ist gesperrt` OR `Monat ist gesperrt`, case-insensitive —
 *      both phrasings appear in the existing API responses).
 *   3. A reopen-recovery link/button `locked-month-reopen-link` is visible —
 *      admins must always see where to go from here.
 *   4. The per-surface testid `locked-month-error-{surface}` is present, which
 *      proves the Phase 73-05 migration covered this surface specifically.
 *
 * The helper relies entirely on Playwright's auto-retry on `toBeVisible()`
 * (no `waitForTimeout` polls) — see `.planning/phases/73-e2e-stability/`
 * D-08 for the no-arbitrary-wait policy.
 *
 * @param page    Playwright page already navigated to the surface under test.
 * @param surface Which UI surface is being tested. Drives the per-surface
 *                testid assertion.
 */
export async function expectLockedMonthError(
  page: Page,
  surface: LockedSurface,
): Promise<void> {
  // 1. Shared banner — same testid on every surface
  const banner: Locator = page.getByTestId("locked-month-error-banner");
  await expect(
    banner,
    `Locked-month error banner missing on surface '${surface}' — ` +
      `every locked-mutation surface must render the canonical banner`,
  ).toBeVisible();

  // 2. Canonical German error text
  await expect(
    banner,
    `Locked-month banner text on surface '${surface}' does not match the ` +
      `canonical German message (expected /Eintrag ist gesperrt|Monat ist gesperrt/i)`,
  ).toContainText(/Eintrag ist gesperrt|Monat ist gesperrt/i);

  // 3. Recovery-path hint: reopen request link
  await expect(
    page.getByTestId("locked-month-reopen-link"),
    `Reopen-request link missing on surface '${surface}' — ` +
      `users must always see the recovery path from a locked month`,
  ).toBeVisible();

  // 4. Per-surface marker: catches Phase 73-05 migration gaps
  await expect(
    page.getByTestId(`locked-month-error-${surface}`),
    `Per-surface testid 'locked-month-error-${surface}' missing — ` +
      `Phase 73-05 data-testid migration incomplete for this surface`,
  ).toBeVisible();
}

/**
 * Negative assertion — the locked-month banner is NOT present.
 *
 * Used after a reopen-request approval to prove that the UI consistently
 * un-locks every surface, not just the one the admin happens to be looking at.
 *
 * @param page Playwright page on any surface that previously showed the banner.
 */
export async function expectNoLockedMonthError(page: Page): Promise<void> {
  const banner = page.getByTestId("locked-month-error-banner");
  await expect(
    banner,
    "Locked-month banner is still visible after reopen — " +
      "the lock state did not propagate across surfaces",
  ).toBeHidden();
}
