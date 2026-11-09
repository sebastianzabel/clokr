// Issue #840 (plan 840-10; E-01, E-02, E-06, D-840-01/13/14/17) - source pins of the team absence
// page: one page „Abwesenheiten“ with the tabs Übersicht / Anträge / Planung on ONE toolbar.
//
// Why source-read and not mounted: the page imports `$app/stores` and `$app/navigation`, mounts a
// dozen dialogs and fires its requests on mount (the same wall `team-leave-salon-558.test.ts`
// documents). The pure decisions are tested where they live (`lib/leave/__tests__/area-tabs.test.ts`,
// `team-leave-model.test.ts`), the components in their own mounted tests.

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

const PAGE = readRouteFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

/** How often `needle` occurs in `source`. */
function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/** The body of `function <name>(` up to its closing brace at the top level of the script. */
function functionBody(name: string): string {
  const start = PAGE.search(new RegExp(`function ${name}\\(`));
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }\n", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe("Issue #840 E-01 - one page, one toolbar, one timeline", () => {
  it("[vacuity gate] the page source is loaded and is the host page", () => {
    expect(PAGE.length).toBeGreaterThan(60_000);
    expect(PAGE).toContain('<PageHead eyebrow="Team" title={pageLabel("/team/leave")}>');
  });

  it("[one toolbar] exactly one LeaveToolbar carries tabs, period, zoom and the person filter", () => {
    expect(count(PAGE, "<LeaveToolbar")).toBe(1);
    expect(PAGE).toContain('ariaLabel="Abwesenheiten"');
    expect(PAGE).toContain('testIdPrefix="leave-team-view"');
    expect(PAGE).toContain("tabs={toolbarTabs}");
    // #840 G-6: on Planung the filter slot holds the planner controls (status, deadline, add).
    expect(PAGE).toContain('filters={activeTab === "planung" ? plannerControls : personFilter}');
    expect(count(PAGE, "<LeavePlanControls")).toBe(1);
  });

  it("[tabs] the three tabs are Übersicht / Anträge / Planung, the Anträge one badged and named „list“", () => {
    expect(PAGE).toContain('{ id: "uebersicht", label: "Übersicht" }');
    // #840 G-1: the count is the open requests of the salon selection (NOT narrowed by the person
    // filter), with its explanation, and a click on it opens the „Offen“ filter.
    expect(PAGE).toContain("openRequestsSummary(pendingRequests)");
    expect(PAGE).not.toContain("filteredPendingRequests");
    const tabs = PAGE.slice(PAGE.indexOf("const toolbarTabs = $derived("));
    const antraege = tabs.slice(tabs.indexOf('id: "antraege"'), tabs.indexOf('id: "planung"'));
    expect(antraege).toContain("badge: openSummary?.count");
    expect(antraege).toContain("badgeLabel: openSummary?.label");
    expect(antraege).toContain("onBadgeSelect: openOpenRequests");
    expect(PAGE).toContain('testId: "list"');
    const select = PAGE.slice(PAGE.indexOf("function openOpenRequests("));
    const selectBody = select.slice(0, select.indexOf("\n  }\n"));
    expect(selectBody).toContain('tab: "antraege"');
    expect(selectBody).toContain('status: "PENDING"');
    expect(selectBody).toContain('filterEmployeeId = ""');
    expect(PAGE).toContain('{ id: "planung", label: "Planung" }');
    // The old tabs are gone.
    expect(PAGE).not.toContain("Genehmigungen");
    expect(PAGE).not.toContain('"approvals"');
    expect(PAGE).not.toContain("leave-team-view-calendar");
  });

  it("[URL state] tab, zoom and anchor come only from parseTeamLeaveState; a change writes the URL through goto", () => {
    expect(PAGE).toContain("parseTeamLeaveState($page.url.searchParams, today)");
    expect(count(PAGE, "parseTeamLeaveState(")).toBe(1);
    const navigate = functionBody("navigate");
    expect(navigate).toContain("teamLeaveSearch(next)");
    expect(navigate).toContain("keepFocus: true");
    expect(navigate).toContain("noScroll: true");
    // A tab change is a history entry, a zoom / period / filter change replaces it.
    expect(functionBody("selectTab")).toContain("void navigate({ tab })");
    expect(PAGE).toContain("void navigate({ zoom }, true)");
    expect(PAGE).toContain("void navigate({ datum: today }, true)");
    expect(PAGE).toContain("shiftPeriod(toolbarPeriod.zoom, urlState.datum, step)");
  });

  it("[panels] every tab panel carries role=tabpanel and names its tab", () => {
    for (const id of ["uebersicht", "antraege", "planung"]) {
      expect(PAGE).toContain(
        `<div role="tabpanel" id="leave-panel-${id}" aria-labelledby="leave-tab-${id}">`,
      );
    }
  });

  it("[one timeline] the Übersicht mounts one AbsenceTimeline and the phone list, both on the same rows", () => {
    expect(count(PAGE, "<AbsenceTimeline")).toBe(1);
    expect(count(PAGE, "<AbsenceList")).toBe(1);
    expect(count(PAGE, "<LeaveLegend")).toBe(1);
    expect(PAGE).toContain("period={overviewPeriod}");
    expect(PAGE).toContain("closedWeekdays={werktage}");
    expect(PAGE).toContain("load={overviewLoad}");
  });

  it("[rows] every person of the page's own list is a row even without a bar", () => {
    expect(PAGE).toContain("overviewPersons(overviewRows, employees,");
    expect(PAGE).toContain("filterEmployeeId || undefined");
  });

  it("[closed days] they come from the calendar answer's salons through closedDaysFor, with the legend hint", () => {
    expect(PAGE).toContain("closedDaysFor(overviewSalons, $salonContext)");
    expect(PAGE).toContain("overviewSalons = answer.salons ?? [];");
    expect(PAGE).toContain('const CLOSED_DAYS_HINT = "Schließtage nur bei einem Salon";');
    expect(PAGE).toContain("closedHint: closedDays.hint ? CLOSED_DAYS_HINT : null");
  });

  it("[load] week load in Jahr, day load plus the #836 markers in Quartal and Monat", () => {
    const at = PAGE.indexOf("const overviewLoad = $derived.by(() => {");
    expect(at).toBeGreaterThan(-1);
    const body = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(body).toContain('overviewPeriod.zoom === "jahr"');
    expect(body).toContain("weekLoad(");
    expect(body).toContain("calendarDayLoad(");
    expect(body).toContain("limitBadgeTitle(over)");
  });

  it("[zoom] a week click opens its quarter; a bar with a request opens the Anträge tab at it", () => {
    expect(PAGE).toContain(
      'onWeekSelect={(monday) => void navigate({ zoom: "quartal", datum: monday }, true)}',
    );
    const select = functionBody("selectBar");
    expect(select).toContain("const id = bar.requestId;");
    expect(select).toContain("if (!id) return;");
    expect(select).toContain('tab: "antraege"');
    expect(select).toContain("requestId: id");
    expect(select).toContain("focusRequest(id)");
  });

  it("[gone] the month grid, its lane builder, the hand-rolled month bar and the day sheet are removed", () => {
    for (const gone of [
      "buildLaneMap",
      "buildCalMap",
      "buildCalDays",
      "calLanes",
      "cal-monthbar",
      "month-picker",
      "showMonthPicker",
      "gotoMonthYear",
      "cal-chip",
      "calYear",
      "calMonth",
      "loadCalendar",
      "<CalendarDayDetail",
    ]) {
      expect(PAGE, gone).not.toContain(gone);
    }
  });

  it("[no second salon display] the #558 filter stays, the scope label is gone (D-840-14)", () => {
    expect(PAGE).toContain("salonPageFilter($salonContext)");
    expect(PAGE).toContain("withSalonId(");
    expect(PAGE).not.toContain("SalonScopeLabel");
    expect(PAGE).not.toContain("salonScopeLabel");
  });
});

