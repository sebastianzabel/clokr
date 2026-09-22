// GitHub issue #303 (Plan 03) — below 700px `/leave`'s calendar bar carries its absence type by
// COLOUR ALONE (WCAG 1.4.1), the same finding #265 fixed on `/team/leave`. The `title` tooltip
// carries the text but no finger can open it, so a remedy hidden behind `title`, `:hover` or
// `@media (hover: hover)` fixes nothing — the harness below is fail-closed on hover conditions.
//
// `/leave` gets the SAME tap-to-reveal pattern (D-02) — but NOT #265's whole-cell trigger. The
// research that cleared the geometry did not check the OCCUPANCY: unlike `/team/leave`'s inert
// `<div>`, `/leave`'s calendar cell already carries `role="button"`, `tabindex`, a drag-to-select
// (`onmousedown`/`onmouseenter`), an `onkeydown` for Enter/Space, and a page-level
// `<svelte:window onmouseup>` — all of which open the NEW-REQUEST form, this page's primary
// action. #265's `inset: 0` trigger transposed verbatim would sit on top of that action, and
// because `mousedown` inside the button still bubbles it would not merely shadow the create
// interaction but fire BOTH the day-detail sheet and the new-request modal.
//
// D-09 (303-CONTEXT.md § Nachtrag) therefore fixes a CORNER target instead — at least 44×44px,
// anchored top-right, with propagation on `mousedown` AND `keydown` stopped before it reaches the
// cell's handlers. This file measures that corner box specifically (not #265's whole-cell box),
// and pins that the propagation-stopping calls are present in the markup.
//
// Three things are proven, each where it is actually provable:
//
// 1. WHAT THE BROWSER COMPUTES BELOW THE BREAKPOINT — measured, not grepped, using the shared
//    `$tests/media-query-probe` harness (extracted in plan 303-02 from #265's own suite). jsdom
//    evaluates no `@media` at all (asserted below), so the harness flattens this page's own style
//    block for a given viewport width with a fail-closed evaluator and then reads
//    `getComputedStyle`. A positive control (`.cal-chip`) and an invented-class control run
//    alongside every measurement.
// 2. THE TEXT THE TAP REVEALS, AND THE #257 ROLE RULE — a real mount of the already-existing,
//    already-tested `CalendarDayDetail` component. `/leave` itself cannot be mounted (it imports
//    `{ page } from "$app/stores"`, for which `apps/web/vitest.config.ts` registers no alias),
//    which is why the sheet lives in its own component and is reused unchanged here.
// 3. THAT THE PAGE IS WIRED TO BOTH, INCLUDING THE /leave-SPECIFIC PROPAGATION PIN — source-read
//    assertions. This is a source read: it proves the propagation-stopping CALL is present in the
//    markup, not that the double-fire is prevented at runtime — the page cannot be mounted here,
//    so a runtime proof is out of reach until it becomes mountable or an e2e spec exists.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, afterEach } from "vitest";
import { screen } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import CalendarDayDetail from "$lib/components/leave/CalendarDayDetail.svelte";
import { NEUTRAL_CHIP_LABEL, type DayDetailEntry } from "$lib/leave/team-calendar-visibility";
import {
  cssForViewport,
  styleBlockOf,
  probeAt as sharedProbeAt,
  INVENTED_CLASS,
} from "$tests/media-query-probe";

function readRepoFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRepoFile(
  "../routes/(app)/leave/+page.svelte",
  "src/routes/(app)/leave/+page.svelte",
);

const BREAKPOINT = 700;
const PHONE_WIDTH = 390; // iPhone 14 logical width — below the breakpoint
const DESKTOP_WIDTH = 1280; // above it

// ── The page's own <style> block ─────────────────────────────────────────────
// Local wrapper: the shared instrument (`$tests/media-query-probe`) takes the page source as an
// explicit argument — it cannot know which page a consumer is testing — so this file supplies its
// own PAGE constant here, exactly as team-leave-mobile-type-detail.test.ts does for the sibling.
function pageStyleBlock(): string {
  return styleBlockOf(PAGE);
}

// ── Measuring harness ───────────────────────────────────────────────────────
// Local wrapper: keeps the existing `probeAt(WIDTH)` call sites below defaulting to this page's
// own flattened style block. The shared `probeAt` has no page-level default by design.
function probeAt(viewportPx: number, css: string = cssForViewport(pageStyleBlock(), viewportPx)) {
  return sharedProbeAt(viewportPx, css);
}

