// Issue #835 (D-835-21/22/33, AC-13, AC-14) - the planner, pinned from its source: a
// route page cannot be mounted (no `$app` alias), see admin-leave-limits-page-836.test.ts for the
// precedent. Since Issue #840 (plan 840-08) the planner logic lives in LeavePlanningPanel and the
// admin controls in ManagePlanDialog, so the pins read the host page, the panel and the dialog; both
// components have mounted tests of their own under lib/components/leave/__tests__. Every pin that
// changed with #840 carries a `#840` comment naming its decision. Since plan 840-12 `/leave/planung`
// is a redirect stub (D-840-03/31); the pins that read the old page now read the two hosts of the
// Planung tab (`/team/leave`, `/leave`) and the stub carries only the redirect.
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

// #840 (840-12): the old planner page is a redirect stub; the hosts carry the former page pins.
const STUB = readRouteFile(
  "../routes/(app)/leave/planung/+page.svelte",
  "src/routes/(app)/leave/planung/+page.svelte",
);
const TEAM_HOST = readRouteFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);
const MY_HOST = readRouteFile(
  "../routes/(app)/leave/+page.svelte",
  "src/routes/(app)/leave/+page.svelte",
);
const HOSTS = [TEAM_HOST, MY_HOST];
const PANEL = readRouteFile(
  "../lib/components/leave/LeavePlanningPanel.svelte",
  "src/lib/components/leave/LeavePlanningPanel.svelte",
);
const MANAGE = readRouteFile(
  "../lib/components/leave/ManagePlanDialog.svelte",
  "src/lib/components/leave/ManagePlanDialog.svelte",
);
// #840 G-6: status, deadline text and „Wunsch hinzufügen“ moved into the toolbar's component.
const CONTROLS = readRouteFile(
  "../lib/components/leave/LeavePlanControls.svelte",
  "src/lib/components/leave/LeavePlanControls.svelte",
);
const TIMELINE = readRouteFile(
  "../lib/components/leave/timeline/AbsenceTimeline.svelte",
  "src/lib/components/leave/timeline/AbsenceTimeline.svelte",
);
const LAYOUT = readRouteFile("../routes/(app)/+layout.svelte", "src/routes/(app)/+layout.svelte");

/** The markup of every animated block of the panel: from `<Card animate>` to its closing `</Card>`. */
function animatedBlocks(): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = PANEL.indexOf("<Card animate", from);
    if (start === -1) break;
    const end = PANEL.indexOf("</Card>", start);
    expect(end, "animated Card is not closed").toBeGreaterThan(start);
    blocks.push(PANEL.slice(start, end));
    from = end;
  }
  return blocks;
}

