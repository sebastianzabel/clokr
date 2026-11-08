// Issue #840 (D-840-12, AC-7) — the one leave-type colour mapping.
//
// The fill and the text token are asserted as separate strings: `leave-chip-contrast` Test 3 scans
// test files too and reads a fill key followed by a `-text` token in one literal as a text token
// used as a background.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ABSENT,
  ABSENT_MUTED,
  FALLBACK,
  WISH,
  allLeaveColorTokens,
  leaveTypeColor,
  legendFrom,
} from "../leave-colors";
import {
  LEAVE_TYPES,
  resolveChipVisual,
  type CalendarTypeCode,
  type ChipEntry,
} from "../team-calendar-visibility";
import type { TimelineBar, TimelinePerson } from "../timeline-model";

// jsdom gives `import.meta.url` a non-file scheme, so the path is taken from the package cwd.
const TOKENS_CSS = readFileSync(resolve(process.cwd(), "src/tokens.css"), "utf8");

// `[data-mode="dark"] {` is a substring of `html[data-mode="dark"] {`, which holds only
// `color-scheme` — reject a match preceded by an identifier character (leave-chip-contrast).
function extractBlock(css: string, selector: string): string {
  const idChar = /[A-Za-z0-9_-]/;
  let from = 0;
  for (;;) {
    const idx = css.indexOf(selector, from);
    if (idx === -1) throw new Error(`Selector not found in tokens.css: ${selector}`);
    if (idx > 0 && idChar.test(css[idx - 1])) {
      from = idx + selector.length;
      continue;
    }
    const open = css.indexOf("{", idx);
    return css.slice(open + 1, css.indexOf("}", open));
  }
}

function declared(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]));
}

const LIGHT = declared(extractBlock(TOKENS_CSS, ":root"));
const DARK = declared(extractBlock(TOKENS_CSS, '[data-mode="dark"]'));

describe("leaveTypeColor", () => {
  it("returns a fill and its -text partner for every code of the calendar's table", () => {
    expect(LEAVE_TYPES.length).toBeGreaterThanOrEqual(10);
    for (const type of LEAVE_TYPES) {
      const color = leaveTypeColor(type.code);
      expect(color.fill, type.code).toMatch(/^--leave-type-[a-z-]+$/);
      expect(color.text, type.code).toBe(`${color.fill}-text`);
    }
  });

  it("Urlaub is the green token", () => {
    expect(leaveTypeColor("VACATION").fill).toBe("--leave-type-vacation");
    expect(leaveTypeColor("VACATION").text).toBe("--leave-type-vacation-text");
  });

  it("gives every code its own fill (colour is one carrier of the type, never two types one colour)", () => {
    const fills = LEAVE_TYPES.map((t) => leaveTypeColor(t.code).fill);
    // UNPAID is gray like the fallback, but its own token; no two codes share one.
    expect(new Set(fills).size).toBe(fills.length);
  });

  it("null is the absent pair, an unknown code the fallback pair", () => {
    expect(leaveTypeColor(null)).toBe(ABSENT);
    expect(ABSENT.fill).toBe("--leave-type-absent");
    expect(ABSENT.text).toBe("--leave-type-absent-text");
    expect(leaveTypeColor("NOT_A_CODE")).toBe(FALLBACK);
    expect(FALLBACK.fill).toBe("--leave-type-default");
    expect(FALLBACK.text).toBe("--leave-type-default-text");
    expect(ABSENT_MUTED.fill).toBe("--leave-type-absent-muted");
    expect(ABSENT_MUTED.text).toBe("--leave-type-absent-muted-text");
  });

  it("a wish is drawn in the brand colour and has no leave-type token of its own", () => {
    expect(WISH.fill).toBe("--brand");
    expect(WISH.text).toBe("--text-on-brand");
    expect(WISH.fill.startsWith("--leave-type-")).toBe(false);
  });
});

