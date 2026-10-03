// Issue #433 (D-11) — source pin for the MONTHLY_HOURS calendar prognosis on both
// `/time-entries` and `/team/time-entries`.
//
// Why a source pin and not a mounted-component test: `apps/web/vitest.config.ts` has no `$app`
// alias, so these ~3000-line route pages cannot be mounted (see `admin-system-save-wiring.test.ts`
// for the established precedent of reading route source with `readFileSync` instead). The actual
// NUMBERS this plan changes (month-saldo == dashboard == report for MONTHLY_HOURS) are asserted
// server-side by plan 05's `monthly-hours-soll-parity-433.test.ts` — this file only pins the
// SHAPE of both pages' source so the switch and the retired client formula cannot silently creep
// back in.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const TIME_ENTRIES_PAGE = readRouteFile(
  "../routes/(app)/time-entries/+page.svelte",
  "src/routes/(app)/time-entries/+page.svelte",
);
const TEAM_TIME_ENTRIES_PAGE = readRouteFile(
  "../routes/(app)/team/time-entries/+page.svelte",
  "src/routes/(app)/team/time-entries/+page.svelte",
);

// Base counts measured on HEAD 2fcadfe4 (before this plan) — every existing `monthSaldo` /
// `monthSaldoDayMap` read gated by `isShiftBased` must survive this plan unchanged in COUNT,
// even though this plan also makes the month-saldo fetch run for MONTHLY_HOURS. Changing this
// number is a finding, not something to "fix" by relaxing the assertion (CLAUDE.md
// feedback_no_test_manipulation).
const BASE_IS_SHIFT_BASED_AND_MONTH_SALDO_COUNT = 3;
// Neither page used `{@html}` before this plan; this plan adds no markup, so the count must
// stay 0 (threat T-433-23).
const BASE_HTML_COUNT = 0;

describe.each([
  ["/time-entries", TIME_ENTRIES_PAGE],
  ["/team/time-entries", TEAM_TIME_ENTRIES_PAGE],
])("%s — MONTHLY_HOURS calendar source pin (Issue #433, D-11)", (_label, SOURCE) => {
  it("the retired per-tenant holiday-deduction switch is gone", () => {
    expect(SOURCE).not.toContain("monthlyHoursHolidayDeduction");
  });

  it("the deleted client month-Soll helper is gone", () => {
    expect(SOURCE).not.toContain("monthlyBudgetSollMinutes");
  });

  it("the retired per-day-hours detection and its MONTHLY_HOURS rate-block locals are gone", () => {
    expect(SOURCE).not.toContain("hasPerDayHours");
    expect(SOURCE).not.toContain("excludeForDenom");
    expect(SOURCE).not.toContain("qualifyingHolidayDates");
  });

  it("the header Soll is the server's monthSollMinutes", () => {
    expect(SOURCE).toContain("monthSollMinutes");
  });

  it("the cells use the new D-05/D-06 display helpers", () => {
    expect(SOURCE).toContain("monthlyHoursDailyRateMinutes");
    expect(SOURCE).toContain("monthlyHoursWorkDays");
  });

  it("the month-saldo fetch condition now also covers MONTHLY_HOURS (not SHIFT_BASED only)", () => {
    // isMonthlyHoursWithTarget is the local gate this plan adds to the month-saldo fetch
    // condition in loadAll() — its presence proves the fetch is no longer SHIFT_BASED-only.
    expect(SOURCE).toContain("isMonthlyHoursWithTarget");
    expect(SOURCE).toContain('schedule?.type === "MONTHLY_HOURS"');
  });

  it("every existing isShiftBased && monthSaldo read survives unchanged in COUNT (base measured on HEAD 2fcadfe4)", () => {
    const matches = SOURCE.match(/isShiftBased && monthSaldo/g) ?? [];
    expect(matches).toHaveLength(BASE_IS_SHIFT_BASED_AND_MONTH_SALDO_COUNT);
  });

  it("no raw HTML was added (threat T-433-23)", () => {
    const matches = SOURCE.match(/@html/g) ?? [];
    expect(matches).toHaveLength(BASE_HTML_COUNT);
  });
});
