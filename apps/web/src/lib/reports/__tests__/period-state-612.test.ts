// Issue #612 (D-612-1, P-10, P-16, P-20) — the /reports URL state, period kinds, arrow steps,
// presets and range validation. Pure functions; `today` is always passed in.

import { describe, it, expect } from "vitest";
import {
  activePreset,
  arrowLabels,
  canStepNext,
  clampToToday,
  isPlainLeftClick,
  parsePeriodState,
  periodEyebrow,
  periodKind,
  periodLabel,
  periodSearch,
  presetPeriods,
  RANGE_ERROR_TEXT,
  stepPeriod,
  validateRange,
} from "../period-state";

const TODAY = { year: 2026, month: 10 };
const ym = (year: number, month: number) => ({ year, month });
const TABS = ["zeiten", "urlaub", "heute"] as const;
const UUID_A = "3f2b8c1e-6d4a-4b7e-9a10-5c2d8e7f1a33";
const UUID_B = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

function parse(
  query: string,
  today = TODAY,
  tabs: readonly ("zeiten" | "urlaub" | "heute")[] = TABS,
) {
  return parsePeriodState(new URLSearchParams(query), today, tabs);
}

describe("parsePeriodState", () => {
  it("defaults to the current month and the first allowed tab", () => {
    const s = parse("");
    expect(s).toEqual({ from: TODAY, to: TODAY, tab: "zeiten", person: null, salonId: null });
  });

  it("has no tab when the caller may see none", () => {
    expect(parse("tab=urlaub", TODAY, []).tab).toBeNull();
  });

  it("round-trips a full query in the stable key order", () => {
    const q = `from=2026-07&to=2026-09&tab=urlaub&salonId=${UUID_A}&person=${UUID_B}`;
    const s = parse(q);
    expect(s.from).toEqual(ym(2026, 7));
    expect(s.to).toEqual(ym(2026, 9));
    expect(s.tab).toBe("urlaub");
    expect(periodSearch(s)).toBe(q);
  });

  it("writes the keys in a stable order whatever the input order was", () => {
    const s = parse(`person=${UUID_B}&tab=heute&to=2026-09&from=2026-09&salonId=${UUID_A}`);
    expect(periodSearch(s)).toBe(
      `from=2026-09&to=2026-09&tab=heute&salonId=${UUID_A}&person=${UUID_B}`,
    );
  });

  it("leaves out an empty tab, person and salon", () => {
    expect(periodSearch({ from: TODAY, to: TODAY, tab: null, person: null, salonId: null })).toBe(
      "from=2026-10&to=2026-10",
    );
  });

  it("clamps a future `to` to the current month (P-16)", () => {
    const s = parse("from=2026-08&to=2027-03");
    expect(s.from).toEqual(ym(2026, 8));
    expect(s.to).toEqual(TODAY);
  });

  it("collapses a period lying wholly in the future to the current month", () => {
    const s = parse("from=2027-01&to=2027-03");
    expect(s.from).toEqual(TODAY);
    expect(s.to).toEqual(TODAY);
  });

  it("falls back to the default for `from` after `to` and for malformed values", () => {
    for (const q of [
      "from=2026-09&to=2026-07",
      "from=2026-9&to=2026-10",
      "from=abc&to=2026-10",
      "from=2026-13&to=2026-10",
      "from=2026-07",
      "to=2026-07",
      "from=2026-07-01&to=2026-08-01",
    ]) {
      const s = parse(q);
      expect(s.from, q).toEqual(TODAY);
      expect(s.to, q).toEqual(TODAY);
    }
  });

  it("limits a period to twelve months by moving `from` (P-10)", () => {
    const s = parse("from=2025-01&to=2026-10");
    expect(s.to).toEqual(ym(2026, 10));
    expect(s.from).toEqual(ym(2025, 11));
    const thirteen = parse("from=2025-09&to=2026-09");
    expect(thirteen.from).toEqual(ym(2025, 10));
    const twelve = parse("from=2025-10&to=2026-09");
    expect(twelve.from).toEqual(ym(2025, 10));
  });

  it("replaces a tab the caller may not see by the first allowed tab", () => {
    expect(parse("tab=heute", TODAY, ["zeiten", "urlaub"]).tab).toBe("zeiten");
    expect(parse("tab=bogus").tab).toBe("zeiten");
    expect(parse("tab=heute", TODAY, ["heute"]).tab).toBe("heute");
    expect(parse("", TODAY, ["heute"]).tab).toBe("heute");
  });

  it("drops a malformed person and salonId", () => {
    const s = parse("person=not-a-uuid&salonId=1234");
    expect(s.person).toBeNull();
    expect(s.salonId).toBeNull();
    expect(parse(`person=${UUID_B.toUpperCase()}`).person).toBe(UUID_B.toUpperCase());
  });
});

