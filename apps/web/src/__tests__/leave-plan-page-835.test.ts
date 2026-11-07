// Issue #835 (D-835-21/22/33, AC-13, AC-14) - the /leave/planung page, pinned from its source: a
// route page cannot be mounted (no `$app` alias), see admin-leave-limits-page-836.test.ts for the
// precedent. The building blocks (timeline, wish dialog, list, takeover dialog) have mounted tests
// of their own under lib/components/leave/__tests__.
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
const LAYOUT = readRouteFile("../routes/(app)/+layout.svelte", "src/routes/(app)/+layout.svelte");
const TIMELINE = readRouteFile(
  "../lib/components/leave/LeavePlanTimeline.svelte",
  "src/lib/components/leave/LeavePlanTimeline.svelte",
);

/** The markup of every animated block: from `<Card animate>` to its closing `</Card>`. */
function animatedBlocks(): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = PAGE.indexOf("<Card animate", from);
    if (start === -1) break;
    const end = PAGE.indexOf("</Card>", start);
    expect(end, "animated Card is not closed").toBeGreaterThan(start);
    blocks.push(PAGE.slice(start, end));
    from = end;
  }
  return blocks;
}

describe("Issue #835 - /leave/planung", () => {
  it("[vacuity gate] the page source is read and has animated blocks", () => {
    expect(PAGE.length).toBeGreaterThan(5_000);
    expect(animatedBlocks().length).toBeGreaterThanOrEqual(3);
  });

  it("picks the one salon through teamSalonViewSalon and labels it (D-835-21/22)", () => {
    expect(PAGE).toContain("teamSalonViewSalon(");
    expect(PAGE).toContain("SalonScopeLabel");
    expect(PAGE).toContain("isSalonFilterRejected(");
    // Under "Alle Salons" the page asks for a salon instead of widening to every salon.
    expect(PAGE).toContain("Wähle oben einen Salon, um seine Urlaubsplanung zu sehen.");
    expect(PAGE).not.toContain("selectedSalonId");
  });

  it("composes the building blocks and switches on max-width: 767px (D-835-21)", () => {
    expect(PAGE).toContain("LeavePlanTimeline");
    expect(PAGE).toContain("LeavePlanWishList");
    expect(PAGE).toContain("LeavePlanWishDialog");
    expect(PAGE).toContain("LeavePlanTakeoverDialog");
    expect(PAGE).toContain("max-width: 767px");
  });

  it("guards stale answers with loadSeq and reads the year from ?year", () => {
    expect(PAGE).toContain("loadSeq");
    expect(PAGE).toMatch(/if \(mine !== loadSeq\) return;/);
    expect(PAGE).toContain('searchParams.get("year")');
    expect(PAGE).toContain("getFullYear() + 1");
  });

  it("writes only through the leave-plan API module, never a raw path", () => {
    for (const verb of ["get", "post", "put", "patch", "delete"]) {
      expect(PAGE).not.toContain(`api.${verb}(`);
    }
    expect(PAGE).toContain("updateWish(");
    expect(PAGE).toContain("createWish(");
    expect(PAGE).toContain("removeWish(");
    expect(PAGE).toContain("setDeadline(");
    expect(PAGE).toContain("openPlan(");
  });

  it("reloads the plan after a drag, accepted or refused, and shows the server message", () => {
    const move = PAGE.indexOf("async function moveWish");
    expect(move).toBeGreaterThan(-1);
    const body = PAGE.slice(move, PAGE.indexOf("\n  }\n", move));
    expect(body).toContain("planErrorMessage(err)");
    expect(body).toContain("await reload()");
  });

  it("lets a manager (hint only) open a plan and offers a read-only text to others", () => {
    expect(PAGE).toContain('hasPermission($authStore.user, "leave-plan:manage:ZUGEWIESEN")');
    expect(PAGE).toContain("Urlaubsplanung eröffnen");
    expect(PAGE).toContain("Für dieses Jahr gibt es noch keine Urlaubsplanung.");
  });

  it("shows the deadline hint, the expiry and the own-edit lock (AC-13)", () => {
    expect(PAGE).toContain("Wünsche bis");
    expect(PAGE).toContain("Frist abgelaufen");
    expect(PAGE).toContain("viewer.ownEditLocked");
  });

  it("places no dialog inside an animated block (#570)", () => {
    for (const block of animatedBlocks()) {
      expect(block).not.toMatch(/<Modal|<ConfirmDialog|<ReasonDialog/);
      expect(block).not.toContain("<LeavePlanWishDialog");
      expect(block).not.toContain("<LeavePlanTakeoverDialog");
    }
    expect(PAGE).toContain("<LeavePlanWishDialog");
    expect(PAGE).toContain("<LeavePlanTakeoverDialog");
  });

  it("carries the data-testids the e2e spec uses", () => {
    for (const id of [
      "leave-plan-page",
      "leave-plan-open",
      "leave-plan-add-wish",
      "leave-plan-takeover",
    ]) {
      expect(PAGE).toContain(`data-testid="${id}"`);
    }
    // Rendered by the timeline component, mounted by the page.
    for (const id of [
      'data-testid="leave-plan-timeline"',
      'data-testid="leave-plan-wish-{wish.id}"',
      'data-testid="leave-plan-wish-handle-end-{wish.id}"',
    ]) {
      expect(TIMELINE).toContain(id);
    }
  });

  it("is titled in the layout and uses no legacy tokens", () => {
    expect(LAYOUT).toContain('"/leave/planung": "Urlaubsplanung"');
    expect(PAGE).not.toMatch(/var\(--(color-|glass-|radius-|gray-)/);
  });

  it("takes the open-wish count from the server's close rule, never recounts it (WR-01, D-835-38)", () => {
    // A linked wish whose approval was refused counts as open; only the API knows that rule.
    expect(PAGE).toContain("plan?.openWishCount ?? 0");
    expect(PAGE).toContain("disabled={openWishCount === 0}");
    expect(PAGE).not.toMatch(/wishes\.filter\(\(w\) => w\.leaveRequestId === null/);
  });
});
