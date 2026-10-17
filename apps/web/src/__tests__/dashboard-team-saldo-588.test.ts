// Issue #588 (AC-588-1, D-588-3, D-588-7, P-10, P-11) - source pins of the dashboard wiring of the
// card "Salden": placement (the first block of the team area), the permission gate, the loader
// idiom (generation, calm 404, silent 403), the salon filter, no part in the 5 s poll, the person
// links gated by the Team-Zeiten page right and the filter flag of the LOADED request.
//
// Why source-read: the page itself is covered by dashboard-team-saldo-pending-588.test.ts (mounted,
// the team week renders while the overview is pending); these pins keep the decisions from drifting
// where a mounted test cannot see them (what the poll calls, where the markup sits).
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

describe("Issue #588 - the dashboard card Salden is wired into the Team block", () => {
  it("[vacuity gate] the dashboard source is actually loaded", () => {
    expect(DASHBOARD.length).toBeGreaterThan(80_000);
    expect(DASHBOARD).toContain("Team-Wochenübersicht");
  });

  it("P-10: the card is gated by mayReadTeamSaldo, the rule /reports uses for its overview", () => {
    expect(DASHBOARD).toContain(
      "const canSeeTeamSaldo = $derived(mayReadTeamSaldo($authStore.user));",
    );
    expect(DASHBOARD).toContain('import { mayReadTeamSaldo } from "$lib/page-rights";');
  });

  it("D-588-3: the overview is requested with the team block's salon filter", () => {
    expect(functionBody("loadTeamSaldo")).toContain(
      'withSalonId("/dashboard/overtime-overview", filter)',
    );
  });

  it("the loader follows the idiom of its siblings: generation, no request without the right", () => {
    const body = functionBody("loadTeamSaldo");
    expect(body).toContain("const generation = teamGeneration;");
    expect(body).toContain("generation !== teamGeneration");
    expect(body).toContain("if (!canSeeTeamSaldo)");
    // The loading flag of a superseded load is left to the newer one.
    expect(body).toContain("if (generation === teamGeneration) teamSaldoLoading = false;");
  });

  it("D-16: a rejected salon (404) is the team block's calm unavailable state - no toast, no console.error", () => {
    const body = functionBody("loadTeamSaldo");
    const at = body.indexOf("isTeamSalonRejected(err)");
    expect(at).toBeGreaterThan(-1);
    const rest = body.slice(at);
    const branch = rest.slice(0, rest.indexOf("return;"));
    expect(branch).toContain("teamUnavailable = true;");
    expect(branch).not.toContain("toasts.");
    expect(branch).not.toContain("console.error");
  });

  it("a 403 hides the card silently", () => {
    const body = functionBody("loadTeamSaldo");
    const at = body.indexOf("err instanceof ApiError && err.status === 403");
    expect(at).toBeGreaterThan(-1);
    const rest = body.slice(at);
    const branch = rest.slice(0, rest.indexOf("return;"));
    expect(branch).toContain("teamSaldoHidden = true;");
    expect(branch).not.toContain("console.error");
    expect(branch).not.toContain("toasts.");
    // every other failure is logged like its siblings
    expect(body).toContain('console.error("Failed to load team saldo:", err);');
  });

  it("the card gets only the active rows: exited persons have their own section on /reports", () => {
    expect(functionBody("loadTeamSaldo")).toContain(
      "teamSaldoRows = partitionOvertimeOverview(answer.employees ?? []).active;",
    );
  });

  it("the salon note follows the filter of the LOADED request, not the live selection", () => {
    const body = functionBody("loadTeamSaldo");
    expect(body).toContain("teamSaldoFiltered = filter !== null;");
    expect(body).not.toContain("teamFilter !== null");
    expect(DASHBOARD).toContain("salonFiltered={teamSaldoFiltered}");
  });

  it("orchestrator amendment 2: the team block never waits for the overview", () => {
    const reload = functionBody("reloadTeam");
    // The three figures the team block is made of resolve first; the overview starts after them
    // and is not awaited.
    const all = reload.indexOf(
      "await Promise.allSettled([loadTeamWeek(), loadTeamCharts(), loadUpcomingLeaves()]);",
    );
    expect(all, "the team block's own Promise.allSettled").toBeGreaterThan(-1);
    const start = reload.indexOf("void loadTeamSaldo();");
    expect(start, "loadTeamSaldo is started without await").toBeGreaterThan(all);
    expect(reload).not.toContain("await loadTeamSaldo");
    const allList = reload.slice(all, reload.indexOf(");", all));
    expect(allList).not.toContain("loadTeamSaldo");
  });

  it("P-10: a reload resets the card state and the 5 s poll never reads the overview", () => {
    const reload = functionBody("reloadTeam");
    expect(reload).toContain("teamSaldoRows = [];");
    expect(reload).toContain("teamSaldoHidden = false;");
    expect(reload).toContain("teamSaldoLoading = canSeeTeamSaldo;");
    expect(functionBody("pollDashboard")).not.toContain("loadTeamSaldo");
    expect(functionBody("pollDashboard")).not.toContain("overtime-overview");
    // Anything else that requests the overview must go through the one loader.
    expect(DASHBOARD.split('"/dashboard/overtime-overview"').length - 1).toBe(1);
  });

  it("D-588-7: the card is the first block after the team divider, before the charts grid, inside the available branch", () => {
    const divider = DASHBOARD.indexOf('<div class="team-divider">');
    const unavailable = DASHBOARD.indexOf("{#if teamUnavailable}", divider);
    const elseAt = DASHBOARD.indexOf("{:else}", unavailable);
    const card = DASHBOARD.indexOf("<TeamSaldoCard", divider);
    const charts = DASHBOARD.indexOf('<div class="charts-grid">', divider);
    expect(divider).toBeGreaterThan(-1);
    expect(unavailable).toBeGreaterThan(divider);
    expect(elseAt).toBeGreaterThan(unavailable);
    expect(card).toBeGreaterThan(elseAt);
    expect(charts).toBeGreaterThan(card);
    // exactly one mount, and nothing but the gate between the else branch and the card
    expect(DASHBOARD.split("<TeamSaldoCard").length - 1).toBe(1);
    const between = DASHBOARD.slice(elseAt, card);
    expect(between).toContain("{#if canSeeTeamSaldo && !teamSaldoHidden}");
    expect(between).not.toContain("<Card");
  });

  it("P-11: the person link exists only for a caller who may open Team-Zeiten; a bar click navigates", () => {
    expect(DASHBOARD).toContain(
      "personHref={(id) => (canOpenTeamDay ? teamPersonHref(id) : null)}",
    );
    expect(DASHBOARD).toContain("onOpenPerson={(href) => goto(href)}");
    expect(DASHBOARD).toContain(
      'let canOpenTeamDay = $derived(mayOpenTeamPage("/team/time-entries", $authStore.user));',
    );
    expect(DASHBOARD).toContain('import { goto } from "$app/navigation";');
  });
});
