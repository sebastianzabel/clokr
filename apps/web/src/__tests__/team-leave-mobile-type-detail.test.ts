// GitHub issue #265 — below 700px the team calendar's absence type was distinguishable by COLOUR
// ALONE (WCAG 1.4.1), worst for Krank #d97706 against Kinderkrank #ea580c. The `title` tooltip
// carried the text but no finger can open it, which is precisely the finding: a remedy that hides
// the information behind `title`, `:hover` or `@media (hover: hover)` again fixes nothing.
//
// Three things therefore have to be proven, and each is proven where it is actually provable:
//
// 1. WHAT THE BROWSER COMPUTES BELOW THE BREAKPOINT — measured, not grepped. jsdom evaluates no
//    `@media` at all (asserted below, so this claim cannot rot), so this file flattens the page's
//    own style block for a given viewport width with a fail-closed evaluator and then reads
//    `getComputedStyle`. Two controls run alongside every measurement: a POSITIVE control
//    (`.cal-chip`, which the sheet declares `display: flex`) proving the injected sheet is in
//    effect, and an INVENTED class proving an unstyled element reads as the element default — so
//    a value we assert is really coming from the page's CSS and not from jsdom's defaults.
// 2. THE TEXT THE TAP REVEALS, AND THE #257 ROLE RULE — a real mount of CalendarDayDetail. The
//    page itself cannot be mounted (it imports `$app/stores`, for which apps/web/vitest.config.ts
//    registers no alias — the same wall team-leave-type-visibility.test.ts documents), which is
//    exactly why the sheet was extracted into a component.
// 3. THAT THE PAGE IS WIRED TO BOTH — source-read pins, the established pattern for this page.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";

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
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

const BREAKPOINT = 700;
const PHONE_WIDTH = 390; // iPhone 14 logical width — below the breakpoint
const DESKTOP_WIDTH = 1280; // above it

// ── The page's own <style> block ─────────────────────────────────────────────
// Local wrapper: the shared instrument (`$tests/media-query-probe`) takes the page source as an
// explicit argument — it cannot know which page a consumer is testing — so this file supplies its
// own PAGE constant here.
function pageStyleBlock(): string {
  return styleBlockOf(PAGE);
}

// ── Measuring harness ───────────────────────────────────────────────────────
// Local wrapper: preserves the existing `probeAt(WIDTH)` call sites below, which rely on the CSS
// defaulting to this page's own flattened style block. The shared `probeAt` has no page-level
// default by design — see `$tests/media-query-probe`.
function probeAt(viewportPx: number, css: string = cssForViewport(pageStyleBlock(), viewportPx)) {
  return sharedProbeAt(viewportPx, css);
}

afterEach(() => {
  document.head.querySelectorAll("style").forEach((s) => s.remove());
  document.body.innerHTML = "";
  document.body.removeAttribute("data-theme");
});

