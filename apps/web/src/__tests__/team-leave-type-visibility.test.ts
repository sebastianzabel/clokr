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
  it("Test 0: the page source actually loaded", () => {
    expect(PAGE.length).toBeGreaterThan(50_000); // the file is ~2900 lines / >100 KB
    expect(PAGE).toContain("cal-chip");
    expect(PAGE).toContain("cal-legend");
  });

  describe("Group A — one decision, three render points (D-10, AC-1, AC-2)", () => {
    it("A1: the module is imported from the page", () => {
      expect(PAGE).toContain('from "$lib/leave/team-calendar-visibility"');
    });

    it("A2: resolveChipVisual is called exactly once in the whole page", () => {
      // Import statements do not contain "(", so the count is call sites only. A second call is
      // a second decision and the beginning of the bug this phase fixes.
      expect((PAGE.match(/resolveChipVisual\(/g) ?? []).length).toBe(1);
    });

    it("A3: the one call is a {@const} inside the chip's {#if e} block, reading role from the auth store", () => {
      expect(PAGE).toContain("{@const _vis = resolveChipVisual(e, $authStore.user?.role)}");
    });

    it("A4: all three render points read from _vis", () => {
      expect(PAGE).toContain("style:background={_vis.background}");
      expect(PAGE).toContain("style:color={_vis.textColor}");
      expect(PAGE).toContain("_vis.typeLabel"); // in the title attribute
      expect(PAGE).toContain("{_vis.chipLabel}"); // in the label span
    });

    it("A5: the old machinery is gone", () => {
      expect(PAGE).not.toContain("function typeColor(");
      expect(PAGE).not.toContain("typeColor(");
      expect(PAGE).not.toContain("const TYPE_OPTIONS");
    });

    it("A6: no second isOwn check survives inside the chip", () => {
      // Slice the chip element out of the source so the two legitimate `e.isOwn` uses at :898 and
      // :1300 (which decide whether a bar is drawn at all) are not caught.
      const start = PAGE.indexOf("{@const e = dayAbsences.find(");
      const end = PAGE.indexOf('<div class="cal-chip-placeholder">');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const CHIP = PAGE.slice(start, end);
      // The ONLY permitted mention of ownership inside the chip is the presentational modifier
      // class.
      expect((CHIP.match(/e\.isOwn/g) ?? []).length).toBe(1);
      expect(CHIP).toContain("class:cal-chip--own={e.isOwn}");
      expect(CHIP).not.toContain("e.isOwn &&");
      expect(CHIP).not.toContain("e.typeName"); // the type now reaches the chip only via _vis
    });

    it("A7: the neutral word is not hand-typed in the template", () => {
      // It lives in the module as NEUTRAL_CHIP_LABEL, so a future author cannot reintroduce it
      // next to a coloured background.
      const start = PAGE.indexOf("{@const e = dayAbsences.find(");
      const end = PAGE.indexOf('<div class="cal-chip-placeholder">');
      const CHIP = PAGE.slice(start, end);
      expect(CHIP).not.toContain('"abwesend"');
      expect(CHIP).not.toContain(">abwesend<");
    });
  });

  describe("Group B — the legend (D-05, D-06, AC-3, AC-4)", () => {
    const lStart = PAGE.indexOf('<div class="cal-legend">');
    const lEnd = PAGE.indexOf("</div>", PAGE.indexOf("gestrichelt = ausstehend"));
    const LEGEND = lStart > -1 && lEnd > lStart ? PAGE.slice(lStart, lEnd) : "";

    it("legend markers were found", () => {
      expect(lStart).toBeGreaterThan(-1);
      expect(lEnd).toBeGreaterThan(lStart);
    });

    it("B1: the type dots are a loop over the shared table, not hand-written spans", () => {
      expect(LEGEND).toContain("{#each LEAVE_TYPE_OPTIONS as t (t.code)}");
      expect(LEGEND).toContain('style:background="var({t.colorVar})"');
      expect(LEGEND).toContain("{t.label}");
    });

    it("B2: the loop is gated on the same predicate as the bars (D-05)", () => {
      expect(LEGEND).toContain("{#if canSeeLeaveType(false, $authStore.user?.role)}");
    });

    it("B3: no hand-written type dot survives — every --leave-type-* literal is gone except the neutral one", () => {
      const literals = LEGEND.match(/--leave-type-[a-z-]+/g) ?? [];
      expect(literals).toEqual(["--leave-type-absent"]);
    });

    it("B4: the three always-present items survive the role gate, outside the {#if}", () => {
      const gateIdx = LEGEND.indexOf("{#if canSeeLeaveType");
      const endIdx = LEGEND.indexOf("{/if}", gateIdx);
      const afterGate = LEGEND.slice(endIdx);
      expect(afterGate).toContain(">Abwesend<");
      expect(afterGate).toContain('<span class="legend-holiday-dot"></span>Feiertag');
      expect(afterGate).toContain("gestrichelt = ausstehend");
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
    it("C1: exactly four LEAVE_TYPE_OPTIONS loops — three selects plus the legend", () => {
      expect((PAGE.match(/\{#each LEAVE_TYPE_OPTIONS as /g) ?? []).length).toBe(4);
    });

    it("C2: no <option> block is fed from LEAVE_TYPES (which does contain HOLIDAY)", () => {
      expect(PAGE).not.toContain("{#each LEAVE_TYPES as");
    });
  });
});