describe("periodKind, labels, eyebrows and arrow labels", () => {
  const cases: Array<{
    from: [number, number];
    to: [number, number];
    kind: string;
    label: string;
    eyebrow: string;
    prev: string;
    next: string;
  }> = [
    {
      from: [2026, 10],
      to: [2026, 10],
      kind: "month",
      label: "Oktober 2026",
      eyebrow: "Monat",
      prev: "Vorheriger Monat",
      next: "Nächster Monat",
    },
    {
      from: [2026, 7],
      to: [2026, 9],
      kind: "quarter",
      label: "Jul – Sep 2026",
      eyebrow: "Quartal",
      prev: "Vorheriges Quartal",
      next: "Nächstes Quartal",
    },
    {
      from: [2025, 1],
      to: [2025, 12],
      kind: "year",
      label: "Jan – Dez 2025",
      eyebrow: "Jahr",
      prev: "Vorheriges Jahr",
      next: "Nächstes Jahr",
    },
    {
      from: [2026, 1],
      to: [2026, 10],
      kind: "year",
      label: "Jan – Okt 2026",
      eyebrow: "Jahr",
      prev: "Vorheriges Jahr",
      next: "Nächstes Jahr",
    },
    {
      from: [2026, 1],
      to: [2026, 3],
      kind: "quarter",
      label: "Jan – Mär 2026",
      eyebrow: "Quartal",
      prev: "Vorheriges Quartal",
      next: "Nächstes Quartal",
    },
    {
      from: [2026, 8],
      to: [2026, 10],
      kind: "range",
      label: "Aug – Okt 2026",
      eyebrow: "Zeitraum · 3 Monate",
      prev: "Vorheriger Zeitraum",
      next: "Nächster Zeitraum",
    },
    {
      from: [2025, 11],
      to: [2026, 1],
      kind: "range",
      label: "Nov 2025 – Jan 2026",
      eyebrow: "Zeitraum · 3 Monate",
      prev: "Vorheriger Zeitraum",
      next: "Nächster Zeitraum",
    },
  ];

  for (const c of cases) {
    it(`${c.from.join("-")}..${c.to.join("-")} is a ${c.kind} (${c.label})`, () => {
      const from = ym(...c.from);
      const to = ym(...c.to);
      expect(periodKind(from, to, TODAY)).toBe(c.kind);
      expect(periodLabel(from, to, TODAY)).toBe(c.label);
      expect(periodEyebrow(from, to, TODAY)).toBe(c.eyebrow);
      expect(arrowLabels(periodKind(from, to, TODAY))).toEqual({ prev: c.prev, next: c.next });
    });
  }

  it("never calls a single month a quarter (P-20)", () => {
    expect(periodKind(ym(2026, 10), ym(2026, 10), TODAY)).toBe("month");
    expect(periodKind(ym(2026, 1), ym(2026, 1), TODAY)).toBe("month");
  });

  it("detects the running quarter of two months", () => {
    const today = ym(2026, 11);
    expect(periodKind(ym(2026, 10), ym(2026, 11), today)).toBe("quarter");
    expect(periodLabel(ym(2026, 10), ym(2026, 11), today)).toBe("Okt – Nov 2026");
  });

  it("does not call a past partial quarter a quarter", () => {
    expect(periodKind(ym(2025, 10), ym(2025, 11), TODAY)).toBe("range");
  });

  it("counts the months in a range eyebrow", () => {
    expect(periodEyebrow(ym(2026, 5), ym(2026, 10), TODAY)).toBe("Zeitraum · 6 Monate");
  });
});