// ── Group 0: the harness itself is not lying ────────────────────────────────
describe("#265 — the measuring harness (anti-vacuity)", () => {
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

  it("flattening actually changes something — phone and desktop CSS differ", () => {
    const block = pageStyleBlock();
    expect(block.length).toBeGreaterThan(10_000); // the style block really loaded
    expect(block).toContain(`@media (max-width: ${BREAKPOINT}px)`);
    const phone = cssForViewport(block, PHONE_WIDTH);
    const desktop = cssForViewport(block, DESKTOP_WIDTH);
    expect(phone).not.toBe(desktop);
    expect(phone.length).toBeGreaterThan(desktop.length);
    expect(phone).toContain(".cal-day-tap");
  });

  it("controls: the injected sheet is in effect, and an invented class is not styled by it", () => {
    const probe = probeAt(PHONE_WIDTH);
    // POSITIVE control — `.cal-chip { display: flex }` is declared in the page's base block.
    expect(probe.styles("cal-chip", "div").display).toBe("flex");
    // INVENTED control — the sheet never mentions this class, so it must compute exactly like a
    // class-less element of the same tag. Any non-baseline value asserted below is therefore
    // coming from the page's CSS and not from jsdom. (jsdom reports "" for properties no rule
    // sets, which is why the comparison is against a baseline rather than against "inline".)
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
describe("#265 — below the 700px breakpoint (measured)", () => {
  it("the type label is hidden from the EYES but stays in the accessibility tree", () => {
    const probe = probeAt(PHONE_WIDTH);
    const s = probe.styles("cal-chip-type");
    // The defect's own mechanism is gone: `display: none` removes an element from the
    // accessibility tree as well, which is what cost screen readers the type name.
    expect(s.display).not.toBe("none");
    // app.css's `.sr-only` geometry instead.
    expect(s.position).toBe("absolute");
    expect(s.width).toBe("1px");
    expect(s.height).toBe("1px");
    expect(s.clip).toBe("rect(0px, 0px, 0px, 0px)");
  });

  it("the tap trigger EXISTS here — it is the non-colour carrier a finger can reach", () => {
    const probe = probeAt(PHONE_WIDTH);
    const s = probe.styles("cal-day-tap", "button");
    expect(s.display).toBe("flex");
    expect(s.position).toBe("absolute");
    expect(s.cursor).toBe("pointer");
    // Finger-sized in the direction the cell does not already guarantee. Height comes from the
    // `.cal-cell` recipe in app.css (min-height: 86px); width is one calendar column.
    expect(parseInt(s.minHeight, 10)).toBeGreaterThanOrEqual(44);
  });

  it("the affordance is drawn, so the cell is recognisable as operable without hover", () => {
    const probe = probeAt(PHONE_WIDTH);
    const s = probe.styles("cal-day-tap-hint");
    expect(s.display).toBe("inline-flex");
    expect(parseInt(s.width, 10)).toBeGreaterThan(0);
  });

  it("nothing hides the information behind hover — no hover media query on this page", () => {
    // The finding was information reachable only by pointer. A `(hover: ...)` query would be the
    // same mistake in new clothes; it would also make cssForViewport throw.
    expect(pageStyleBlock()).not.toContain("hover:");
  });
});

// ── Group B: the desktop path is untouched ──────────────────────────────────
describe("#265 — above the breakpoint (measured)", () => {
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
    // Control: the sheet is applied at this width too, so the "none" above is a real result.
    expect(probe.styles("cal-chip", "div").display).toBe("flex");
  });
});

// ── Group C: the sheet's text and the #257 role rule (real mount) ───────────
describe("#265 — CalendarDayDetail spells the type out", () => {
  // The hardest pair in the ticket. No PII: initials only.
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

  function open(role: string, entries: DayDetailEntry[] = sickPair) {
    return renderWithTheme(CalendarDayDetail, {
      open: true,
      dateLabel: "21.09.2026",
      entries,
      role,
    });
  }

  it("MANAGER: Krank and Kinderkrank are separated by WORDS, not by two similar oranges", () => {
    open("MANAGER");
    expect(screen.getByRole("dialog")).toBeTruthy();
    const types = screen.getAllByTestId("cal-day-detail-type").map((el) => el.textContent);
    expect(types).toEqual(["Krankmeldung", "Kinderkrank"]);
  });

  it("EMPLOYEE: a colleague's type is NOT named in the detail sheet either (#257 unchanged)", () => {
    open("EMPLOYEE");
    const types = screen.getAllByTestId("cal-day-detail-type").map((el) => el.textContent);
    expect(types).toEqual([NEUTRAL_CHIP_LABEL, NEUTRAL_CHIP_LABEL]);
    // The direction that hurts when it breaks: no sickness word anywhere in the rendered sheet.
    const rendered = screen.getByTestId("cal-day-detail").textContent ?? "";
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("Krank");
    expect(rendered).not.toContain("Kinder");
  });

  it("EMPLOYEE, own absence: the type IS named — the rule is about colleagues", () => {
    open("EMPLOYEE", [{ ...sickPair[0], isOwn: true }]);
    expect(screen.getByTestId("cal-day-detail-type").textContent).toBe("Krankmeldung");
  });

  it("a keyboard can dismiss it: Escape closes the sheet", async () => {
    open("MANAGER");
    expect(screen.queryByRole("dialog")).toBeTruthy();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a finger can dismiss it: a visible Schließen button, because a phone has no Escape key", async () => {
    open("MANAGER");
    await fireEvent.click(screen.getByTestId("cal-day-detail-close"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an empty day still renders a sheet with an explanation, not a blank box", () => {
    open("MANAGER", []);
    expect(screen.getByTestId("cal-day-detail").textContent).toContain("Keine Abwesenheiten");
  });
});

// ── Group D: the page is wired to both halves ───────────────────────────────
describe("#265 — page wiring (source pins)", () => {
  function cellBlock(): string {
    const start = PAGE.indexOf("{@const entries = calMap.get(day.dateStr)");
    const end = PAGE.indexOf('<div class="cal-legend">');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return PAGE.slice(start, end);
  }

  it("the trigger is a REAL <button>, so Enter and Space come from the platform", () => {
    const cell = cellBlock();
    expect(cell).toContain(
      '<button\n                type="button"\n                class="cal-day-tap"',
    );
    // Not a div pretending to be a button — that shape needs hand-written key handling and is how
    // "keyboard reachable" quietly stops being true.
    expect(cell).not.toContain('role="button"');
    expect(cell).not.toContain("tabindex");
  });

  it("the trigger is labelled and actually opens the sheet", () => {
    const cell = cellBlock();
    expect(cell).toContain('aria-label="Abwesenheiten am {fmtDate(day.dateStr)} anzeigen"');
    expect(cell).toContain("onclick={() => openDayDetail(day.dateStr)}");
  });

  it("the trigger is rendered only where there is something to reveal", () => {
    expect(cellBlock()).toContain("{#if dayAbsences.length > 0}");
  });

  it("the sheet is mounted with the viewer's role, from the auth store", () => {
    expect(PAGE).toContain("<CalendarDayDetail");
    expect(PAGE).toContain("role={$authStore.user?.role}");
    expect(PAGE).toContain("entries={dayDetailEntries}");
  });

  it("the page adds no second role check of its own — the module stays the one decision (D-10)", () => {
    // Phase 257's A2 pins resolveChipVisual to a single call site; the detail sheet must not
    // become a second one, which is why it goes through resolveDayDetailRows in the component.
    expect((PAGE.match(/resolveChipVisual\(/g) ?? []).length).toBe(1);
    expect(PAGE).not.toContain("resolveDayDetailRows");
  });

  it("the detail sheet reads the same day filter the bars use", () => {
    // If the sheet listed entries the bars do not draw, the tap would answer a question about a
    // different day than the one the finger touched.
    expect(PAGE).toContain('(e) => !e.isHoliday && (e.isOwn || e.status === "APPROVED")');
    // Three call sites, all the same predicate: the lane map, the cell's `dayAbsences`, and the
    // detail sheet's `dayDetailEntries`. A fourth shape here would mean the sheet and the bars
    // had started to disagree about what the day contains.
    const occurrences =
      PAGE.match(/!e\.isHoliday && \(e\.isOwn \|\| e\.status === "APPROVED"\)/g) ?? [];
    expect(occurrences).toHaveLength(3);
  });
});