// The shared probe deliberately does not clean up after itself — this file owns its own teardown.
afterEach(() => {
  document.head.querySelectorAll("style").forEach((s) => s.remove());
  document.body.innerHTML = "";
  document.body.removeAttribute("data-theme");
});

// ── Group 0: the harness itself is not lying ────────────────────────────────
describe("#303 (leave) — the measuring harness (anti-vacuity)", () => {
  it("PAGE actually loaded — well above the pre-edit floor", () => {
    expect(PAGE.length).toBeGreaterThan(100_000);
  });

  it("jsdom applies NO @media rule, which is why this suite flattens them itself", () => {
    // A `(min-width: 1px)` block matches every real viewport. jsdom still ignores it — if that
    // ever changes, this assertion fails and the flattening below can be deleted.
    const probe = probeAt(
      DESKTOP_WIDTH,
      ".m-probe { display: flex } @media (min-width: 1px) { .m-probe { display: none } }",
    );
    expect(probe.styles("m-probe").display).toBe("flex");
  });

  it("the flattener is fail-closed on a condition it cannot evaluate", () => {
    expect(() =>
      cssForViewport("@media (hover: hover) { .x { color: red } }", PHONE_WIDTH),
    ).toThrow(/cannot evaluate media condition/);
  });

  it("the page's style block is substantial and carries the 700px media condition", () => {
    const block = pageStyleBlock();
    expect(block.length).toBeGreaterThan(10_000);
    expect(block).toContain(`@media (max-width: ${BREAKPOINT}px)`);
  });

  it("flattening actually changes something for THIS page — phone mentions the trigger class", () => {
    const block = pageStyleBlock();
    const phone = cssForViewport(block, PHONE_WIDTH);
    const desktop = cssForViewport(block, DESKTOP_WIDTH);
    expect(phone).not.toBe(desktop);
    // EXPECTED RED pre-edit: the trigger class does not exist yet in this page's CSS.
    expect(phone).toContain("cal-day-tap");
  });

  it("controls: the injected sheet is in effect, and an invented class is not styled by it", () => {
    const probe = probeAt(PHONE_WIDTH);
    // POSITIVE control — `.cal-chip { display: flex }` is declared in the page's base block.
    expect(probe.styles("cal-chip", "div").display).toBe("flex");
    // INVENTED control — the sheet never mentions this class, so it must compute exactly like a
    // class-less element of the same tag. Any non-baseline value asserted below is therefore
    // coming from the page's CSS and not from jsdom's defaults.
    const invented = probe.styles(INVENTED_CLASS);
    const baseline = probe.styles("");
    expect(invented.display).toBe(baseline.display);
    expect(invented.position).toBe(baseline.position);
    expect(invented.display).not.toBe("flex");
    expect(invented.display).not.toBe("none");
    expect(invented.position).not.toBe("absolute");
  });
});

// ── Group A: what a phone actually computes ─────────────────────────────────
describe("#303 (leave) — below the 700px breakpoint (measured)", () => {
  it("the type label is hidden from the EYES but stays in the accessibility tree", () => {
    const probe = probeAt(PHONE_WIDTH);
    const s = probe.styles("cal-chip-type");
    // EXPECTED RED pre-edit: the label still computes `display: none` today, which is the
    // defect — it removes the element from the accessibility tree as well.
    expect(s.display).not.toBe("none");
    // app.css's `.sr-only` geometry (D-03), inlined — a class cannot be added by viewport width.
    expect(s.position).toBe("absolute");
    expect(s.width).toBe("1px");
    expect(s.height).toBe("1px");
    expect(s.clip).toBe("rect(0px, 0px, 0px, 0px)");
  });

  it("the tap trigger EXISTS — the non-colour carrier a finger can reach", () => {
    const probe = probeAt(PHONE_WIDTH);
    const s = probe.styles("cal-day-tap", "button");
    expect(s.display).toBe("flex");
    expect(s.position).toBe("absolute");
    expect(s.cursor).toBe("pointer");
  });

  it("D-09's box: BOTH minimums are ≥44px — a corner target cannot borrow height from the cell", () => {
    // Unlike #265's whole-cell trigger (which inherits ≥86px height from the `.cal-cell` recipe),
    // a corner box has no such floor for free — both directions must be asserted here.
    const probe = probeAt(PHONE_WIDTH);
    const s = probe.styles("cal-day-tap", "button");
    expect(parseInt(s.minWidth, 10)).toBeGreaterThanOrEqual(44);
    expect(parseInt(s.minHeight, 10)).toBeGreaterThanOrEqual(44);
  });

  it("D-09's box is anchored top-right and does NOT cover the cell", () => {
    const probe = probeAt(PHONE_WIDTH);
    const s = probe.styles("cal-day-tap", "button");
    // Anchored: the two offsets that place it in the corner are declared.
    expect(s.top).toBe("0px");
    expect(s.right).toBe("0px");
    // NOT the whole cell: the two offsets that would stretch it across the cell (#265's
    // `inset: 0` shape) must NOT also compute to 0px. This is the assertion that fails if a
    // future "simplification" silently restores the whole-cell overlay and, with it, the
    // double-fire onto the create-a-request interaction (D-09).
    expect(s.bottom).not.toBe("0px");
    expect(s.left).not.toBe("0px");
  });

  it("the affordance is drawn, so the cell is recognisable as operable without hover", () => {
    const probe = probeAt(PHONE_WIDTH);
    const s = probe.styles("cal-day-tap-hint");
    expect(s.display).toBe("inline-flex");
    expect(parseInt(s.width, 10)).toBeGreaterThan(0);
  });

  it("nothing hides the information behind hover — no hover media query on this page", () => {
    expect(pageStyleBlock()).not.toContain("hover:");
  });
});