describe("stepPeriod / canStepNext", () => {
  it("steps a month by one", () => {
    expect(stepPeriod(ym(2026, 7), ym(2026, 7), -1, TODAY)).toEqual({
      from: ym(2026, 6),
      to: ym(2026, 6),
    });
    expect(stepPeriod(ym(2026, 12), ym(2026, 12), 1, ym(2027, 3))).toEqual({
      from: ym(2027, 1),
      to: ym(2027, 1),
    });
    expect(stepPeriod(TODAY, TODAY, 1, TODAY)).toBeNull();
    expect(canStepNext(TODAY, TODAY, TODAY)).toBe(false);
    expect(canStepNext(ym(2026, 9), ym(2026, 9), TODAY)).toBe(true);
  });

  it("steps a quarter by one quarter and clamps the running one", () => {
    const q2 = stepPeriod(ym(2026, 4), ym(2026, 6), 1, TODAY);
    expect(q2).toEqual({ from: ym(2026, 7), to: ym(2026, 9) });
    const running = stepPeriod(ym(2026, 7), ym(2026, 9), 1, TODAY);
    expect(running).toEqual({ from: ym(2026, 10), to: ym(2026, 10) });
    // the running quarter has become a single month
    expect(periodKind(running!.from, running!.to, TODAY)).toBe("month");
    expect(stepPeriod(ym(2026, 7), ym(2026, 9), -1, TODAY)).toEqual({
      from: ym(2026, 4),
      to: ym(2026, 6),
    });
    expect(stepPeriod(ym(2025, 10), ym(2025, 12), 1, TODAY)).toEqual({
      from: ym(2026, 1),
      to: ym(2026, 3),
    });
  });

  it("steps a year by one year and clamps the running one", () => {
    expect(stepPeriod(ym(2025, 1), ym(2025, 12), 1, TODAY)).toEqual({
      from: ym(2026, 1),
      to: ym(2026, 10),
    });
    expect(stepPeriod(ym(2026, 1), ym(2026, 10), -1, TODAY)).toEqual({
      from: ym(2025, 1),
      to: ym(2025, 12),
    });
    expect(stepPeriod(ym(2026, 1), ym(2026, 10), 1, TODAY)).toBeNull();
  });

  it("steps a range by its own length and refuses to pass the current month", () => {
    const first = stepPeriod(ym(2026, 5), ym(2026, 7), 1, TODAY);
    expect(first).toEqual({ from: ym(2026, 8), to: ym(2026, 10) });
    expect(stepPeriod(first!.from, first!.to, 1, TODAY)).toBeNull();
    expect(stepPeriod(ym(2026, 5), ym(2026, 7), -1, TODAY)).toEqual({
      from: ym(2026, 2),
      to: ym(2026, 4),
    });
    expect(stepPeriod(ym(2025, 11), ym(2026, 1), -1, TODAY)).toEqual({
      from: ym(2025, 8),
      to: ym(2025, 10),
    });
  });
});

