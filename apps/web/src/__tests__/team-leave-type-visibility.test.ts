// Phase 257 (GitHub issue #257) — the team calendar's absence bars and legend, pinned at source.
//
// Why source-read and not mounted: apps/web/vitest.config.ts registers no `$app/*` alias and this
// page imports `{ page } from "$app/stores"`, so it cannot be mounted here — the same wall
// team-leave-attest-action.test.ts documents. The behaviour itself is unit-tested in
// src/lib/leave/__tests__/team-calendar-visibility.test.ts; this file pins that the PAGE actually
// routes through that module, at every one of the three render points that used to carry their
// own copy of the check (background, title, label — D-10).
//
// `lint:ui-classes` does not scan `routes/**`. This file is the only automated net for this page.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { LEAVE_TYPE_OPTIONS } from "$lib/leave/team-calendar-visibility";

const SHARED_FORM = readRouteFile(
  "../lib/components/leave/LeaveRequestForm.svelte",
  "src/lib/components/leave/LeaveRequestForm.svelte",
);

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

describe("team leave page — one shared visibility decision (Phase 257)", () => {
  // #840 (D-840-07/10, plan 840-10): the month grid and its hand-written chip are gone from the page.
  // A bar is drawn by `AbsenceTimeline` (and listed by `AbsenceList`) from the model of
  // `timeline-model.ts`, whose rows the SERVER has already masked per person (D-840-19): a foreign
  // absence outside the reader's reach arrives with no type, and the neutral word is the model's
  // `NEUTRAL_CHIP_LABEL`. Groups A and B therefore pin the same invariants against the files that
  // now carry them; Group C (the type dropdowns) is unchanged.
  const TIMELINE = readRouteFile(
    "../lib/components/leave/timeline/AbsenceTimeline.svelte",
    "src/lib/components/leave/timeline/AbsenceTimeline.svelte",
  );
  const LIST = readRouteFile(
    "../lib/components/leave/timeline/AbsenceList.svelte",
    "src/lib/components/leave/timeline/AbsenceList.svelte",
  );
  const MODEL = readRouteFile("../lib/leave/timeline-model.ts", "src/lib/leave/timeline-model.ts");

  it("Test 0: the page and the files that now carry the bars actually loaded", () => {
    expect(PAGE.length).toBeGreaterThan(50_000);
    expect(TIMELINE.length).toBeGreaterThan(10_000);
    expect(LIST.length).toBeGreaterThan(1_000);
    expect(MODEL.length).toBeGreaterThan(5_000);
    // #840 D-840-10: the legend is the one <LeaveLegend> component.
    expect(PAGE).toContain("<LeaveLegend");
    expect(PAGE).toContain("<AbsenceTimeline");
  });

  describe("Group A — one decision, no copy on the page (D-10, AC-1, AC-2)", () => {
    it("A1: the page decides no chip visual and filters no colleague's bar itself", () => {
      // Formerly: resolveChipVisual was called exactly once on the page. Now there is no call at
      // all - the server masks the row, the model carries `typeCode: null`, the component draws it.
      expect(PAGE).not.toContain("resolveChipVisual(");
      expect(PAGE).not.toContain("isDrawnInCalendar(");
      expect(PAGE).not.toContain("canSeeLeaveType(");
    });

    it("A2: a masked row becomes a bar with no type and the neutral label, in the model", () => {
      expect(MODEL).toContain("typeCode: null");
      expect(MODEL).toContain("NEUTRAL_CHIP_LABEL");
      expect(MODEL).toContain('style: "abwesend"');
    });

    it("A3: the timeline colours a bar from the type table, a typeless bar from the neutral colour", () => {
      expect(TIMELINE).toContain('if (bar.style === "abwesend") return ABSENT;');
      expect(TIMELINE).toContain('style:--bar-text="var({color.text})"');
      expect(TIMELINE).toContain('style:--bar-fill="var({color.fill})"');
    });

    it("A4: the list names the type by text and shows the model's label for a masked bar", () => {
      expect(LIST).toContain("bar.label");
      expect(LIST).not.toContain("typeName");
    });

    it("A5: the old machinery is gone", () => {
      expect(PAGE).not.toContain("function typeColor(");
      expect(PAGE).not.toContain("typeColor(");
      expect(PAGE).not.toContain("const TYPE_OPTIONS");
      expect(PAGE).not.toContain("cal-chip");
    });

    it("A6: the neutral word is not hand-typed on the page or in the bar components", () => {
      // It lives in the module as NEUTRAL_CHIP_LABEL, so a future author cannot reintroduce it
      // next to a coloured background.
      for (const [name, src] of [
        ["page", PAGE],
        ["timeline", TIMELINE],
        ["list", LIST],
      ] as const) {
        expect(src, name).not.toContain('"abwesend"\n');
        expect(src.includes(">abwesend<"), name).toBe(false);
      }
    });
  });

  describe("Group B — the legend (D-05, D-06, AC-3, AC-4)", () => {
    // #840 D-840-10: the legend is the one <LeaveLegend> component (rendering pinned in
    // LeaveLegend.test.ts). What stays pinned HERE is the page's side of D-05: which codes it hands
    // over. Since 840-10 they are the types that actually OCCUR in the view (`legendFrom`), and a
    // typeless (masked) bar contributes none - so the legend can never name a type the reader may
    // not learn, which is what the former `canSeeLeaveType` gate guaranteed.
    const lStart = PAGE.indexOf("<LeaveLegend");
    const lEnd = PAGE.indexOf("/>", lStart);
    const LEGEND = lStart > -1 && lEnd > lStart ? PAGE.slice(lStart, lEnd) : "";

    it("legend markers were found", () => {
      expect(lStart).toBeGreaterThan(-1);
      expect(lEnd).toBeGreaterThan(lStart);
    });

    it("B1: the type codes come from the occurring bars, not from hand-written spans", () => {
      expect(LEGEND).toContain("typeCodes={overviewLegend.typeCodes}");
      expect(LEGEND).not.toContain("<span");
      expect(PAGE).toContain("legendFrom(overviewPeople)");
    });

    it("B2: legendFrom names a type only for a typed set/requested bar (a masked bar adds none)", () => {
      const colors = readRouteFile("../lib/leave/leave-colors.ts", "src/lib/leave/leave-colors.ts");
      expect(colors).toContain(
        '(bar.style === "gesetzt" || bar.style === "beantragt") && bar.typeCode !== null',
      );
    });

    it("B3: no --leave-type-* literal on the page's legend — the colours come from the mapping", () => {
      expect(LEGEND.match(/--leave-type-[a-z-]+/g) ?? []).toEqual([]);
    });

    it("B4: styles and markings are the view's own answer, not a fixed always-on list", () => {
      expect(LEGEND).toContain("styles={overviewLegend.styles}");
      expect(LEGEND).toContain("markings={overviewLegend.markings}");
      expect(LEGEND).toContain("closedHint={overviewLegend.closedHint}");
    });

    it("B5: Elternzeit and Mutterschutz are reachable — they are in the table the loop reads", () => {
      const labels = LEAVE_TYPE_OPTIONS.map((t) => t.label);
      expect(labels).toContain("Elternzeit");
      expect(labels).toContain("Mutterschutz");
      expect(labels).toContain("Unbezahlter Urlaub");
      expect(labels).not.toContain("Feiertag"); // HOLIDAY is not requestable; it has its own dot
      expect(labels).toHaveLength(9);
    });
  });

  describe("Group C — the three dropdowns did not change meaning (D-11)", () => {
    // Phase 415 (#415): the create dialog's own type <select> moved out of this page and into
    // the shared `LeaveRequestForm.svelte` (`/leave` and `/team/leave` now use ONE dialog). The
    // page therefore carries three loops now (list-filter select, legend, Korrektur-modal select
    // — the Korrektur flow is a SEPARATE, still page-owned modal, out of Phase 415's scope), and
    // the fourth lives in the shared component — asserted below so the count invariant this
    // group protects (every type dropdown reachable from team/leave is fed from
    // LEAVE_TYPE_OPTIONS, never the HOLIDAY-including LEAVE_TYPES) still covers all four.
    // #840 D-840-10: the legend loop moved into <LeaveLegend> (the page hands over the codes), so
    // two page loops remain: list-filter select and Korrektur-modal select.
    it("C1: exactly two LEAVE_TYPE_OPTIONS loops on the page — list-filter select, Korrektur-modal select", () => {
      expect((PAGE.match(/\{#each LEAVE_TYPE_OPTIONS as /g) ?? []).length).toBe(2);
    });

    it("C1b: the shared create/edit dialog carries the fourth loop", () => {
      expect((SHARED_FORM.match(/\{#each LEAVE_TYPE_OPTIONS as /g) ?? []).length).toBe(1);
    });

    it("C2: no <option> block on the page is fed from LEAVE_TYPES (which does contain HOLIDAY)", () => {
      expect(PAGE).not.toContain("{#each LEAVE_TYPES as");
    });

    it("C2b: the shared dialog is not fed from LEAVE_TYPES either", () => {
      expect(SHARED_FORM).not.toContain("{#each LEAVE_TYPES as");
    });
  });
});
