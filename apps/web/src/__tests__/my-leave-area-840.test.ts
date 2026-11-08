// Issue #840 (plan 840-11; E-01, E-03, E-05, D-840-01/13/14/16/24, AC-3, AC-10) - source pins of the
// personal absence page: „Mein Bereich → Abwesenheiten“ with the tabs Kalender / Meine Anträge / Team /
// Planung on ONE toolbar, own data first and a neutral, read-only view of the team next to it.
//
// Why source-read and not mounted: the page imports `$app/stores` and `$app/navigation`, mounts the
// shared request dialog and fires its requests on mount (the same wall `team-leave-area-840.test.ts`
// documents). The pure decisions are tested where they live (`lib/leave/__tests__/area-tabs.test.ts`,
// `timeline-model.test.ts`), the components in their own mounted tests.
//
// Mutation proofs (each: `cp` backup, mutate, run, `cp` back; recorded for 840-11):
//   M1 - `&scope=own` removed from the Kalender loader  -> "[own only] the Kalender loader ..." red.
//   M2 - `onBarSelect={...}` added to the Team tab's AbsenceTimeline -> "[read-only] ..." red.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { parseMyLeaveState } from "$lib/leave/area-tabs";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/leave/+page.svelte",
  "src/routes/(app)/leave/+page.svelte",
);

/** How often `needle` occurs in `source`. */
function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/** The body of `function <name>(` (or `async function`) up to its closing brace at the top level. */
function functionBody(name: string): string {
  const start = PAGE.search(new RegExp(`function ${name}\\(`));
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }\n", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