describe("presets", () => {
  const keys = (p: ReturnType<typeof presetPeriods>) =>
    p.map((x) => `${x.label}:${x.from.year}-${x.from.month}..${x.to.year}-${x.to.month}`);

  it("returns the five presets in order (today = 2026-10)", () => {
    expect(keys(presetPeriods(TODAY))).toEqual([
      "Dieser Monat:2026-10..2026-10",
      "Vormonat:2026-9..2026-9",
      "Quartal:2026-10..2026-10",
      "Jahr:2026-1..2026-10",
      "Letzte 3 Monate:2026-8..2026-10",
    ]);
  });

  it("crosses the year boundary (today = 2026-01)", () => {
    const p = presetPeriods(ym(2026, 1));
    expect(p[1].from).toEqual(ym(2025, 12));
    expect(p[4].from).toEqual(ym(2025, 11));
    expect(p[4].to).toEqual(ym(2026, 1));
  });

  it("starts the running quarter on its first month", () => {
    expect(presetPeriods(ym(2026, 8))[2]).toMatchObject({ from: ym(2026, 7), to: ym(2026, 8) });
    expect(presetPeriods(ym(2026, 3))[2]).toMatchObject({ from: ym(2026, 1), to: ym(2026, 3) });
  });

  // Issue #781, owner decision 27.10.2026 (replaces P-20 of #612, which marked every equal preset
  // at once): exactly ONE preset is pressed - the clicked one, else the first in display order.
  it("presses exactly one preset, the first matching one without a click", () => {
    // October: "Dieser Monat" and "Quartal" are the same single month
    expect(activePreset(TODAY, TODAY, TODAY)).toBe("this-month");
    expect(activePreset(ym(2026, 9), ym(2026, 9), TODAY)).toBe("previous-month");
    expect(activePreset(ym(2026, 1), ym(2026, 10), TODAY)).toBe("year");
    expect(activePreset(ym(2026, 8), ym(2026, 10), TODAY)).toBe("last-3-months");
    // a custom range matching no preset presses none
    expect(activePreset(ym(2026, 2), ym(2026, 4), TODAY)).toBeNull();
  });

  it("presses the clicked preset in October (month vs quarter)", () => {
    expect(activePreset(TODAY, TODAY, TODAY, "quarter")).toBe("quarter");
    expect(activePreset(TODAY, TODAY, TODAY, "this-month")).toBe("this-month");
  });

  it("presses exactly one of month, quarter and year in January", () => {
    const jan = ym(2026, 1);
    expect(activePreset(jan, jan, jan)).toBe("this-month");
    expect(activePreset(jan, jan, jan, "quarter")).toBe("quarter");
    expect(activePreset(jan, jan, jan, "year")).toBe("year");
  });

  it("ignores a clicked preset that no longer equals the period", () => {
    expect(activePreset(ym(2026, 9), ym(2026, 9), TODAY, "quarter")).toBe("previous-month");
    expect(activePreset(ym(2026, 2), ym(2026, 4), TODAY, "year")).toBeNull();
  });
});

describe("validateRange", () => {
  it("accepts a valid range", () => {
    expect(validateRange(ym(2026, 8), ym(2026, 10), TODAY)).toBeNull();
    expect(validateRange(ym(2025, 11), ym(2026, 10), TODAY)).toBeNull();
  });

  it("reports `Bis` before `Von` first", () => {
    expect(validateRange(ym(2026, 9), ym(2026, 7), TODAY)).toBe("TO_BEFORE_FROM");
    expect(validateRange(ym(2027, 9), ym(2026, 7), TODAY)).toBe("TO_BEFORE_FROM");
  });

  it("reports more than twelve months", () => {
    expect(validateRange(ym(2025, 9), ym(2026, 10), TODAY)).toBe("TOO_LONG");
  });

  it("reports a future `Bis`", () => {
    expect(validateRange(ym(2026, 8), ym(2026, 11), TODAY)).toBe("FUTURE");
  });

  it("carries the three copy-deck texts", () => {
    expect(RANGE_ERROR_TEXT).toEqual({
      TO_BEFORE_FROM: "„Bis“ liegt vor „Von“.",
      TOO_LONG: "Höchstens 12 Monate auf einmal.",
      FUTURE: "„Bis“ darf nicht in der Zukunft liegen.",
    });
  });
});

describe("clampToToday / isPlainLeftClick", () => {
  it("clamps only a month after today", () => {
    expect(clampToToday(ym(2027, 1), TODAY)).toEqual(TODAY);
    expect(clampToToday(ym(2026, 3), TODAY)).toEqual(ym(2026, 3));
  });

  it("is true only for an unmodified primary click", () => {
    const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainLeftClick(base)).toBe(true);
    expect(isPlainLeftClick({ ...base, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, altKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, button: 1 })).toBe(false);
  });
});
