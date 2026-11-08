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
    expect(PAGE).toContain('<PageHead eyebrow="Team" title="Abwesenheiten">');
  });

  it("[one toolbar] exactly one LeaveToolbar carries tabs, period, zoom and the person filter", () => {
    expect(count(PAGE, "<LeaveToolbar")).toBe(1);
    expect(PAGE).toContain('ariaLabel="Abwesenheiten"');
    expect(PAGE).toContain('testIdPrefix="leave-team-view"');
    expect(PAGE).toContain("tabs={toolbarTabs}");
    expect(PAGE).toContain('filters={activeTab === "planung" ? undefined : personFilter}');
  });

  it("[tabs] the three tabs are Übersicht / Anträge / Planung, the Anträge one badged and named „list“", () => {
    expect(PAGE).toContain('{ id: "uebersicht", label: "Übersicht" }');
    expect(PAGE).toContain(
      'id: "antraege", label: "Anträge", badge: filteredPendingRequests.length',
    );
    expect(PAGE).toContain('testId: "list"');
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
    expect(PAGE).toContain("closedWeekdays={closedDays.days}");
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
    expect(PAGE).toContain("<Pagination");
  });

  it("[PENDING marking] an open row carries the „Offen“ badge and the dashed chip of the beantragt style", () => {
    expect(functionBody("statusLabel")).toContain('? "Offen"');
    expect(PAGE).not.toContain('"Ausstehend"');
    expect(PAGE).toContain('class:req-chip--requested={req.status === "PENDING"}');
    expect(PAGE).toContain("data-row-status={req.status}");
    expect(PAGE).toContain("border: 1.5px dashed currentColor;");
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
