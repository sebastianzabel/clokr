// Phase 303 (GitHub issue #303), Plan 01 — /leave's own calendar bar, the fourth hand-copy of the
// team calendar's absence-visibility rule, pinned at source.
//
// Why source-read and not mounted: this page imports `{ page } from "$app/stores"`, for which
// apps/web/vitest.config.ts registers no alias — the same wall
// team-leave-type-visibility.test.ts (Phase 257) documents, so it cannot be mounted here.
//
// `lint:ui-classes` does not scan `routes/**`. This file is the only automated net for this page.
//
// Routing the chip through the shared `resolveChipVisual()` is a deliberate WIDENING for MANAGER
// and ADMIN — the hand-copy it replaces gated on `isOwn` alone and never read `role`, so a
// MANAGER/ADMIN currently sees LESS than they are entitled to. Applying the fix makes them start
// seeing a colleague's real absence type on this page; it is not a leak being closed for
// EMPLOYEE, whose output (Group B1/B2 below) is unchanged in both channels.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  resolveChipVisual,
  canSeeLeaveType,
  NEUTRAL_CHIP_LABEL,
  LEAVE_TYPES,
  type ChipEntry,
} from "$lib/leave/team-calendar-visibility";

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

describe("leave page — one shared visibility decision (Phase 303)", () => {
  it("Group 0: the page source actually loaded", () => {
    // The file measures 109_708 bytes on the pre-edit tree; the floor sits several KB below so
    // it does not become a time bomb on ordinary future edits.
    expect(PAGE.length).toBeGreaterThan(100_000);
    expect(PAGE).toContain("cal-chip");
    expect(PAGE).toContain("cal-grid");
  });

  describe("Group A — one decision, four render points (D-06)", () => {
    it("A1: resolveChipVisual is referenced", () => {
      // Not a module-path check: the page already imports NEUTRAL_CHIP_LABEL from the same
      // module (Phase 262), so a path-only assertion would be green before the fix and prove
      // nothing.
      expect(PAGE).toContain("resolveChipVisual");
    });

    it("A2: resolveChipVisual is called exactly once in the whole page", () => {
      // Import statements do not contain "(", so the count is call sites only. A second call is
      // a second decision and the start of the bug this plan fixes (D-06).
      expect((PAGE.match(/resolveChipVisual\(/g) ?? []).length).toBe(1);
    });

    it("A3: the one call is the {@const} binding, reading role from the auth store", () => {
      expect(PAGE).toContain("{@const _vis = resolveChipVisual(e, $authStore.user?.role)}");
    });

    it("A4: all four render points read from the binding", () => {
      expect(PAGE).toContain("style:background={_vis.background}");
      expect(PAGE).toContain("style:color={_vis.textColor}");
      expect(PAGE).toContain("_vis.typeLabel"); // in the title attribute
      expect(PAGE).toContain("{_vis.chipLabel}"); // in the label span
    });

    it("A5: the page-local colour helper is gone", () => {
      expect(PAGE).not.toContain("function typeColor(");
      expect(PAGE).not.toContain("typeColor(");
    });

    // Chip slice: the two boundary markers exist byte-identically on this page (confirmed by
    // direct read, 303-RESEARCH.md § Q5). Assert both indices were found before slicing, so a
    // moved marker turns A6/A7/A8 red instead of silently checking an empty string.
    const chipStart = PAGE.indexOf("{@const e = dayAbsences.find(");
    const chipEnd = PAGE.indexOf('<div class="cal-chip-placeholder">');
    const CHIP = chipStart > -1 && chipEnd > chipStart ? PAGE.slice(chipStart, chipEnd) : "";

    it("chip slice boundaries were found", () => {
      expect(chipStart).toBeGreaterThan(-1);
      expect(chipEnd).toBeGreaterThan(chipStart);
    });

    it("A6: no second ownership check survives inside the chip", () => {
      // The ONLY permitted mention of ownership inside the chip is the presentational modifier
      // class; everything else routes through the one _vis binding instead.
      expect((CHIP.match(/e\.isOwn/g) ?? []).length).toBe(1);
      expect(CHIP).toContain("class:cal-chip--own={e.isOwn}");
      expect(CHIP).not.toContain("e.isOwn &&");
      expect(CHIP).not.toContain("e.typeName"); // the type now reaches the chip only via _vis
    });

    it("A7: the neutral word is not hand-typed in the template", () => {
      // It lives in the shared module as NEUTRAL_CHIP_LABEL, so a future author cannot
      // reintroduce it next to a coloured background.
      expect(CHIP).not.toContain('"abwesend"');
      expect(CHIP).not.toContain(">abwesend<");
    });

    it("A8: the § 9 badge markup inside the slice did not smuggle the rule back in", () => {
      // /leave renders the § 9 Section9 badge inside this same chip slice, which /team/leave
      // does not — re-verify it survives the boundaries so a future edit that moves the badge
      // out of the slice cannot silently shrink what A6/A7 cover.
      expect(CHIP).toContain('data-testid="section9-cell-badge"');
    });
  });

  describe("Group B — the role rule at the hardest pairing (D-05), both carriers", () => {
    const sickVar = LEAVE_TYPES.find((t) => t.code === "SICK")?.colorVar;
    const sickChildVar = LEAVE_TYPES.find((t) => t.code === "SICK_CHILD")?.colorVar;
    if (!sickVar || !sickChildVar) {
      throw new Error("SICK/SICK_CHILD missing from LEAVE_TYPES — fixture cannot be built");
    }

    // Two colleague entries, no PII (initials-only convention, as the sibling suite uses).
    const sick: ChipEntry = {
      typeCode: "SICK",
      typeName: "Krankmeldung",
      status: "APPROVED",
      isOwn: false,
    };
    const sickChild: ChipEntry = {
      typeCode: "SICK_CHILD",
      typeName: "Kinderkrank",
      status: "APPROVED",
      isOwn: false,
    };

    it("B1: EMPLOYEE sees the neutral label for both — never the type, in text", () => {
      const visSick = resolveChipVisual(sick, "EMPLOYEE");
      const visSickChild = resolveChipVisual(sickChild, "EMPLOYEE");
      expect(visSick.chipLabel).toBe(NEUTRAL_CHIP_LABEL);
      expect(visSick.typeLabel).toBeNull();
      expect(visSickChild.chipLabel).toBe(NEUTRAL_CHIP_LABEL);
      expect(visSickChild.typeLabel).toBeNull();
    });

    it("B2: EMPLOYEE sees the SAME neutral fill for both — the colour channel a text-only test cannot see", () => {
      // Before this plan, the fill came from a second, independent helper (typeColor()) that a
      // text-only assertion would never exercise. Token names are derived from the module's own
      // table, not hardcoded, so a token rename cannot make this assertion vacuously true.
      const visSick = resolveChipVisual(sick, "EMPLOYEE");
      const visSickChild = resolveChipVisual(sickChild, "EMPLOYEE");
      expect(visSick.background).toBe(visSickChild.background);
      expect(visSick.background).not.toContain(sickVar);
      expect(visSick.background).not.toContain(sickChildVar);
    });

    it("B3: MANAGER and ADMIN see the real type and two distinguishable fills — the intended widening", () => {
      // This is what a MANAGER/ADMIN did NOT see on this page before Phase 303.
      for (const role of ["MANAGER", "ADMIN"]) {
        const visSick = resolveChipVisual(sick, role);
        const visSickChild = resolveChipVisual(sickChild, role);
        expect(visSick.typeLabel).toBe("Krankmeldung");
        expect(visSickChild.typeLabel).toBe("Kinderkrank");
        expect(visSick.background).not.toBe(visSickChild.background);
      }
    });

    it("B4: EMPLOYEE sees their OWN type — the rule is about colleagues, not secrecy as such", () => {
      const own = resolveChipVisual({ ...sick, isOwn: true }, "EMPLOYEE");
      expect(own.typeLabel).toBe("Krankmeldung");
    });

    it("B5: canSeeLeaveType, spot-checked across roles — so B1-B4 cannot all pass from one shared mistake", () => {
      expect(canSeeLeaveType(false, "EMPLOYEE")).toBe(false);
      expect(canSeeLeaveType(false, "MANAGER")).toBe(true);
      expect(canSeeLeaveType(false, "ADMIN")).toBe(true);
      expect(canSeeLeaveType(false, null)).toBe(false);
      expect(canSeeLeaveType(true, "EMPLOYEE")).toBe(true);
    });
  });
});