// ── Group B: the desktop path is untouched ──────────────────────────────────
describe("#303 (leave) — above the breakpoint (measured)", () => {
  it("the type label renders normally and the tap trigger does not exist", () => {
    const probe = probeAt(DESKTOP_WIDTH);
    const label = probe.styles("cal-chip-type");
    const baseline = probe.styles("");
    // Not visually hidden here: the bar prints the type itself at this width.
    expect(label.position).toBe(baseline.position);
    expect(label.position).not.toBe("absolute");
    expect(label.width).not.toBe("1px");
    // `display: none` also keeps the button out of the tab order, so its visibility and its
    // keyboard reachability cannot drift apart.
    expect(probe.styles("cal-day-tap", "button").display).toBe("none");
    // Control: the sheet is applied at this width too, so the "none" above is a real result and
    // not an un-applied sheet — the same distinction Group 0's invented-class control makes.
    expect(probe.styles("cal-chip", "div").display).toBe("flex");
  });
});

// ── Group C: one mounted assertion — the direction that hurts ───────────────
// CalendarDayDetail's own behaviour (MANAGER sees the words, Escape closes, the empty day
// explains itself) is already covered by team-leave-mobile-type-detail.test.ts against the same
// unchanged component; repeating it here would duplicate assertions without adding coverage.
// What is NOT covered elsewhere is asserted from THIS page's file, so it cannot be lost if the
// sibling suite is ever re-scoped: an EMPLOYEE must learn no colleague's type from the sheet.
describe("#303 (leave) — CalendarDayDetail names no colleague's type for an EMPLOYEE", () => {
  it("EMPLOYEE, two colleagues, two different sickness types: neither type is named anywhere", () => {
    const sickPair: DayDetailEntry[] = [
      {
        id: "r1",
        firstName: "A.",
        lastName: "A.",
        typeCode: "SICK",
        typeName: "Krankmeldung",
        status: "APPROVED",
        isOwn: false,
      },
      {
        id: "r2",
        firstName: "B.",
        lastName: "B.",
        typeCode: "SICK_CHILD",
        typeName: "Kinderkrank",
        status: "APPROVED",
        isOwn: false,
      },
    ];
    renderWithTheme(CalendarDayDetail, {
      open: true,
      dateLabel: "21.09.2026",
      entries: sickPair,
      role: "EMPLOYEE",
    });
    const types = screen.getAllByTestId("cal-day-detail-type").map((el) => el.textContent);
    expect(types).toEqual([NEUTRAL_CHIP_LABEL, NEUTRAL_CHIP_LABEL]);
    const rendered = screen.getByTestId("cal-day-detail").textContent ?? "";
    // Assert non-empty first, so an empty render cannot pass the "not contain" assertions below
    // by vacuity.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("Krank");
    expect(rendered).not.toContain("Kinder");
  });
});

