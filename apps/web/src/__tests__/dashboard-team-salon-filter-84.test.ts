// Issue #84 (D-01, D-07, D-09, D-11, D-16) — source pins of the dashboard Team block's wiring to
// the salon context: the page decides the filter only through teamSalonFilter(), loads its three
// figures from the new team endpoints with the salonId, reloads on a change of the guarded filter
// and degrades calmly when the server rejects the salon.
//
// Why source-read and not mounted: the page imports `$app/*` and fires roughly twenty API calls in
// `onMount` (same wall as dashboard-overtime-trend-degrade.test.ts documents). The decisions
// themselves are unit-tested in `lib/dashboard/__tests__/team-view.test.ts`; this file only proves
// the page uses them. `lint:ui-classes` does not scan `routes/**`, so this is the net for the
// wiring.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const DASHBOARD = readRouteFile(
  "../routes/(app)/dashboard/+page.svelte",
  "src/routes/(app)/dashboard/+page.svelte",
);

/** The body of `function <name>(` up to the next top-level function or section comment. */
function functionBody(name: string): string {
  const start = DASHBOARD.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const next = DASHBOARD.slice(start + 1).search(/\n {2}(?:async )?function |\n {2}\/\/ ──/);
  expect(next, `end of ${name} not found`).toBeGreaterThan(-1);
  return DASHBOARD.slice(start, start + 1 + next);
}

describe("Issue #84 — the Team block follows the salon context through team-view.ts", () => {
  // Anti-vacuity (CLAUDE.md § Anti-vacuity gate): every containment assertion below is trivially
  // true against an empty string.
  it("[vacuity gate] the dashboard source is actually loaded", () => {
    expect(DASHBOARD.length).toBeGreaterThan(50_000);
    expect(DASHBOARD).toContain("teamSalonFilter");
  });

  it("D-11: the filter comes from teamSalonFilter($salonContext), never from the raw selection getter", () => {
    expect(DASHBOARD).toContain("teamSalonFilter($salonContext)");
    // The store's selectedSalonId() preselects the sole salon (AC-6 trap) — only team-view.ts may call it.
    expect(DASHBOARD).not.toContain("selectedSalonId(");
  });

  it("D-07/D-08: the three team figures are requested from the new endpoints with the filter", () => {
    // Issue #846: the team trend feeds the band cell „Monat bis gestern“ (no chart, D-04)
    expect(functionBody("loadTeamMonth")).toContain(
      'withSalonId("/dashboard/team-trend?months=1", filter)',
    );
    expect(functionBody("loadTodayAttendance")).toContain(
      'withSalonId("/dashboard/today-attendance", filter)',
    );
    expect(functionBody("loadTeamTasks")).toContain(
      'withSalonId("/leave/requests?status=PENDING", filter)',
    );
    expect(functionBody("loadUpcomingLeaves")).toContain(
      'withSalonId("/dashboard/team-upcoming-leave", filter)',
    );
    expect(functionBody("loadTeamWeek")).toContain(
      "withSalonId(`/dashboard/team-week?date=${dateParam}`, filter)",
    );
  });

  it("D-07: the page no longer fans out to the monthly report endpoint", () => {
    expect(DASHBOARD).not.toContain("reports/monthly");
  });

  it("D-01: a context-gated effect reloads the Team block when the guarded filter changes", () => {
    const effectIdx = DASHBOARD.indexOf("$effect(() => {\n    if (!canSeeTeamBereich");
    expect(effectIdx, "team reload effect not found").toBeGreaterThan(-1);
    const effect = DASHBOARD.slice(effectIdx, DASHBOARD.indexOf("});", effectIdx));
    expect(effect).toContain("teamContextReady");
    expect(effect).toContain("teamFilter");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("reloadTeam()");
    // The context must be loaded before the first team load (no unfiltered-then-filtered double load).
    expect(DASHBOARD).toContain("const teamContextReady = $derived($salonContext.loaded);");
  });

  it("D-01: a reload invalidates every loader still in flight", () => {
    const reload = functionBody("reloadTeam");
    expect(reload).toContain("teamGeneration++;");
    // Issue #846: every loader of Heute im Salon follows the same generation idiom.
    for (const loader of [
      "loadTeamWeek",
      "loadTodayAttendance",
      "loadTeamMonth",
      "loadUpcomingLeaves",
      "loadTeamTasks",
    ]) {
      const body = functionBody(loader);
      expect(body, `${loader} captures the generation`).toContain(
        "const generation = teamGeneration;",
      );
      expect(body, `${loader} drops a stale result`).toContain("generation !== teamGeneration");
    }
  });

  it("D-16: a rejected salon (404) is a calm empty state in every loader — no toast, no console.error", () => {
    const needle = "isTeamSalonRejected(err)";
    let from = 0;
    let found = 0;
    while (true) {
      const idx = DASHBOARD.indexOf(needle, from);
      if (idx === -1) break;
      found++;
      const rest = DASHBOARD.slice(idx);
      const ends = [rest.indexOf("return;"), rest.indexOf("} else {")].filter((i) => i > -1);
      const branch = rest.slice(0, Math.min(...ends));
      expect(branch).toContain("teamUnavailable = true;");
      expect(branch).not.toContain("toasts.");
      expect(branch).not.toContain("console.error");
      from = idx + needle.length;
    }
    expect(found).toBeGreaterThanOrEqual(3);
  });

  it("D-16: the 30 s poll stops requesting team-week for a rejected selection", () => {
    const poll = functionBody("pollDashboard");
    expect(poll).toContain("teamUnavailable");
    expect(poll).toContain("teamContextReady");
    expect(functionBody("reloadTeam")).toContain("teamUnavailable = false;");
  });

  it("D-05: the saldo is never split by salon — Heute im Salon requests no saldo figure at all (#846 D-04)", () => {
    expect(DASHBOARD).not.toContain("/dashboard/overtime-trend");
    expect(DASHBOARD).not.toContain("/dashboard/overtime-overview");
  });

  it("D-05/D-12: the Soll is shown only when the server delivered one", () => {
    expect(DASHBOARD).toMatch(/teamMonth\.shouldMinutes !== null\s*\?/);
    // without a Soll the cell names what the hours cover, from the server's worked basis
    expect(DASHBOARD).toContain('teamMonthBasis === "SCOPE_ENTRIES"');
  });

  it("D-01/D-15/D-16: the markup shows the divider label, the other-salon badge and the empty state", () => {
    // #846 (prototype v5): the selected salon is the first part of the page head's sub line
    expect(DASHBOARD).toMatch(/let teamSub = \$derived\(\s*\[\s*teamLabel \?\?/);
    expect(DASHBOARD).toContain("{TEAM_SALON_UNAVAILABLE_TEXT}");
    expect(DASHBOARD).toContain("anderer Salon");
    expect(DASHBOARD).toContain("In einem anderen Salon gearbeitet");
    // Issue #846 (D-02): every cell carries its status as text, so no legend is needed any more.
    expect(DASHBOARD).not.toContain('class="legend"');
  });
});
