// Issue #840, gap round (840-UAT.md, plan 840-15) — the look of the one timeline and the one legend.
//
// G-2: the weekend band was the near-white `--bg-subtle` at 0.8 opacity (1.09:1 on editorial light,
// about 1:1 on the translucent modern card), so the owner could not see weekends. The proofs here
// resolve the declared tokens from `tokens.css` (jsdom resolves no custom properties) in all four
// surface modes and measure the contrast of the shade against the card it lies on.
//
// G-4: every look of the legend means exactly one thing (describe further down).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import AbsenceTimeline from "$lib/components/leave/timeline/AbsenceTimeline.svelte";
import { periodOf, type TimelineBar, type TimelinePerson } from "$lib/leave/timeline-model";
import { MIXED } from "$lib/leave/leave-colors";
import {
  SURFACES,
  cardSurface,
  contrast,
  over,
  readTokensCss,
  resolveColor,
  tokenIn,
  type SurfaceName,
} from "./token-css";

function readSource(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const TOKENS = readTokensCss();
const TIMELINE_SRC = readSource(
  "../lib/components/leave/timeline/AbsenceTimeline.svelte",
  "src/lib/components/leave/timeline/AbsenceTimeline.svelte",
);
const LEGEND_SRC = readSource(
  "../lib/components/leave/LeaveLegend.svelte",
  "src/lib/components/leave/LeaveLegend.svelte",
);

/** The declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(source: string, selector: string): string {
  const style = source.slice(source.indexOf("<style>"));
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(style);
  if (!match) throw new Error(`Rule not found: ${selector}`);
  return match[1];
}

describe("#840 G-2 weekend shade", () => {
  describe("the token resolves to a visible tint in every surface mode", () => {
    for (const name of Object.keys(SURFACES) as SurfaceName[]) {
      it(`${name}: --weekend-shade reaches 1.2:1 against the card`, () => {
        const blocks = SURFACES[name];
        const card = cardSurface(TOKENS, blocks);
        const shade = resolveColor(TOKENS, blocks, "var(--weekend-shade)");
        const ratio = contrast(over(shade, card), card);
        expect(ratio).toBeGreaterThanOrEqual(1.2);
      });
    }

    it("the shade is a quiet background, far below a leave-type fill", () => {
      for (const name of Object.keys(SURFACES) as SurfaceName[]) {
        const blocks = SURFACES[name];
        const card = cardSurface(TOKENS, blocks);
        const shade = over(resolveColor(TOKENS, blocks, "var(--weekend-shade)"), card);
        const fill = over(resolveColor(TOKENS, blocks, "var(--leave-type-absent)"), card);
        expect(contrast(shade, card)).toBeLessThan(contrast(fill, card));
      }
    });

    it("the old value (the subtle background at 0.8 opacity) is invisible — the proof can fail", () => {
      const old = (name: SurfaceName) => {
        const blocks = SURFACES[name];
        const card = cardSurface(TOKENS, blocks);
        const subtle = resolveColor(TOKENS, blocks, "var(--bg-subtle)");
        return contrast(over({ ...subtle, a: subtle.a * 0.8 }, card), card);
      };
      expect(old("editorial-light")).toBeLessThan(1.2);
      expect(old("modern-light")).toBeLessThan(1.2);
    });

    it("the helper reads the dark block, never the `html[data-mode=dark]` one (prefix trap)", () => {
      expect(tokenIn(TOKENS, [":root", '[data-mode="dark"]'], "--bg-card")).toBe("#1f1827");
      expect(tokenIn(TOKENS, [":root"], "--bg-card")).toBe("#ffffff");
    });
  });

  describe("source pins", () => {
    it("the timeline weekend rules read the token and carry no opacity", () => {
      const track = ruleBody(TIMELINE_SRC, ".tl-weekend");
      expect(track).toContain("var(--weekend-shade)");
      expect(track).not.toMatch(/opacity/);
      expect(ruleBody(TIMELINE_SRC, ".absence-day--weekend")).toContain("var(--weekend-shade)");
    });

    it("the legend weekend swatch reads the same token", () => {
      expect(ruleBody(LEGEND_SRC, ".legend-swatch--weekend")).toContain("var(--weekend-shade)");
    });
  });

  describe("mounted timeline", () => {
    const rows: TimelinePerson[] = [
      { employeeId: "e1", name: "Anna Muster", isOwn: false, bars: [] },
    ];

    it("Quartal shades the Saturday/Sunday columns and keeps the closed hatch on top", () => {
      const period = periodOf("quartal", "2026-11-15");
      renderWithTheme(AbsenceTimeline, {
        rows,
        period,
        holidays: [],
        // Monday = 0, so 6 is Sunday.
        closedWeekdays: new Set([6]),
        columnWidthPx: 24,
        today: "2026-11-10",
      });
      const track = screen.getByTestId("plan-track-e1");
      expect(track.querySelectorAll(".tl-weekend").length).toBeGreaterThan(0);
      // 2026-11-07 is a Saturday, 2026-11-08 a Sunday.
      for (const day of ["2026-11-07", "2026-11-08"]) {
        expect(screen.getByTestId(`absence-day-${day}`).classList).toContain(
          "absence-day--weekend",
        );
      }
      expect(screen.getByTestId("absence-day-2026-11-09").classList).not.toContain(
        "absence-day--weekend",
      );
      // The closed Sunday is both shaded and hatched; the hatch is a layer of its own after the shade.
      expect(screen.getByTestId("absence-day-2026-11-08").classList).toContain(
        "absence-day--closed",
      );
      const layers = [...track.children].map((el) =>
        el.classList.contains("tl-weekend")
          ? "weekend"
          : el.classList.contains("tl-closed")
            ? "closed"
            : "",
      );
      const lastWeekend = layers.lastIndexOf("weekend");
      const firstClosed = layers.indexOf("closed");
      expect(firstClosed).toBeGreaterThan(-1);
      expect(firstClosed).toBeGreaterThan(lastWeekend);
    });
  });
});

const barOf = (over: Partial<TimelineBar>): TimelineBar => ({
  key: "b",
  start: "2026-11-02",
  end: "2026-11-03",
  style: "gesetzt",
  typeCode: "VACATION",
  label: "Urlaub",
  editable: false,
  ...over,
});

const MODES = {
  light: SURFACES["editorial-light"],
  dark: SURFACES["editorial-dark"],
} as const;

const HOSTS = [
  "routes/(app)/team/leave/+page.svelte",
  "routes/(app)/leave/+page.svelte",
  "lib/components/leave/LeavePlanningPanel.svelte",
] as const;

describe("#840 G-4 one look, one meaning", () => {
  describe("the solid neutral looks are pairwise apart in light and dark", () => {
    for (const [mode, blocks] of Object.entries(MODES)) {
      const colorOf = (token: string) =>
        over(resolveColor(TOKENS, blocks, `var(${token})`), cardSurface(TOKENS, blocks));
      const looks = {
        Abwesend: "--leave-type-absent",
        // BLOCKED (840-15 Task 3, see the SUMMARY): "Andere Abwesenheit" (--leave-type-default) still
        // equals "Unbezahlter Urlaub" until leave-chip-contrast.test.ts Test 5, which pins the
        // default literals, may be amended; its pairwise cases are added with the colour change.
        "Unbezahlter Urlaub": "--leave-type-unpaid",
      };
      const names = Object.keys(looks) as Array<keyof typeof looks>;
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          it(`${mode}: ${names[i]} vs ${names[j]} are at least 1.3:1 apart`, () => {
            expect(
              contrast(colorOf(looks[names[i]]), colorOf(looks[names[j]])),
            ).toBeGreaterThanOrEqual(1.3);
          });
        }
      }

      it(`${mode}: the unknown-type fill keeps its -text partner at WCAG AA`, () => {
        const fill = colorOf("--leave-type-default");
        const text = colorOf("--leave-type-default-text");
        expect(contrast(fill, text)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  describe("Mehrere Arten differs from Abwesend by pattern", () => {
    it("the timeline draws the mixed cell striped and the masked cell solid", () => {
      const rule = ruleBody(TIMELINE_SRC, ".tl-week--mixed .tl-week-fill");
      expect(rule).toContain("repeating-linear-gradient");
      expect(ruleBody(TIMELINE_SRC, ".tl-week-fill")).not.toContain("repeating-linear-gradient");
    });

    it("the legend swatch of Mehrere Arten is striped, the Abwesend swatch is not", () => {
      expect(ruleBody(LEGEND_SRC, ".legend-swatch--mixed")).toContain("repeating-linear-gradient");
      expect(LEGEND_SRC).not.toMatch(/\.legend-swatch--abwesend\s*\{/);
    });
  });

  describe("the legend hosts", () => {
    for (const host of HOSTS) {
      it(`${host} passes mixed only for Jahr, computed with hasMixedWeek(`, () => {
        const source = readSource(`../${host}`, `src/${host}`);
        expect(source).toContain("hasMixedWeek(");
        expect(source).toMatch(/mixed:\s*!daily\s*&&\s*hasMixedWeek\(/);
      });
    }
  });

  describe("mounted Jahr timeline: a mixed week", () => {
    const rows: TimelinePerson[] = [
      {
        employeeId: "mix",
        name: "Mia Mixed",
        isOwn: false,
        bars: [
          barOf({ key: "a" }),
          barOf({ key: "b", start: "2026-11-04", end: "2026-11-04", typeCode: "SICK" }),
        ],
      },
      {
        employeeId: "msk",
        name: "Mo Masked",
        isOwn: false,
        bars: [
          barOf({ key: "a" }),
          barOf({
            key: "m",
            start: "2026-11-04",
            end: "2026-11-04",
            style: "abwesend",
            typeCode: null,
            label: "abwesend",
          }),
        ],
      },
    ];

    function mountYear() {
      renderWithTheme(AbsenceTimeline, {
        rows,
        period: periodOf("jahr", "2026-06-15"),
        holidays: [],
        columnWidthPx: 12,
        today: "2026-06-15",
      });
    }

    it("the mixed cell has its own class, the mixed fill and names the mixture", () => {
      mountYear();
      const cell = screen.getByTestId("week-cell-mix-2026-11-02");
      expect(cell.classList).toContain("tl-week--mixed");
      expect(cell.style.getPropertyValue("--bar-fill")).toBe(`var(${MIXED.fill})`);
      expect(cell.getAttribute("aria-label")).toContain("mehrere Arten");
    });

    it("a masked week is NOT mixed: no stripes, no statement about a hidden type", () => {
      mountYear();
      const cell = screen.getByTestId("week-cell-msk-2026-11-02");
      expect(cell.classList).not.toContain("tl-week--mixed");
      expect(cell.getAttribute("aria-label")).not.toContain("mehrere Arten");
    });
  });
});