describe("Issue #840 E-02 - Anträge: a status filter, open requests marked, decisions only in the inbox", () => {
  it("[status filter] six options, the state lives in the URL and the select writes it with replaceState", () => {
    const at = PAGE.indexOf('data-testid="leave-team-filter-status"');
    expect(at).toBeGreaterThan(-1);
    const select = PAGE.slice(PAGE.lastIndexOf("<select", at), PAGE.indexOf("</select>", at));
    for (const option of [
      '<option value="">Alle Status</option>',
      '<option value="PENDING">Offen</option>',
      '<option value="APPROVED">Genehmigt</option>',
      '<option value="CANCELLATION_REQUESTED">Storno angefragt</option>',
      '<option value="REJECTED">Abgelehnt</option>',
      '<option value="CANCELLED">Storniert</option>',
    ]) {
      expect(select, option).toContain(option);
    }
    expect(select).toContain("value={filterLeaveStatus}");
    expect(select).toContain("void navigate({ status:");
    expect(select).toContain("}, true)");
    expect(PAGE).toContain(
      'const filterLeaveStatus = $derived<LeaveStatusFilter | "">(urlState.status ?? "")',
    );
  });

  it("[open requests of every year] the open filters read the merged list, never only the year list", () => {
    expect(PAGE).toContain("requestsForStatus(urlState.status, allTeamRequests, pendingRequests)");
    expect(PAGE).toContain("requestSource.filter(");
    // #840 G-1: „Offen“ lists every request that waits for a decision, so the list shows what was counted.
    expect(PAGE).toContain("matchesStatusFilter(req.status, urlState.status)");
    expect(PAGE).not.toContain("req.status !== filterLeaveStatus");
    expect(PAGE).toContain("<Pagination");
  });

  it("[PENDING marking] an open row carries the „Offen“ badge and the dashed chip of the beantragt style", () => {
    expect(functionBody("statusLabel")).toContain('? "Offen"');
    expect(PAGE).not.toContain('"Ausstehend"');
    // #840 G-3: the type chip is LeaveTypeChip (colour from the mapping); the dashed look moved there.
    expect(PAGE).toContain("<LeaveTypeChip");
    expect(PAGE).toContain('requested={req.status === "PENDING"}');
    expect(PAGE).toContain("data-row-status={req.status}");
    expect(PAGE).not.toContain("chip-brand");
    expect(PAGE).not.toContain("req-chip");
    expect(PAGE).toContain('class="badge {statusClass(req.status)}"');
  });

  it("[inbox link] the open row's action leads to the inbox, only behind the approve hint", () => {
    const at = PAGE.indexOf("/inbox?request=");
    expect(at).toBeGreaterThan(-1);
    expect(count(PAGE, "/inbox?request=")).toBe(1);
    // The link is rendered inside `{#if canApproveHint}` (Pitfall 7: readers see the badge, not the action).
    const gate = PAGE.lastIndexOf("{#if canApproveHint}", at);
    expect(gate).toBeGreaterThan(-1);
    expect(PAGE.slice(gate, at)).not.toContain("{/if}");
    expect(PAGE).toContain(
      'const canApproveHint = $derived(\n    hasPermission($authStore.user, "leave-request:approve:ZUGEWIESEN"),\n  )',
    );
    expect(PAGE).toContain("href={`/inbox?request=${req.id}&year=${req.startDate.slice(0, 4)}`}");
    // The testids of the former review buttons stay on the link.
    expect(PAGE).toContain("`leave-team-row-${req.id}-review-cancel`");
    expect(PAGE).toContain("`leave-team-row-${req.id}-review`");
  });

  it("[approved rows] correct, attest, Elternzeit-Kürzung and storno stay", () => {
    for (const id of ["correct", "attest", "parental-reduction", "storno"]) {
      expect(PAGE, id).toContain("`leave-team-row-${req.id}-" + id + "`");
    }
  });

  it("[no approvals view] the queue, the review dialog and its opener are gone from this page", () => {
    for (const gone of [
      "pending-card",
      "pending-list",
      "openReview",
      "reviewModal",
      "reviewOpen",
      "<LeaveReviewDialog",
      'view === "approvals"',
    ]) {
      expect(PAGE, gone).not.toContain(gone);
    }
  });

  it("[highlight] a request is paged to, marked and scrolled to, never navigated to", () => {
    const focus = functionBody("focusRequest");
    expect(focus).toContain("pageOfRequest(");
    expect(focus).toContain("highlightRequestId = requestId");
    expect(focus).not.toContain("goto(");
    expect(PAGE).toContain('id="request-{req.id}"');
    expect(PAGE).toContain("class:highlight-row={highlightRequestId === req.id}");
  });
});

