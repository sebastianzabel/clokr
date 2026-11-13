// Issue #840 (plan 840-10; E-01, E-02, E-06, D-840-01/13/14/17) - source pins of the team absence
// page: one page „Abwesenheiten“ with the tabs Übersicht / Anträge / Planung on ONE tab strip.
//
// Issue #853 (plan 853-08, D-853-11/18/19): the page head is the #887 head (no eyebrow), the strip
// is the PageTabs block in panel mode (it replaced LeaveToolbar on this page), and the period,
// zoom, search and „Personenkreis“ filter sit in one toolbar row inside the panel. The pins below
// keep their meaning and read the new markup.
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

describe("Issue #840 E-01 - one page, one tab strip, one timeline", () => {
  it("[vacuity gate] the page source is loaded and is the host page", () => {
    expect(PAGE.length).toBeGreaterThan(60_000);
    // #853 (D-853-19): the head tag names the route label and passes no eyebrow and no accent.
    expect(PAGE).toMatch(/<PageHead\s+title=\{pageLabel\("\/team\/leave"\)\}/);
    const head = PAGE.slice(PAGE.indexOf("<PageHead"), PAGE.indexOf("</PageHead>"));
    expect(head).not.toContain("eyebrow");
    expect(head).not.toContain("accent");
  });

  it("[one tab strip] exactly one PageTabs carries the tabs; period, zoom, search and the planner controls sit in the panels' toolbar row", () => {
    expect(count(PAGE, "<PageTabs")).toBe(1);
    expect(count(PAGE, "<LeaveToolbar")).toBe(0);
    expect(PAGE).toContain('tabsLabel="Abwesenheiten"');
    expect(PAGE).toContain('testIdPrefix="leave-team-view"');
    expect(PAGE).toContain("tabs={leaveTabs}");
    expect(PAGE).toContain("panel={leavePanel}");
    expect(count(PAGE, "<PeriodSwitcher")).toBe(1);
    expect(count(PAGE, "<SegmentedControl")).toBe(1);
    // #853 (853-13): one toolbar per list tab - the person search of the Übersicht, and the
    // Anträge toolbar (search, Status, Art) that is rendered through one snippet.
    expect(count(PAGE, "<TableToolbar")).toBe(2);
    // #840 G-6: on Planung the toolbar row holds the planner controls (status, deadline, add).
    expect(PAGE).toContain("{@render plannerControls()}");
    expect(count(PAGE, "<LeavePlanControls")).toBe(1);
  });

  it("[tabs] the three tabs are Übersicht / Anträge / Planung, the Anträge one badged and named „list“", () => {
    expect(PAGE).toContain('{ value: "uebersicht", label: "Übersicht" }');
    // #840 G-1: the count is the open requests of the salon selection (NOT narrowed by the person
    // filter), with its explanation, and a click on it opens the „Offen“ filter.
    expect(PAGE).toContain("openRequestsSummary(pendingRequests)");
    expect(PAGE).not.toContain("filteredPendingRequests");
    const tabs = PAGE.slice(PAGE.indexOf("const leaveTabs = $derived("));
    const antraege = tabs.slice(
      tabs.indexOf('value: "antraege"'),
      tabs.indexOf('value: "planung"'),
    );
    expect(antraege).toContain("badge: openSummary?.count");
    expect(antraege).toContain("badgeLabel: openSummary?.label");
    expect(antraege).toContain("onBadgeSelect: openOpenRequests");
    expect(PAGE).toContain('testId: "list"');
    const select = PAGE.slice(PAGE.indexOf("function openOpenRequests("));
    const selectBody = select.slice(0, select.indexOf("\n  }\n"));
    expect(selectBody).toContain('tab: "antraege"');
    expect(selectBody).toContain('status: "PENDING"');
    // The type filter is the one page-local filter that could still hide a counted row.
    expect(selectBody).toContain('filterLeaveType = ""');
    expect(PAGE).toContain('{ value: "planung", label: "Planung" }');
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
    expect(functionBody("onZoomSelected")).toContain("void navigate({ zoom }, true)");
    expect(PAGE).toContain("void navigate({ datum: today }, true)");
    expect(PAGE).toContain("shiftPeriod(toolbarPeriod.zoom, urlState.datum, step)");
  });

  it("[panels] every tab has its own panel, rendered by PageTabs (role=tabpanel, labelled by its tab)", () => {
    // PageTabs in panel mode renders one bits-ui Tabs.Content per tab (role=tabpanel,
    // aria-labelledby its trigger - proven in PageTabs-853.test.ts); the page fills each through the
    // `leavePanel` snippet, which holds content only for the active tab.
    expect(PAGE).toContain("{#snippet leavePanel(value: string)}");
    expect(PAGE).toContain("{#if value === activeTab}");
    for (const id of ["uebersicht", "antraege", "planung"]) {
      expect(PAGE, id).toMatch(new RegExp(`\\{(#|:else )if value === "${id}"\\}`));
    }
    // The old hand-written panel wrappers are gone.
    expect(PAGE).not.toContain('role="tabpanel"');
  });

  it("[one timeline] the Übersicht mounts one AbsenceTimeline and the phone list, both on the same rows", () => {
    expect(count(PAGE, "<AbsenceTimeline")).toBe(1);
    expect(count(PAGE, "<AbsenceList")).toBe(1);
    expect(count(PAGE, "<LeaveLegend")).toBe(1);
    expect(PAGE).toContain("period={overviewPeriod}");
    expect(PAGE).toContain("closedWeekdays={werktage}");
    expect(PAGE).toContain("load={overviewLoad}");
  });

  it("[circle] the default circle comes from the model and the URL, never from a role or permission (#853, D-853-12)", () => {
    const at = PAGE.indexOf("const circlePeople = $derived(");
    expect(at).toBeGreaterThan(-1);
    const circle = PAGE.slice(at, PAGE.indexOf("\n  );", at));
    expect(circle).toContain("inLeaderReach(");
    expect(circle).toContain("rosterIds");
    expect(circle).toContain("urlState.allSalons");
    expect(circle).not.toContain("hasPermission");
    expect(circle).not.toContain("role");
    // One filter „Personenkreis“ with the one option „Alle Salons“, written to the URL (kreis=alle).
    expect(PAGE).toContain('label: "Personenkreis"');
    expect(PAGE).toContain('options: [{ value: "alle", label: "Alle Salons" }]');
    expect(PAGE).toContain('void navigate({ allSalons: picked === "alle" }, true)');
  });

  it("[rows] every person of the page's own list is a row even without a bar", () => {
    expect(PAGE).toContain("overviewPersons(overviewRows, employees,");
    // #853 (D-853-12): the default circle is the leader's reach, decided in the model; the search
    // narrows the circle by name and replaced the hand-rolled person filter.
    expect(PAGE).toContain("inLeaderReach(");
    expect(PAGE).toContain("urlState.allSalons");
    expect(PAGE).toContain("matchesSearch(row.name, personQuery)");
    expect(PAGE).not.toContain("filterEmployeeId");
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
  it("[status filter] six choices (five statuses and „Alle“), the state lives in the URL and the filter writes it with replaceState", () => {
    // #853 (853-13): the two selects became the Status and Art filters of the table toolbar. The
    // choices are the same; „Alle“ is the toolbar's own „off“ option, the rest is the option list.
    const at = PAGE.indexOf("const STATUS_FILTER_OPTIONS");
    expect(at).toBeGreaterThan(-1);
    const options = PAGE.slice(at, PAGE.indexOf("];", at));
    for (const option of [
      '{ value: "PENDING", label: "Offen" }',
      '{ value: "APPROVED", label: "Genehmigt" }',
      '{ value: "CANCELLATION_REQUESTED", label: "Stornierung beantragt" }',
      '{ value: "REJECTED", label: "Abgelehnt" }',
      '{ value: "CANCELLED", label: "Storniert" }',
    ]) {
      expect(options, option).toContain(option);
    }
    expect(PAGE).toContain(
      '{ key: "status", label: "Status", options: STATUS_FILTER_OPTIONS, value: filterLeaveStatus }',
    );
    const change = functionBody("onRequestFilterChange");
    expect(change).toContain("void navigate({ status:");
    expect(change).toContain("}, true)");
    // The reset is ONE URL write, and it clears the search and the Art filter with it.
    const reset = functionBody("resetRequestFilters");
    expect(reset).toContain("void navigate({ status: null }, true)");
    expect(reset).toContain('filterLeaveType = ""');
    expect(reset).toContain('requestQuery = ""');
    expect(PAGE).toContain("onFilterChange={onRequestFilterChange}");
    expect(PAGE).toContain("onReset={resetRequestFilters}");
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
    // #853 (853-13): the status badge is the Chip block, toned by the status.
    expect(PAGE).toContain("<Chip tone={statusTone(req.status)}>{statusLabel(req.status)}</Chip>");
    expect(PAGE).not.toContain("statusClass(");
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
    // #853 (853-13): the mark is the DataTable's highlight row tone.
    expect(PAGE).toContain('highlightRequestId === row.id ? "highlight" : undefined');
    expect(PAGE).toContain("rowTone={requestRowTone}");
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
    const tabPanel = PAGE.lastIndexOf('{:else if value === "planung"}', at);
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
    expect(head.indexOf("Abwesenheit eintragen")).toBeGreaterThan(head.indexOf("{:else if"));
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

describe("Issue #853 (853-13) - the Anträge table and the create flow ask for whom first", () => {
  it("[Anträge table] one DataTable over the paged requests, the toolbar searches by person name", () => {
    expect(count(PAGE, "<DataTable")).toBe(2); // the loading skeleton and the rows
    expect(PAGE).toContain("pagedTeamRequests.map((req) => ({ id: req.id, req }))");
    expect(PAGE).toContain(
      "matchesSearch(`${req.employee.firstName} ${req.employee.lastName}`, requestQuery)",
    );
    expect(PAGE).toContain("rowTestId={requestRowTestId}");
    expect(PAGE).toContain("`leave-team-row-${row.id}`");
    // The tab badge jump and a bar click leave no search behind that could hide a counted row.
    expect(functionBody("openOpenRequests")).toContain('requestQuery = ""');
    expect(functionBody("selectBar")).toContain('requestQuery = ""');
  });

  it("[Für wen?] the picker is the first field, offered only to a caller who may file for others", () => {
    expect(count(PAGE, "Für wen?")).toBe(1);
    expect(PAGE).toContain("<PersonPicker items={createPersonItems} bind:value={createEmployeeId}");
    expect(PAGE).toContain("personPicker={canCreateForOthers ? personPicker : undefined}");
    expect(PAGE).toContain("deferUntilPerson={canCreateForOthers}");
    expect(PAGE).toContain(
      'const canCreateForOthers = $derived(\n    hasPermission($authStore.user, "leave-request:create:ZUGEWIESEN"),',
    );
    // Nobody is preselected for a caller who may file for others; everyone else files their own.
    expect(functionBody("openCreate")).toContain(
      'createEmployeeId = canCreateForOthers ? "" : ($authStore.user?.employeeId ?? "")',
    );
    // The picker lists the page's own reach-narrowed roster, never a second read.
    expect(PAGE).toContain("const createPersonItems = $derived(personOptions(employees))");
    // The old select is gone.
    expect(PAGE).not.toContain('id="create-emp"');
  });

  it("[deep link] ?create=1 still preselects the person from the roster, only with the create-for-others key", () => {
    const run = functionBody("runDeepLink");
    expect(run).toContain('hasPermission($authStore.user, "leave-request:create:ZUGEWIESEN")');
    expect(run).toContain(
      "employees.find((emp) => emp.id.toLowerCase() === createLink.employeeId)",
    );
    expect(run).toContain('createEmployeeId = person ? person.id : ""');
  });
});