/** The markup between two markers; both must exist, so a moved marker cannot make a pin vacuous. */
function between(from: string, to: string): string {
  const start = PAGE.indexOf(from);
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1);
  const end = PAGE.indexOf(to, start + from.length);
  expect(end, `marker not found after it: ${to}`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe("Issue #840 E-01 - one page, one toolbar", () => {
  it("[vacuity gate] the page source is loaded and is the personal host page", () => {
    expect(PAGE.length).toBeGreaterThan(60_000);
    expect(PAGE).toContain('<PageHead eyebrow="Mein Bereich" title="Abwesenheiten">');
    expect(PAGE).toContain("<title>Abwesenheiten – Clokr</title>");
    // The old title is gone from the page.
    expect(PAGE).not.toContain("Urlaub & Abwesenheit");
  });

  it("[one toolbar] exactly one LeaveToolbar carries tabs, period and zoom", () => {
    expect(count(PAGE, "<LeaveToolbar")).toBe(1);
    expect(PAGE).toContain('ariaLabel="Abwesenheiten"');
    expect(PAGE).toContain('testIdPrefix="leave-view"');
    expect(PAGE).toContain("tabs={toolbarTabs}");
    expect(PAGE).toContain("period={activePeriod}");
  });

  it("[tabs] Kalender / Meine Anträge / Team / Planung, with the test ids the e2e specs know", () => {
    expect(PAGE).toContain('{ id: "kalender", label: "Kalender", testId: "calendar" }');
    expect(PAGE).toContain('{ id: "antraege", label: "Meine Anträge", testId: "list" }');
    expect(PAGE).toContain('{ id: "team", label: "Team" }');
    expect(PAGE).toContain('{ id: "planung", label: "Planung" }');
    // The toolbar draws the tablist; the page has no hand-rolled one any more.
    expect(PAGE).not.toContain("view-tab--active");
    expect(PAGE).not.toContain('class="view-tabs"');
  });

  it("[no month bar] neither hand-rolled month bar nor picker is left", () => {
    for (const gone of [
      "cal-monthbar",
      "month-picker",
      "Buchungsmonat",
      "function prevMonth(",
      "function nextMonth(",
      "function gotoMonthYear(",
      "function prevYear(",
      "function nextYear(",
      "MONTH_NAMES",
      "showMonthPicker",
    ]) {
      expect(PAGE, `${gone} must be gone`).not.toContain(gone);
    }
  });

  it("[URL state] tab, zoom and anchor come only from parseMyLeaveState; a change writes the URL through goto", () => {
    expect(PAGE).toContain("parseMyLeaveState($page.url.searchParams, today)");
    // One read of the URL for the state, one more inside defaultZoomOf (the defaults live in area-tabs).
    expect(count(PAGE, "parseMyLeaveState(")).toBe(2);
    const navigate = functionBody("navigate");
    expect(navigate).toContain("myLeaveSearch(next)");
    expect(navigate).toContain("keepFocus: true");
    expect(navigate).toContain("noScroll: true");
    // A tab change is a history entry, a zoom / period change replaces it.
    expect(functionBody("selectTab")).toContain("void navigate({ tab, zoom: defaultZoomOf(tab) })");
    expect(PAGE).toContain("void navigate({ zoom }, true)");
    expect(PAGE).toContain("void navigate({ datum: today }, true)");
    expect(PAGE).toContain("shiftPeriod(activeZoom, urlState.datum, step)");
  });

  it("[zoom] Monat on Kalender, Jahr on Meine Anträge, the zoom control only on Team and Planung", () => {
    expect(PAGE).toContain(
      'activeTab === "kalender" ? "monat" : activeTab === "antraege" ? "jahr" : urlState.zoom',
    );
    expect(PAGE).toContain(
      'zooms={activeTab === "team" || activeTab === "planung" ? TIMELINE_ZOOMS : []}',
    );
    // The defaults per tab come from the one parser (area-tabs): working views a month, Planung a quarter.
    const today = "2026-09-16";
    const zoomOf = (tab: string) => parseMyLeaveState(new URLSearchParams({ tab }), today).zoom;
    expect(zoomOf("kalender")).toBe("monat");
    expect(zoomOf("antraege")).toBe("monat");
    expect(zoomOf("team")).toBe("monat");
    expect(zoomOf("planung")).toBe("quartal");
  });

  it("[panels] every tab panel carries role=tabpanel and names its tab", () => {
    for (const id of ["kalender", "antraege", "team", "planung"]) {
      expect(PAGE).toContain(
        `<div role="tabpanel" id="leave-panel-${id}" aria-labelledby="leave-tab-${id}">`,
      );
    }
  });

  it("[above the tabs] the KPI cards and the Überstundenkonto sit before the toolbar, on every tab", () => {
    const kpi = PAGE.indexOf('data-testid="leave-balance"');
    const toolbar = PAGE.indexOf("<LeaveToolbar");
    const firstPanel = PAGE.indexOf('<div role="tabpanel"');
    expect(kpi).toBeGreaterThan(-1);
    expect(toolbar).toBeGreaterThan(kpi);
    expect(firstPanel).toBeGreaterThan(toolbar);
    expect(PAGE.indexOf("<SaldoAnzeige")).toBeLessThan(toolbar);
  });

  it("[notification link] a request id without a tab opens Meine Anträge at that row", () => {
    expect(PAGE).toContain(
      '!urlState.explicitTab && urlState.requestId !== null ? "antraege" : urlState.tab',
    );
    expect(functionBody("focusRequest")).toContain("pageOfRequest(");
  });

  it("[gone] the planner link and every salon display of the old page are removed", () => {
    expect(PAGE).not.toContain("leave-plan-link");
    expect(PAGE).not.toContain('href="/leave/planung"');
    expect(PAGE).not.toContain("SalonScopeLabel");
    expect(PAGE).not.toContain("salonPageFilter");
    expect(PAGE).not.toContain("withSalonId");
  });
});

describe("Issue #840 E-03 / D-840-24 / AC-3 - the Kalender is own data only", () => {
  it("[own only] the Kalender loader carries scope=own on the wire and filters nothing on the client", () => {
    const body = functionBody("loadCalendar");
    expect(body).toContain("&scope=own");
    expect(body).toContain("/leave/calendar?year=${calYear}&month=${calMonth}");
    expect(body).not.toContain("salonId");
    // The server returns no colleague row, so the page keeps no colleague machinery.
    expect(PAGE).not.toContain("withMaskedKeys");
    expect(PAGE).not.toContain("masked");
    expect(PAGE).not.toContain("canSeeOthersLeaveType");
    expect(PAGE).not.toContain("hasPermission");
  });

  it("[one calendar read per view] the page asks /leave/calendar exactly twice: own month, team range", () => {
    expect(count(PAGE, "/leave/calendar?")).toBe(2);
  });

  it("[reload] the loader is guarded against a superseded answer and reloads on a month change", () => {
    const body = functionBody("loadCalendar");
    expect(body).toContain("const generation = ++calGeneration;");
    expect(body).toContain("if (generation !== calGeneration) return;");
    expect(PAGE).toContain("const calKey = $derived(`${calYear}-${calMonth}`);");
  });

  it("[legend] the legend names only what the month contains, through the one LeaveLegend", () => {
    expect(PAGE).toContain("typeCodes={calLegend.typeCodes}");
    expect(PAGE).toContain("styles={calLegend.styles}");
    expect(PAGE).toContain('holidayLook="calendar"');
  });

  it("[Meine Anträge] the year's own requests stay: filters, table and row actions keep their test ids", () => {
    for (const id of [
      "leave-filter-status",
      "leave-filter-type",
      "leave-mine-table",
      "leave-empty-state",
    ]) {
      expect(PAGE, id).toContain(`data-testid="${id}"`);
    }
    expect(PAGE).toContain("/leave/requests?year=${calYear}");
  });
});

describe("Issue #840 E-03 / E-05 / D-840-16 / AC-3 - Team is neutral and read-only", () => {
  const TEAM_PANEL = between(
    '<div role="tabpanel" id="leave-panel-team"',
    '<div role="tabpanel" id="leave-panel-planung"',
  );

  it("[team scope] the Team loader carries scope=team and never a salon parameter", () => {
    const body = functionBody("loadTeam");
    expect(body).toContain("calendarRangeQuery(activePeriod)");
    expect(body).toContain("&scope=team");
    // The API refuses the combination of a scope and a salon; the page must never send one.
    expect(body).not.toContain("salonId");
    expect(body).not.toContain("withSalonId");
  });

  it("[generation] a superseded answer never overwrites a newer one, a failure is an empty view", () => {
    const body = functionBody("loadTeam");
    expect(body).toContain("const generation = ++teamGeneration;");
    expect(count(body, "if (generation !== teamGeneration) return;")).toBe(2);
    expect(body).toContain("teamRows = [];");
    // No alert on a failed team read: the tab is context, not a task.
    expect(body).not.toContain("error =");
  });

  it("[the Team tab reloads] on a period change while it is the tab in view", () => {
    expect(PAGE).toContain(
      "const teamKey = $derived(`${activePeriod.startDay}|${activePeriod.endDay}`);",
    );
    expect(PAGE).toContain('if (activeTab !== "team") return;');
  });

  it("[one timeline] exactly one AbsenceTimeline on the page, in the Team tab, with the phone list as its twin", () => {
    expect(count(PAGE, "<AbsenceTimeline")).toBe(1);
    expect(count(PAGE, "<AbsenceList")).toBe(1);
    expect(count(TEAM_PANEL, "<AbsenceTimeline")).toBe(1);
    expect(count(TEAM_PANEL, "<AbsenceList")).toBe(1);
    expect(TEAM_PANEL).toContain("closedWeekdays={teamClosedDays.days}");
    expect(TEAM_PANEL).toContain("load={teamLoad}");
    expect(TEAM_PANEL).toContain("{:else if isMobile}");
  });

  it("[read-only] the Team timeline and list get no select, drag or edit callback (E-05)", () => {
    for (const callback of [
      "onBarSelect",
      "onMoveWish",
      "onEditWish",
      "onAddWish",
      "canAddWishFor",
    ]) {
      expect(TEAM_PANEL, `${callback} must not be passed in the Team tab`).not.toContain(callback);
    }
    // The only interaction is the week click of the Jahr zoom: it changes the period, nothing else.
    expect(TEAM_PANEL).toContain(
      'onWeekSelect={(monday) => void navigate({ zoom: "quartal", datum: monday }, true)}',
    );
    // No click-through helper exists on the page: a bar leads nowhere.
    expect(PAGE).not.toContain("function selectBar(");
    expect(PAGE).not.toContain("requestId: bar.requestId");
  });

  it("[load row] day load in Quartal and Monat, week load in Jahr, and no limit data (#836 stays with the approvers)", () => {
    const at = PAGE.indexOf("const teamLoad = $derived.by(() => {");
    expect(at).toBeGreaterThan(-1);
    const body = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(body).toContain('activePeriod.zoom === "jahr"');
    expect(body).toContain("weekLoad(");
    expect(body).toContain("calendarDayLoad(");
    expect(PAGE).not.toContain("/leave/limits/load");
    expect(PAGE).not.toContain("exceededDaysFromLoad");
  });

  it("[closed days] they come from the answer's salons through closedDaysFor, with the legend hint", () => {
    expect(PAGE).toContain("closedDaysFor(teamSalons, $salonContext)");
    expect(PAGE).toContain("teamSalons = answer.salons ?? [];");
    expect(PAGE).toContain('const CLOSED_DAYS_HINT = "Schließtage nur bei einem Salon";');
  });

  it("[legend] the neutral style and the own types come from legendFrom over the rows in view", () => {
    expect(PAGE).toContain("const base = legendFrom(teamRows);");
    expect(TEAM_PANEL).toContain("typeCodes={teamLegend.typeCodes}");
    expect(TEAM_PANEL).toContain("styles={teamLegend.styles}");
  });

  it("[visible to everyone] the tab is offered unconditionally: no permission and no tenant switch gate it", () => {
    expect(PAGE).toContain('{ id: "team", label: "Team" }');
    expect(PAGE).not.toContain("hasPermission(");
    expect(PAGE).not.toContain("tenantConfig");
  });
});

describe("Issue #840 E-03 / D-840-16 / D-840-23 - Planung shows the own wishes", () => {
  const PLANUNG_PANEL = between('<div role="tabpanel" id="leave-panel-planung"', "<ReasonDialog");

  it("[own mode] the panel runs in own mode, once, with no manage controls", () => {
    expect(count(PAGE, "<LeavePlanningPanel")).toBe(1);
    expect(PLANUNG_PANEL).toContain('mode="own"');
    expect(PAGE).not.toContain('mode="team"');
    // No manage dialog, no manage button, no viewer callback: own mode offers none of it.
    expect(PAGE).not.toContain("manageOpen");
    expect(PAGE).not.toContain("onViewer");
    expect(PAGE).not.toContain("leave-plan-manage");
    expect(PAGE).not.toContain("Planung verwalten");
  });

  it("[salon] the salon is the header selection, the period is the toolbar's, and the panel is not animated", () => {
    expect(PAGE).toContain("const planSalonId = $derived(teamSalonViewSalon($salonContext));");
    expect(PLANUNG_PANEL).toContain("salonId={planSalonId}");
    expect(PLANUNG_PANEL).toContain("period={activePeriod}");
    // Mounted outside every animated block (#570): a transform would trap its fixed dialogs.
    expect(PLANUNG_PANEL).not.toContain("card-animate");
    expect(PLANUNG_PANEL).not.toContain("animate");
  });

  it("[waits for the context] before the salon context is loaded the tab shows a status, not an empty planner", () => {
    expect(PLANUNG_PANEL).toContain("{#if !contextLoaded}");
    expect(PLANUNG_PANEL).toContain('role="status"');
  });

  it("[deep link] the notification link's salon is preselected once, then dropped from the URL", () => {
    const at = PAGE.indexOf("let salonDeepLinkHandled = false;");
    expect(at).toBeGreaterThan(-1);
    const effect = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(effect).toContain('$page.url.searchParams.get("salonId")');
    expect(effect).toContain("deepLinkSalon(param, $salonContext)");
    expect(effect).toContain("salonContext.setSelection(linked)");
    expect(effect).toContain('url.searchParams.delete("salonId")');
  });

  it("[default zoom] Planung opens on the quarter, Team on the month (the area-tabs defaults)", () => {
    const zoomOf = (tab: string) =>
      parseMyLeaveState(new URLSearchParams({ tab }), "2026-09-16").zoom;
    expect(zoomOf("planung")).toBe("quartal");
    expect(zoomOf("team")).toBe("monat");
  });
});