// ── Group D: page wiring, source pins ───────────────────────────────────────
describe("#303 (leave) — page wiring (source pins)", () => {
  function cellBlock(): string {
    const start = PAGE.indexOf("{@const entries = calMap.get(day.dateStr)");
    const end = PAGE.indexOf('<div class="cal-legend">');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return PAGE.slice(start, end);
  }

  // The CELL on /leave legitimately carries `role="button"` and `tabindex` (its own
  // create-a-request interaction, unlike the inert `<div>` on /team/leave) — so "no
  // `role=\"button\"`" cannot be asserted against the whole cell slice the way the sibling test
  // does. This pin is scoped to the TRIGGER element's own markup instead.
  function triggerBlock(): string {
    const cell = cellBlock();
    const start = cell.indexOf('data-testid="leave-cal-day-tap"');
    expect(start).toBeGreaterThan(-1);
    // Back up to the nearest opening `<button` before the testid, forward to its `>`.
    const tagStart = cell.lastIndexOf("<button", start);
    expect(tagStart).toBeGreaterThan(-1);
    const tagEnd = cell.indexOf(">", start);
    expect(tagEnd).toBeGreaterThan(tagStart);
    return cell.slice(tagStart, tagEnd + 1);
  }

  it('the trigger is a REAL <button>, not a div wearing role="button"', () => {
    const trigger = triggerBlock();
    expect(trigger).toContain('type="button"');
    // Scoped to the trigger's own opening tag — the CELL's role="button"/tabindex are legitimate
    // here and must not make this assertion fail for the wrong reason.
    expect(trigger).not.toContain('role="button"');
    expect(trigger).not.toContain("tabindex");
  });

  it('carries the page-scoped testid "leave-cal-day-tap" — 303-04\'s freshness probe depends on this exact string', () => {
    // Deliberately NOT the sibling's bare "cal-day-tap": that class has been on /team/leave
    // since #265 and sits in every build already, so probing for it would be vacuous. A testid
    // shared by triggers on two pages is also an ambiguous e2e selector.
    expect(cellBlock()).toContain('data-testid="leave-cal-day-tap"');
  });

  it("the trigger is labelled in German with the formatted date, and opens the sheet", () => {
    const cell = cellBlock();
    expect(cell).toContain('aria-label="Abwesenheiten am {fmtDate(day.dateStr)} anzeigen"');
    expect(cell).toContain("openDayDetail(day.dateStr)");
  });

  it("the trigger is rendered only where there is something to reveal", () => {
    expect(cellBlock()).toContain("{#if dayAbsences.length > 0}");
  });

  it(
    "the /leave-specific pin (D-09): propagation of mousedown AND keydown is stopped on the " +
      "trigger, so the cell's drag-select (mousedown → the page-level window mouseup opening " +
      "the new-request modal) and its own onkeydown (Enter/Space → same modal) cannot co-fire. " +
      "This is a source read: it proves the CALL is present in the markup, not that the " +
      "double-fire is prevented at runtime — the page imports $app/stores and cannot be " +
      "mounted here, so a runtime proof is out of reach until it becomes mountable or an e2e " +
      "spec exists (noted as a follow-up, not built here).",
    () => {
      const trigger = triggerBlock();
      expect(trigger).toMatch(/onmousedown=\{.*stopPropagation/);
      expect(trigger).toMatch(/onkeydown=\{.*stopPropagation/);
    },
  );

  it("the sheet is mounted with the derived entries and the viewer's role, from the auth store", () => {
    expect(PAGE).toContain("<CalendarDayDetail");
    expect(PAGE).toContain("role={$authStore.user?.role}");
    expect(PAGE).toContain("entries={dayDetailEntries}");
  });

  it("the page adds no second role decision — resolveChipVisual stays the one call site", () => {
    // Plan 303-01 pins this to exactly 1 already; re-asserted here so this plan cannot silently
    // add a second call site while wiring the sheet.
    expect((PAGE.match(/resolveChipVisual\(/g) ?? []).length).toBe(1);
    expect(PAGE).not.toContain("resolveDayDetailRows");
  });

  it("the day filter predicate occurs exactly three times: the lane map, dayAbsences, and the sheet", () => {
    // It occurs twice today (the lane map and the cell's dayAbsences). A fourth shape would mean
    // the sheet and the bars had started to disagree about what the day contains.
    const occurrences =
      PAGE.match(/!e\.isHoliday && \(e\.isOwn \|\| e\.status === "APPROVED"\)/g) ?? [];
    expect(occurrences).toHaveLength(3);
  });
});
