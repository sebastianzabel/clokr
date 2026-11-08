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

// #840 amendments (plan 840-10, D-840-10/11, E-06): the month grid of `/team/leave` is gone, and with it
// the `.cal-chip` bar, its sr-only type label and the 700 px whole-cell `.cal-day-tap` trigger. The
// problem they solved - a type carried by COLOUR ALONE on a phone - is solved differently now and the
// same invariants are restated against the files that carry them:
//   - below 768 px the page shows `AbsenceList` INSTEAD of the timeline, and every line of it names the
//     type by TEXT (a masked bar reads „abwesend“, never a type) - measured by mounting the list;
//   - on desktop the timeline prints the label where the bar is wide enough and always keeps the type
//     in `title`/`aria-label` - pinned at source;
//   - nothing hides the information behind hover (the page's own style block has no `hover:` query);
//   - `CalendarDayDetail` (Group C) is untouched: `/leave` still uses it (plan 840-11).
// The measuring harness (Group 0) is kept and now reads the page's remaining `@media` block.
//
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import CalendarDayDetail from "$lib/components/leave/CalendarDayDetail.svelte";
import AbsenceList from "$lib/components/leave/timeline/AbsenceList.svelte";
import { periodOf, type TimelinePerson } from "$lib/leave/timeline-model";
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
    expect(block.length).toBeGreaterThan(3_000); // the style block really loaded
    // #840: the one media rule left on the page is the review grid of the correction modal.
    expect(block).toContain(`@media (max-width: ${BREAKPOINT}px)`);
    const phone = cssForViewport(block, PHONE_WIDTH);
    const desktop = cssForViewport(block, DESKTOP_WIDTH);
    expect(phone).not.toBe(desktop);
    expect(phone.length).toBeGreaterThan(desktop.length);
    expect(phone).toContain(".review-grid");
  });

  it("controls: the injected sheet is in effect, and an invented class is not styled by it", () => {
    const probe = probeAt(PHONE_WIDTH);
    // POSITIVE control — `.emp-input-wrap { display: flex }` is declared in the page's base block.
    expect(probe.styles("emp-input-wrap", "div").display).toBe("flex");
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

// ── Group A: what a phone actually shows ────────────────────────────────────
describe("#265 / #840 — on a phone the type is named by text (real mount of AbsenceList)", () => {
  // The hardest pair in the ticket. No PII: initials only.
  const bar = (
    key: string,
    typeCode: string | null,
    label: string,
    style: "gesetzt" | "abwesend",
  ) => ({
    key,
    start: "2026-11-02",
    end: "2026-11-03",
    style,
    typeCode,
    label,
    editable: false,
  });
  const rows: TimelinePerson[] = [
    {
      employeeId: "p1",
      name: "A. A.",
      isOwn: false,
      bars: [
        bar("k1", "SICK", "Krankmeldung", "gesetzt"),
        bar("k2", "SICK_CHILD", "Kinderkrank", "gesetzt"),
      ],
    },
    {
      employeeId: "p2",
      name: "B. B.",
      isOwn: false,
      bars: [bar("k3", null, NEUTRAL_CHIP_LABEL, "abwesend")],
    },
  ];

  function mount() {
    return renderWithTheme(AbsenceList, { rows, period: periodOf("monat", "2026-11-02") });
  }

  it("Krank and Kinderkrank are separated by WORDS, not by two similar oranges", () => {
    mount();
    const types = Array.from(document.querySelectorAll(".absence-list-type")).map(
      (el) => el.textContent,
    );
    expect(types).toContain("Krankmeldung");
    expect(types).toContain("Kinderkrank");
  });

  it("a masked colleague's bar reads „abwesend“ and the list names no sickness word for it (#257 unchanged)", () => {
    mount();
    const masked = screen.getByTestId("absence-list-line-k3").textContent ?? "";
    expect(masked).toContain(NEUTRAL_CHIP_LABEL);
    expect(masked).not.toContain("Krank");
    expect(masked).not.toContain("Kinder");
  });
});

// ── Group B: the desktop path keeps the type reachable ──────────────────────
describe("#265 / #840 — the timeline keeps the type in text for every bar width (source pins)", () => {
  const TIMELINE = readRepoFile(
    "../lib/components/leave/timeline/AbsenceTimeline.svelte",
    "src/lib/components/leave/timeline/AbsenceTimeline.svelte",
  );

  it("a bar prints its label where there is room and carries the type in title and aria-label always", () => {
    expect(TIMELINE).toContain("{#if placed.width >= LABEL_MIN_WIDTH}{bar.label}{/if}");
    expect(TIMELINE).toContain("title={barTitle(bar)}");
    expect(TIMELINE).toContain('aria-label="{person.name}: {barTitle(bar)}"');
  });

  it("nothing hides the information behind hover — no hover media query on this page", () => {
    // The finding was information reachable only by pointer. A `(hover: ...)` query would be the
    // same mistake in new clothes; it would also make cssForViewport throw.
    expect(pageStyleBlock()).not.toContain("hover:");
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

  function open(canSeeType: boolean, entries: DayDetailEntry[] = sickPair) {
    return renderWithTheme(CalendarDayDetail, {
      open: true,
      dateLabel: "21.09.2026",
      entries,
      canSeeType,
    });
  }

  it("leave-request:read:ZUGEWIESEN: Krank and Kinderkrank are separated by WORDS, not by two similar oranges", () => {
    open(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
    const types = screen.getAllByTestId("cal-day-detail-type").map((el) => el.textContent);
    expect(types).toEqual(["Krankmeldung", "Kinderkrank"]);
  });

  it("no leave-request:read:ZUGEWIESEN: a colleague's type is NOT named in the detail sheet either (#257 unchanged)", () => {
    open(false);
    const types = screen.getAllByTestId("cal-day-detail-type").map((el) => el.textContent);
    expect(types).toEqual([NEUTRAL_CHIP_LABEL, NEUTRAL_CHIP_LABEL]);
    // The direction that hurts when it breaks: no sickness word anywhere in the rendered sheet.
    const rendered = screen.getByTestId("cal-day-detail").textContent ?? "";
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("Krank");
    expect(rendered).not.toContain("Kinder");
  });

  it("no leave-request:read:ZUGEWIESEN, own absence: the type IS named — the rule is about colleagues", () => {
    open(false, [{ ...sickPair[0], isOwn: true }]);
    expect(screen.getByTestId("cal-day-detail-type").textContent).toBe("Krankmeldung");
  });

  it("a keyboard can dismiss it: Escape closes the sheet", async () => {
    open(true);
    expect(screen.queryByRole("dialog")).toBeTruthy();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a finger can dismiss it: a visible Schließen button, because a phone has no Escape key", async () => {
    open(true);
    await fireEvent.click(screen.getByTestId("cal-day-detail-close"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an empty day still renders a sheet with an explanation, not a blank box", () => {
    open(true, []);
    expect(screen.getByTestId("cal-day-detail").textContent).toContain("Keine Abwesenheiten");
  });
});

// ── Group D: the page is wired to both halves ───────────────────────────────
describe("#265 / #840 — page wiring (source pins)", () => {
  it("below 768 px the list replaces the timeline, fed with the same rows", () => {
    expect(PAGE).toContain('window.matchMedia("(max-width: 767px)")');
    const list = PAGE.indexOf("<AbsenceList");
    const timeline = PAGE.indexOf("<AbsenceTimeline");
    expect(list).toBeGreaterThan(-1);
    expect(timeline).toBeGreaterThan(list);
    expect(PAGE.slice(PAGE.lastIndexOf("{:else if isMobile}", list), list)).toContain("isMobile");
    // One row set for both - the list can never show what the timeline does not.
    expect(PAGE.slice(list, timeline)).toContain("rows={overviewPeople}");
    expect(PAGE.slice(timeline, timeline + 200)).toContain("rows={overviewPeople}");
  });

  it("a tap on a line leads to the request, like a click on a bar", () => {
    expect(PAGE.slice(PAGE.indexOf("<AbsenceList"), PAGE.indexOf("<AbsenceTimeline"))).toContain(
      "onBarSelect={selectBar}",
    );
  });

  it("the day-detail sheet is no longer mounted on this page", () => {
    // /leave still mounts it (plan 840-11); the team page has no month grid to open it from.
    expect(PAGE).not.toContain("<CalendarDayDetail");
    expect(PAGE).not.toContain("cal-day-tap");
  });

  it("the page adds no second role check of its own — the model stays the one decision (D-10)", () => {
    expect(PAGE).not.toContain("resolveChipVisual(");
    expect(PAGE).not.toContain("resolveDayDetailRows");
  });
});