describe("Issue #840 D-840-17/03/31 - Planung tab, legacy links, create link on every tab", () => {
  const LOADER = readRouteFile(
    "../routes/(app)/team/leave/+page.ts",
    "src/routes/(app)/team/leave/+page.ts",
  );

  it("[+page.ts] the universal load redirects with 307 through teamLeaveRedirect and does nothing else", () => {
    expect(LOADER.length).toBeGreaterThan(300);
    expect(count(LOADER, "teamLeaveRedirect(")).toBe(1);
    expect(LOADER).toContain("teamLeaveRedirect(url.searchParams)");
    expect(LOADER).toContain("redirect(307, target)");
    expect(LOADER).toContain('from "$lib/leave/area-tabs"');
    // The target is never built here: no template string, no concatenation, no second redirect.
    const code = LOADER.split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(count(code, "redirect(")).toBe(1);
    expect(code).not.toContain("searchParams.get(");
    expect(code).not.toContain("`");
  });

  it("[panel] the Planung tab mounts the planning panel once, in team mode, outside every animated block", () => {
    expect(count(PAGE, "<LeavePlanningPanel")).toBe(1);
    const at = PAGE.indexOf("<LeavePlanningPanel");
    const panel = PAGE.slice(at, PAGE.indexOf("/>", at));
    expect(panel).toContain('mode="team"');
    expect(panel).toContain("salonId={planSalonId}");
    expect(panel).toContain("period={overviewPeriod}");
    expect(panel).toContain("bind:manageOpen");
    expect(panel).toContain("onViewer={(viewer) => (canManagePlan = viewer.canManage)}");
    // #570: an animated block traps fixed dialogs. The panel's host div and its ancestors carry no
    // `animate` / `card-animate` (the panel animates its own cards).
    const tabPanel = PAGE.lastIndexOf('<div role="tabpanel" id="leave-panel-planung"', at);
    expect(tabPanel).toBeGreaterThan(-1);
    expect(PAGE.slice(tabPanel, at)).not.toContain("animate");
    expect(PAGE.slice(0, at)).not.toMatch(/<Card animate[^>]*>(?![\s\S]*<\/Card>)/);
  });

  it("[salon] the plan's salon is the header selection through teamSalonViewSalon; a ?salonId deep link is preselected, then dropped", () => {
    expect(PAGE).toContain("teamSalonViewSalon($salonContext)");
    expect(PAGE).toContain("deepLinkSalon(param, $salonContext)");
    expect(PAGE).toContain("salonContext.setSelection(linked)");
    expect(PAGE).toContain('url.searchParams.delete("salonId")');
  });

  it("[manage] „Planung verwalten“ is the primary action of the Planung tab, only after the panel reported canManage", () => {
    const head = PAGE.slice(PAGE.indexOf("<PageHead"), PAGE.indexOf("</PageHead>"));
    const planung = head.indexOf('{#if activeTab === "planung"}');
    expect(planung).toBeGreaterThan(-1);
    const manage = head.indexOf("{#if canManagePlan}", planung);
    expect(manage).toBeGreaterThan(planung);
    expect(head.slice(manage)).toContain('data-testid="leave-plan-manage"');
    expect(head.slice(manage)).toContain("Planung verwalten");
    expect(head.slice(manage)).toContain("manageOpen = true");
    // The create action belongs to the other two tabs; the old planner link button is gone.
    expect(head.indexOf("Neue Abwesenheit")).toBeGreaterThan(head.indexOf("{:else if"));
    expect(PAGE).not.toContain("leave-plan-link");
    expect(PAGE).not.toContain("Urlaubsplanung</a");
  });

  it("[create link] ?create=1&employeeId&date is read once in onMount and opens the dialog on whatever tab is active", () => {
    const mountAt = PAGE.indexOf("onMount(() => {");
    const mount = PAGE.slice(mountAt, PAGE.indexOf("\n  });", mountAt));
    expect(mount).toContain("deepLinkCreate = parseLeaveCreateDeepLink($page.url.searchParams)");
    const run = functionBody("runDeepLink");
    const create = run.slice(run.indexOf("const createLink = deepLinkCreate;"));
    expect(create).toContain('hasPermission($authStore.user, "leave-request:create:ZUGEWIESEN")');
    expect(create).toContain("createModalOpen = true");
    // No tab condition between reading the link and opening the dialog.
    expect(create).not.toContain("activeTab");
  });
});

