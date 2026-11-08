// Issue #835 (D-835-21/22/33, AC-13, AC-14) - the /leave/planung page, pinned from its source: a
// route page cannot be mounted (no `$app` alias), see admin-leave-limits-page-836.test.ts for the
// precedent. Since Issue #840 (plan 840-08) the planner logic lives in LeavePlanningPanel and the
// admin controls in ManagePlanDialog, so the pins read the host page, the panel and the dialog; both
// components have mounted tests of their own under lib/components/leave/__tests__. Every pin that
// changed with #840 carries a `#840` comment naming its decision.
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
  "../routes/(app)/leave/planung/+page.svelte",
  "src/routes/(app)/leave/planung/+page.svelte",
);
const PANEL = readRouteFile(
  "../lib/components/leave/LeavePlanningPanel.svelte",
  "src/lib/components/leave/LeavePlanningPanel.svelte",
);
const MANAGE = readRouteFile(
  "../lib/components/leave/ManagePlanDialog.svelte",
  "src/lib/components/leave/ManagePlanDialog.svelte",
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

describe("Issue #835 - /leave/planung", () => {
  it("[vacuity gate] the page, panel and dialog sources are read and the panel has animated blocks", () => {
    expect(PAGE.length).toBeGreaterThan(2_000);
    expect(PANEL.length).toBeGreaterThan(8_000);
    expect(MANAGE.length).toBeGreaterThan(3_000);
    expect(TIMELINE.length).toBeGreaterThan(10_000);
    // #840 (D-840-10): the legend sits in the timeline card, so there are two blocks, not three.
    expect(animatedBlocks().length).toBeGreaterThanOrEqual(2);
  });

  it("picks the one salon through teamSalonViewSalon and shows no second salon display (D-835-21/22, #840 D-840-14)", () => {
    expect(PAGE).toContain("teamSalonViewSalon(");
    expect(PANEL).toContain("isSalonFilterRejected(");
    // Under "Alle Salons" the panel asks for a salon instead of widening to every salon.
    // #840 (D-840-14): the sentence lost „Urlaubs“; the header select is the only salon display.
    expect(PANEL).toContain("Wähle oben einen Salon, um seine Planung zu sehen.");
    expect(PAGE).not.toContain("selectedSalonId");
    // #840 (D-840-14): replaces "labels the salon" - SalonScopeLabel is gone from the planner.
    for (const source of [PAGE, PANEL]) {
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
    // The page is a thin host of the panel.
    expect(PAGE).toContain("<LeavePlanningPanel");
    expect(PAGE).toContain("<LeaveToolbar");
  });

  it("guards stale answers with loadSeq and takes the year and anchor from the URL", () => {
    expect(PANEL).toContain("loadSeq");
    expect(PANEL).toMatch(/if \(mine !== loadSeq\) return;/);
    // #840 (D-840-13): the year is the period's, read from `zoom`/`datum`/`year` in one place
    // (`area-tabs`); the page no longer defaults to next year but to today's period.
    expect(PAGE).toContain("parseTeamLeaveState(");
    expect(PAGE).toContain("$page.url.searchParams");
    expect(PANEL).toContain("const year = $derived(period.year)");
    expect(PAGE).not.toContain("getFullYear() + 1");
  });

  it("writes only through the leave-plan API module, never a raw path", () => {
    for (const source of [PAGE, PANEL, MANAGE]) {
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
    expect(PAGE).toContain('hasPermission($authStore.user, "leave-plan:manage:ZUGEWIESEN")');
    expect(PAGE).toContain("{#if canManage}");
    expect(PAGE).toContain("Planung verwalten");
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
      expect(PAGE, adminControl).not.toContain(adminControl);
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
    expect(PANEL).toContain('data-testid="leave-plan-deadline-text"');
    expect(PANEL).not.toContain('data-testid="leave-plan-deadline"');
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
    for (const id of [
      "leave-plan-page",
      "leave-plan-head",
      "leave-plan-add-wish",
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
    expect(PAGE).toContain('data-testid="leave-plan-manage"');
    // Rendered by the timeline component, mounted by the panel.
    for (const id of [
      'data-testid="plan-track-{person.employeeId}"',
      'data-testid="leave-plan-wish-{bar.key}"',
      'data-testid="leave-plan-wish-handle-end-{bar.key}"',
    ]) {
      expect(TIMELINE).toContain(id);
    }
  });

  it("is titled in the layout and uses no legacy tokens", () => {
    // Unchanged on purpose: 840-12 changes the layout labels together with the redirect.
    expect(LAYOUT).toContain('"/leave/planung": "Urlaubsplanung"');
    for (const source of [PAGE, PANEL, MANAGE]) {
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
    expect(PAGE).toContain('searchParams.get("salonId")');
    expect(PAGE).toContain("deepLinkSalon(param, $salonContext)");
    expect(PAGE).toContain("salonContext.setSelection(linked)");
    expect(PAGE).toContain('url.searchParams.delete("salonId")');
    // The page still reads its salon only through the selection (never straight from the URL).
    expect(PAGE).toContain("teamSalonViewSalon($salonContext)");
  });

  it("asks the personal planner for the neutral reading and gives it no manage dialog (E-03, T-840-24)", () => {
    expect(PANEL).toContain('{ view: "own" }');
    expect(PANEL).toContain('{#if mode === "team" && salonId !== null}');
  });
});