describe("Issue #835 - the planner (hosts of the Planung tab, #840)", () => {
  it("[vacuity gate] the page, panel and dialog sources are read and the panel has animated blocks", () => {
    expect(STUB.length).toBeGreaterThan(500);
    expect(TEAM_HOST.length).toBeGreaterThan(60_000);
    expect(MY_HOST.length).toBeGreaterThan(40_000);
    expect(PANEL.length).toBeGreaterThan(8_000);
    expect(MANAGE.length).toBeGreaterThan(3_000);
    expect(TIMELINE.length).toBeGreaterThan(10_000);
    // #840 (D-840-10): the legend sits in the timeline card, so there are two blocks, not three.
    // #840 G-6: the head card is gone (status, deadline and add moved into the toolbar), so the
    // panel has exactly one animated card.
    expect(animatedBlocks().length).toBe(1);
  });

  it("picks the one salon through teamSalonViewSalon and shows no second salon display (D-835-21/22, #840 D-840-14)", () => {
    for (const host of HOSTS) expect(host).toContain("teamSalonViewSalon(");
    expect(PANEL).toContain("isSalonFilterRejected(");
    // Under "Alle Salons" the panel asks for a salon instead of widening to every salon.
    // #840 (D-840-14): the sentence lost „Urlaubs“; the header select is the only salon display.
    expect(PANEL).toContain("Wähle oben einen Salon, um seine Planung zu sehen.");
    for (const host of HOSTS) expect(host).not.toContain("selectedSalonId");
    // #840 (D-840-14): replaces "labels the salon" - SalonScopeLabel is gone from the planner.
    for (const source of [STUB, PANEL]) {
      expect(source).not.toContain("SalonScopeLabel");
      expect(source).not.toContain("salonScopeLabel");
    }
  });

  it("composes the building blocks on the one timeline and switches on max-width: 767px (D-835-21, #840 D-840-07)", () => {
    // #840 (D-840-07, AC-6): AbsenceTimeline replaces LeavePlanTimeline, the old file is gone.
    expect(PANEL).toContain("<AbsenceTimeline");
    expect(PANEL).not.toContain("LeavePlanTimeline");
    expect(PANEL).toContain("LeavePlanWishList");
    expect(PANEL).toContain("LeavePlanWishDialog");
    expect(PANEL).toContain("LeavePlanTakeoverDialog");
    // #840 (D-840-15): the admin controls are the manage dialog.
    expect(PANEL).toContain("<ManagePlanDialog");
    expect(PANEL).toContain("max-width: 767px");
    // #840: both hosts mount the panel on their own toolbar (the old page is a stub).
    for (const host of HOSTS) {
      expect(host).toContain("<LeavePlanningPanel");
      expect(host).toContain("<LeaveToolbar");
    }
    expect(STUB).not.toContain("<LeavePlanningPanel");
  });

  it("guards stale answers with loadSeq and takes the year and anchor from the URL", () => {
    expect(PANEL).toContain("loadSeq");
    expect(PANEL).toMatch(/if \(mine !== loadSeq\) return;/);
    // #840 (D-840-13): the year is the period's, read from `zoom`/`datum`/`year` in one place
    // (`area-tabs`); the page no longer defaults to next year but to today's period.
    expect(TEAM_HOST).toContain("parseTeamLeaveState(");
    expect(MY_HOST).toContain("parseMyLeaveState(");
    for (const host of HOSTS) {
      expect(host).toContain("$page.url.searchParams");
      expect(host).not.toContain("getFullYear() + 1");
    }
    expect(PANEL).toContain("const year = $derived(period.year)");
  });

  it("writes only through the leave-plan API module, never a raw path", () => {
    // #840: the hosts are whole pages with requests of their own; the planner's writes live in the
    // panel and the dialog, and the stub carries no request at all.
    for (const source of [STUB, PANEL, MANAGE]) {
      for (const verb of ["get", "post", "put", "patch", "delete"]) {
        expect(source).not.toContain(`api.${verb}(`);
      }
    }
    expect(PANEL).toContain("updateWish(");
    expect(PANEL).toContain("createWish(");
    expect(PANEL).toContain("removeWish(");
    // #840 (D-840-15): open and deadline moved into the manage dialog and nowhere else.
    expect(MANAGE).toContain("setDeadline(");
    expect(MANAGE).toContain("openPlan(");
    expect(PANEL).not.toMatch(/\b(setDeadline|openPlan)\(/);
  });

  it("reloads the plan after a drag, accepted or refused, and shows the server message", () => {
    const move = PANEL.indexOf("async function moveWish");
    expect(move).toBeGreaterThan(-1);
    const body = PANEL.slice(move, PANEL.indexOf("\n  }\n", move));
    expect(body).toContain("planErrorMessage(err)");
    expect(body).toContain("await reload()");
  });

  it("keeps the admin controls out of the work surface and offers Planung verwalten only on the server's word (T-840-23, #840 D-840-15)", () => {
    // #840 (D-840-15): replaces "lets a manager open a plan from the page" - the page offers the
    // dialog from its primary action, only when the panel reported canManage.
    // #840 (840-12): the team host offers it (the personal host has no manage controls, E-03).
    expect(TEAM_HOST).toContain("{#if canManagePlan}");
    expect(TEAM_HOST).toContain("onViewer={(viewer) => (canManagePlan = viewer.canManage)}");
    expect(TEAM_HOST).toContain("Planung verwalten");
    expect(MY_HOST).not.toContain("Planung verwalten");
    expect(PANEL).toContain("viewer.canManage");
    expect(MANAGE).toContain("Plan eröffnen");
    for (const adminControl of [
      "leave-plan-open",
      "leave-plan-takeover",
      "Frist speichern",
      "Frist entfernen",
      'id="plan-deadline"',
    ]) {
      expect(PANEL, adminControl).not.toContain(adminControl);
      for (const host of HOSTS) expect(host, adminControl).not.toContain(adminControl);
    }
    // #840 (D-840-14): the calm empty-state sentence changed from the #835 wording to this one.
    expect(PANEL).toContain("Für dieses Jahr ist noch keine Planung eröffnet.");
  });

  it("shows the deadline hint, the expiry and the own-edit lock (AC-13)", () => {
    expect(PANEL).toContain("Wünsche bis");
    expect(PANEL).toContain("Frist abgelaufen");
    expect(PANEL).toContain("viewer.ownEditLocked");
    // #840 (D-840-15): a non-manager's deadline is read-only text; the testid `leave-plan-deadline`
    // belongs to the section button of the dialog.
    // #840 G-6: the panel builds the text, the toolbar component renders it.
    expect(CONTROLS).toContain('data-testid="leave-plan-deadline-text"');
    expect(PANEL).not.toContain('data-testid="leave-plan-deadline-text"');
    expect(PANEL).not.toContain('data-testid="leave-plan-deadline"');
    expect(CONTROLS).not.toContain('data-testid="leave-plan-deadline"');
    expect(MANAGE).toContain('data-testid="leave-plan-deadline"');
  });

  it("places no dialog inside an animated block (#570)", () => {
    for (const block of animatedBlocks()) {
      expect(block).not.toMatch(/<Modal|<ConfirmDialog|<ReasonDialog/);
      expect(block).not.toContain("<LeavePlanWishDialog");
      expect(block).not.toContain("<LeavePlanTakeoverDialog");
      expect(block).not.toContain("<ManagePlanDialog");
    }
    expect(PANEL).toContain("<LeavePlanWishDialog");
    expect(PANEL).toContain("<LeavePlanTakeoverDialog");
    expect(PANEL).toContain("<ManagePlanDialog");
  });

  it("carries the data-testids the e2e spec uses", () => {
    // #840: the testids moved with their elements (panel root, manage dialog, host action).
    // #840 G-6: `leave-plan-head` and `leave-plan-add-wish` live in LeavePlanControls (toolbar), both
    // hosts mount it, and the panel hands the controls over through `onControls`.
    for (const id of ["leave-plan-head", "leave-plan-add-wish"]) {
      expect(CONTROLS).toContain(`data-testid="${id}"`);
      expect(PANEL).not.toContain(`data-testid="${id}"`);
    }
    for (const host of HOSTS) {
      expect(host).toContain("<LeavePlanControls");
      expect(host).toContain("onControls={(controls) => (planControls = controls)}");
    }
    for (const id of [
      "leave-plan-page",
      "leave-plan-locked",
      "leave-plan-lock-hint",
      "leave-plan-error",
      "leave-plan-timeline-host",
      "leave-plan-legend",
    ]) {
      expect(PANEL).toContain(`data-testid="${id}"`);
    }
    for (const id of ["leave-plan-open", "leave-plan-takeover", "leave-plan-deadline"]) {
      expect(MANAGE).toContain(`data-testid="${id}"`);
    }
    expect(TEAM_HOST).toContain('data-testid="leave-plan-manage"');
    // Rendered by the timeline component, mounted by the panel.
    for (const id of [
      'data-testid="plan-track-{person.employeeId}"',
      'data-testid="leave-plan-wish-{bar.key}"',
      'data-testid="leave-plan-wish-handle-end-{bar.key}"',
    ]) {
      expect(TIMELINE).toContain(id);
    }
  });

  it("has no layout title of its own any more and uses no legacy tokens", () => {
    // #840 D-840-06: the label left `PAGE_LABELS` with the page - `/leave/planung` is a redirect
    // stub and the hosts are titled „Abwesenheiten“.
    expect(LAYOUT).not.toContain('"/leave/planung"');
    expect(LAYOUT).not.toContain('"Urlaubsplanung"');
    for (const source of [STUB, PANEL, MANAGE]) {
      expect(source).not.toMatch(/var\(--(color-|glass-|radius-|gray-)/);
    }
  });

  it("takes the open-wish count from the server's close rule, never recounts it (WR-01, D-835-38)", () => {
    // A linked wish whose approval was refused counts as open; only the API knows that rule.
    expect(PANEL).toContain("plan?.openWishCount ?? 0");
    // #840 (D-840-15): the takeover button lives in the dialog and is disabled without open wishes.
    expect(MANAGE).toContain("!openWishCount");
    expect(PANEL).not.toMatch(/wishes\.filter\(\(w\) => w\.leaveRequestId === null/);
  });

  it("honours the deep link's ?salonId through the salon context, then drops it (WR-07)", () => {
    // #840 (840-12): the notice links to `/leave/planung?salonId=…`; the stub forwards the salon and
    // both hosts keep the deep-link handling.
    for (const host of HOSTS) {
      expect(host).toContain('searchParams.get("salonId")');
      expect(host).toContain("deepLinkSalon(param, $salonContext)");
      expect(host).toContain("salonContext.setSelection(linked)");
      expect(host).toContain('url.searchParams.delete("salonId")');
      // A host still reads its salon only through the selection (never straight from the URL).
      expect(host).toContain("teamSalonViewSalon($salonContext)");
    }
  });

  it("the old planner URL is a redirect stub that carries only the redirect (D-840-03/31, T-840-38)", () => {
    expect(STUB).toContain("planungRedirect(");
    expect(STUB).toContain('hasPermission($authStore.user, "leave-plan:manage:ZUGEWIESEN")');
    expect(STUB).toMatch(/onMount\(\(\) =>\s*goto\(/);
    expect(STUB).toContain("replaceState: true");
    // No template, no head, no request: the template part is empty.
    expect(STUB.replace(/<script[\s\S]*?<\/script>/g, "").trim()).toBe("");
    // The target is never assembled from the URL here.
    expect(STUB).not.toContain("searchParams.get(");
  });

  it("asks the personal planner for the neutral reading and gives it no manage dialog (E-03, T-840-24)", () => {
    expect(PANEL).toContain('{ view: "own" }');
    expect(PANEL).toContain('{#if mode === "team" && salonId !== null}');
  });
});