describe("review WR-05 - a /team/leave?request= link finds a request outside the year list", () => {
  it("the deep link resolves the request against the year list and the open list of every year", () => {
    const run = functionBody("runDeepLink");
    expect(run).toContain("showLinkedRequest(requestId)");
    const show = functionBody("showLinkedRequest");
    expect(show).toContain("locateDeepLinkedRequest(requestId, allTeamRequests, pendingRequests)");
    // An open request of another year switches the filter and the year, then is highlighted.
    expect(show).toContain('status: "PENDING"');
    expect(show).toContain("datum: located.startDate");
    // A request nobody can show gets a calm message, never silence.
    expect(show).toContain("toasts.info(");
  });

  it("the highlight waits for the row instead of running on a list that does not hold it yet", () => {
    expect(PAGE).toContain("pendingFocusId");
    expect(PAGE).toMatch(/filteredTeamRequests\.some\(\(req\) => req\.id === id\)/);
  });

  it("the attendance reminder link string is unchanged (it dedupes by link)", () => {
    const checker = readRouteFile(
      "../../../api/src/contexts/time-tracking/plugins/attendance-checker.ts",
      "../api/src/contexts/time-tracking/plugins/attendance-checker.ts",
    );
    expect(checker).toContain("/team/leave?request=");
  });
});

describe("review IN-03 - the Anträge empty state follows the filtered list", () => {
  it("branches on the filtered rows and takes its words from the model", () => {
    expect(PAGE).toContain("{#if filteredTeamRequests.length === 0}");
    expect(PAGE).toContain("emptyRequestsText(urlState.status, listYear, requestSource.length)");
    expect(PAGE).not.toContain("<h3>Keine Anträge in {listYear}.</h3>");
  });
});