describe("the tokens the mapping names exist in both modes", () => {
  it("both token blocks parsed (anti-vacuity)", () => {
    expect(LIGHT.has("--leave-type-vacation")).toBe(true);
    expect(DARK.has("--leave-type-vacation")).toBe(true);
    expect(LIGHT.size).toBeGreaterThan(20);
    expect(DARK.size).toBeGreaterThan(20);
  });

  it("every fill and text name the mapping can return is declared in :root and in the dark block", () => {
    const names = allLeaveColorTokens();
    expect(names.length).toBeGreaterThanOrEqual(26);
    for (const name of names) {
      expect(LIGHT.has(name), `${name} missing in :root`).toBe(true);
      expect(DARK.has(name), `${name} missing in the dark block`).toBe(true);
    }
  });
});

describe("the visibility helper reads the mapping (no value changed)", () => {
  it("LEAVE_TYPES[].colorVar equals the mapping's fill", () => {
    for (const type of LEAVE_TYPES) {
      expect(type.colorVar, type.code).toBe(leaveTypeColor(type.code).fill);
    }
  });

  it("the chip of a visible type, of a hidden approved type and of a hidden pending type", () => {
    const base: ChipEntry = {
      typeCode: "VACATION",
      typeName: null,
      status: "APPROVED",
      isOwn: true,
    };
    const own = resolveChipVisual(base, false);
    expect(own.background).toBe("var(--leave-type-vacation)");
    expect(own.textColor).toBe("var(--leave-type-vacation-text, #ffffff)");

    const foreign = resolveChipVisual({ ...base, isOwn: false }, false);
    expect(foreign.background).toBe(`var(${ABSENT.fill})`);
    expect(foreign.textColor).toBe(`var(${ABSENT.text}, #ffffff)`);

    const pending = resolveChipVisual({ ...base, isOwn: false, status: "PENDING" }, false);
    expect(pending.background).toBe(`var(${ABSENT_MUTED.fill})`);
    expect(pending.textColor).toBe(`var(${ABSENT_MUTED.text}, #ffffff)`);
  });

  it("a code the table does not know falls back to the default pair", () => {
    const visual = resolveChipVisual(
      {
        typeCode: "NOT_A_CODE" as CalendarTypeCode,
        typeName: "Anderes",
        status: "APPROVED",
        isOwn: true,
      },
      false,
    );
    expect(visual.background).toBe(`var(${FALLBACK.fill})`);
    expect(visual.textColor).toBe(`var(${FALLBACK.text}, #ffffff)`);
  });
});

describe("legendFrom", () => {
  const bar = (style: TimelineBar["style"], typeCode: string | null, key: string): TimelineBar => ({
    key,
    start: "2026-03-02",
    end: "2026-03-03",
    style,
    typeCode,
    label: "x",
    editable: false,
  });
  const person = (bars: TimelineBar[]): TimelinePerson => ({
    employeeId: "e1",
    name: "A",
    isOwn: false,
    bars,
  });
  const order = LEAVE_TYPES.map((t) => t.code);

  it("names the types of the set and requested bars in table order, plus the styles that occur", () => {
    const result = legendFrom(
      [
        person([bar("beantragt", "SICK", "a"), bar("gesetzt", "VACATION", "b")]),
        person([bar("gesetzt", "VACATION", "c"), bar("abwesend", null, "d")]),
      ],
      order,
    );
    expect(result.typeCodes).toEqual(["VACATION", "SICK"]);
    expect(result.styles).toEqual(["gesetzt", "beantragt", "abwesend"]);
  });

  it("a wish adds a style but no type; a masked bar adds neither a type nor a code", () => {
    const result = legendFrom(
      [person([bar("wunsch", "VACATION", "w"), bar("abwesend", null, "m")])],
      order,
    );
    expect(result.typeCodes).toEqual([]);
    expect(result.styles).toEqual(["wunsch", "abwesend"]);
  });

  it("no rows, nothing in the legend", () => {
    expect(legendFrom([], order)).toEqual({ typeCodes: [], styles: [] });
  });
});
