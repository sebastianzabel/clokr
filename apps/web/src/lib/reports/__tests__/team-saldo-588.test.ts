// Issue #588 - the pure team saldo figures (median, Top lists, exclusions, cells) behind the
// dashboard card and /reports.
import { describe, it, expect } from "vitest";
import {
  teamSaldoFigures,
  teamSaldoExclusion,
  teamSaldoCells,
  totalMinutesOf,
  TEAM_SALDO_EXCLUSION_LABEL,
  forecastLabel,
  forecastColumnLabel,
  periodSaldoExclusion,
  periodSaldoFigures,
  type PeriodSaldoRow,
  type TeamSaldoRow,
} from "../team-saldo";

/** A row shaped like the overview answer; total = confirmed + open. */
function row(id: string, confirmed: number, open: number, extra: Partial<TeamSaldoRow> = {}) {
  return {
    id,
    name: `Person ${id}`,
    balanceHours: (confirmed + open) / 60,
    confirmedMinutes: confirmed,
    openMonthMinutes: open,
    hasClosedMonth: true,
    hasRecordedTime: true,
    trackOnly: false,
    unconfirmedMonths: 1,
    ...extra,
  } satisfies TeamSaldoRow;
}

/** A counted row whose total is exactly `total` minutes. */
const total = (id: string, minutes: number, extra: Partial<TeamSaldoRow> = {}) =>
  row(id, minutes, 0, extra);

describe("tracer", () => {
  it("leaves a person without recorded time out of the median and lists them as „ohne Erfassung“", () => {
    const figures = teamSaldoFigures([
      row("A", 60, 60),
      row("B", -60, 0),
      row("C", -2400, 0, { hasRecordedTime: false }),
    ]);
    expect(figures.counted).toBe(2);
    // A = +2:00 (120), B = −1:00 (−60): the mean of the two middle values, +0:30.
    expect(figures.medianMinutes).toBe(30);
    expect(figures.excluded).toEqual([
      { id: "C", name: "Person C", reason: "NO_RECORDED_TIME", reasonLabel: "ohne Erfassung" },
    ]);
  });
});

describe("exclusion", () => {
  it("applies the precedence SALDO_UNAVAILABLE > TIME_TRACKING_ONLY > NO_RECORDED_TIME, one reason per person", () => {
    const all = { openMonthMinutes: null, trackOnly: true, hasRecordedTime: false };
    expect(teamSaldoExclusion(row("a", 0, 0, all))).toBe("SALDO_UNAVAILABLE");
    expect(teamSaldoExclusion(row("b", 0, 0, { trackOnly: true, hasRecordedTime: false }))).toBe(
      "TIME_TRACKING_ONLY",
    );
    expect(teamSaldoExclusion(row("c", 0, 0, { hasRecordedTime: false }))).toBe("NO_RECORDED_TIME");
    expect(teamSaldoExclusion(row("d", 0, 0))).toBeNull();
  });

  it("words the three reasons", () => {
    expect(TEAM_SALDO_EXCLUSION_LABEL).toEqual({
      SALDO_UNAVAILABLE: "Saldo nicht verfügbar",
      TIME_TRACKING_ONLY: "nur Zeiterfassung",
      NO_RECORDED_TIME: "ohne Erfassung",
    });
  });

  it("never excludes on a fact the server did not send", () => {
    const old = { id: "o", name: "Person O", balanceHours: 1.5 } satisfies TeamSaldoRow;
    expect(teamSaldoExclusion(old)).toBeNull();
    const figures = teamSaldoFigures([old]);
    expect(figures.counted).toBe(1);
    expect(figures.medianMinutes).toBe(90); // falls back to the headline hours
    expect(figures.excluded).toEqual([]);
  });

  it("neither counts nor lists a row of the exited section", () => {
    const figures = teamSaldoFigures([
      total("a", 60),
      total("x", -9000, { exitedWithOpenFinalSaldo: true }),
      total("y", 5, { exitedWithOpenFinalSaldo: true, hasRecordedTime: false }),
    ]);
    expect(figures.counted).toBe(1);
    expect(figures.excluded).toEqual([]);
    expect(figures.minus).toEqual([]);
  });

  it("lists the excluded persons by name, then id", () => {
    const figures = teamSaldoFigures([
      row("2", 0, 0, { name: "Beta", hasRecordedTime: false }),
      row("3", 0, 0, { name: "Alpha", hasRecordedTime: false }),
      row("1", 0, 0, { name: "Alpha", hasRecordedTime: false }),
    ]);
    expect(figures.excluded.map((e) => e.id)).toEqual(["1", "3", "2"]);
  });
});

describe("median", () => {
  const median = (...minutes: number[]) =>
    teamSaldoFigures(minutes.map((m, i) => total(String(i), m))).medianMinutes;

  it("is the middle value for an odd count", () => {
    expect(median(300, -600, 20)).toBe(20);
  });
  it("is the mean of the two middle values, rounded to whole minutes, for an even count", () => {
    expect(median(10, 20, 30, 41)).toBe(25); // (20 + 30) / 2
    expect(median(1, 2)).toBe(2); // 1.5 rounds up
    expect(median(-2, -1)).toBe(-1); // −1.5 rounds towards +∞
  });
  it("is not the arithmetic mean: one extreme value does not move it", () => {
    expect(median(10, 20, 30, 40, 100000)).toBe(30);
  });
  it("is null when nobody counts", () => {
    expect(median()).toBeNull();
    expect(teamSaldoFigures([row("a", 0, 0, { trackOnly: true })]).medianMinutes).toBeNull();
  });
  it("never returns a negative zero", () => {
    const m = median(-1, 1);
    expect(m).toBe(0);
    expect(Object.is(m, -0)).toBe(false);
  });
});

describe("Top lists", () => {
  it("takes the five largest positive and the five most negative totals of more than five on each side", () => {
    const rows = [
      ...[10, 20, 30, 40, 50, 60, 70].map((m) => total(`p${m}`, m)),
      ...[-10, -20, -30, -40, -50, -60, -70].map((m) => total(`n${-m}`, m)),
    ];
    const f = teamSaldoFigures(rows);
    expect(f.plus.map((b) => b.totalMinutes)).toEqual([70, 60, 50, 40, 30]);
    expect(f.minus.map((b) => b.totalMinutes)).toEqual([-70, -60, -50, -40, -30]);
  });

  it("breaks ties by name, then id, and keeps a zero total out of both lists", () => {
    const f = teamSaldoFigures([
      total("2", 60, { name: "Beta" }),
      total("3", 60, { name: "Alpha" }),
      total("1", 60, { name: "Alpha" }),
      total("z", 0),
      total("m2", -30, { name: "Beta" }),
      total("m1", -30, { name: "Alpha" }),
    ]);
    expect(f.plus.map((b) => b.id)).toEqual(["1", "3", "2"]);
    expect(f.minus.map((b) => b.id)).toEqual(["m1", "m2"]);
    expect([...f.plus, ...f.minus].some((b) => b.id === "z")).toBe(false);
    expect(f.counted).toBe(6);
  });

  it("lists fewer than five when fewer exist and honours topN", () => {
    const f = teamSaldoFigures([total("a", 5), total("b", -5)]);
    expect(f.plus).toHaveLength(1);
    expect(f.minus).toHaveLength(1);
    const g = teamSaldoFigures([total("a", 1), total("b", 2), total("c", 3)], 2);
    expect(g.plus.map((b) => b.id)).toEqual(["c", "b"]);
  });

  it("orders the diverging list plus first, then the minus list reversed (most negative last)", () => {
    const f = teamSaldoFigures([total("a", 30), total("b", 10), total("c", -10), total("d", -30)]);
    expect(f.diverging.map((b) => b.id)).toEqual(["a", "b", "c", "d"]);
    expect(f.diverging.map((b) => b.totalMinutes)).toEqual([30, 10, -10, -30]);
  });

  it("labels each bar as ±H:MM", () => {
    const f = teamSaldoFigures([total("a", 125), total("b", -61)]);
    expect(f.plus[0].label).toBe("+2:05");
    expect(f.minus[0].label).toBe("−1:01");
  });
});

describe("totalMinutesOf", () => {
  it("adds confirmed and running, else falls back to the rounded headline hours", () => {
    expect(totalMinutesOf(row("a", 60, -20))).toBe(40);
    expect(totalMinutesOf({ id: "x", name: "X", balanceHours: -0.5 })).toBe(-30);
    expect(totalMinutesOf(row("n", 60, 0, { openMonthMinutes: null, balanceHours: 2 }))).toBe(120);
  });
});

describe("teamSaldoCells", () => {
  it("formats all three values as ±H:MM with U+2212 for a negative", () => {
    const c = teamSaldoCells(row("a", 90, -150));
    expect(c.confirmed).toEqual({ text: "+1:30" });
    expect(c.open).toEqual({ text: "−2:30" });
    expect(c.total).toEqual({ text: "−1:00" });
  });
  it("reads an exact zero as ±0:00", () => {
    expect(teamSaldoCells(row("a", 0, 0)).total.text).toBe("±0:00");
    expect(teamSaldoCells(row("a", 0, 0)).confirmed.text).toBe("±0:00");
  });
  it("shows a dash with a reason for the confirmed part before the first Monatsabschluss", () => {
    const c = teamSaldoCells(row("a", 0, 120, { hasClosedMonth: false }));
    expect(c.confirmed).toEqual({ text: "—", title: "noch kein Monatsabschluss" });
    expect(c.total.text).toBe("+2:00");
  });
  it("shows a dash for the running part when the live saldo is unavailable", () => {
    const c = teamSaldoCells(row("a", 60, 0, { openMonthMinutes: null, balanceHours: 1 }));
    expect(c.open.text).toBe("—");
    expect(c.total.text).toBe("+1:00");
  });
  it("names the number of unclosed months in the title when there are more than one", () => {
    expect(teamSaldoCells(row("a", 0, 60, { unconfirmedMonths: 3 })).open.title).toBe(
      "3 Monate ohne Monatsabschluss",
    );
    expect(teamSaldoCells(row("a", 0, 60, { unconfirmedMonths: 1 })).open.title).toBeUndefined();
    expect(teamSaldoCells(row("a", 0, 60, { unconfirmedMonths: null })).open.title).toBeUndefined();
  });
});

describe("re-exports", () => {
  it("hands out the one forecast label rule", () => {
    expect(forecastLabel(1, true)).toBe("Laufender Monat (Prognose)");
    expect(forecastColumnLabel([{ unconfirmedMonths: 1, hasClosedMonth: true }])).toBe(
      "Laufender Monat (Prognose)",
    );
  });
});

// ── Issue #612 (P-12): the same rule over the rows of GET /reports/period ──────────────────────

/** A counted period row whose closing saldo is exactly `closing` minutes. */
function periodRow(id: string, closing: number | null, extra: Partial<PeriodSaldoRow> = {}) {
  return {
    employeeId: id,
    employeeName: `Person ${id}`,
    closingBalanceMinutes: closing,
    labelled: true,
    hasRecordedTime: true,
    ...extra,
  } satisfies PeriodSaldoRow;
}

describe("periodSaldoFigures (Issue #612)", () => {
  it("is the median of the closing saldi of the persons who count (odd and even)", () => {
    expect(
      periodSaldoFigures([periodRow("A", 60), periodRow("B", -120), periodRow("C", 600)]),
    ).toMatchObject({ counted: 3, medianMinutes: 60, excluded: [] });
    // Even count: the mean of the two middle values, rounded to whole minutes (module rule).
    expect(periodSaldoFigures([periodRow("A", 1), periodRow("B", 2)]).medianMinutes).toBe(2);
    expect(periodSaldoFigures([periodRow("A", -3), periodRow("B", 0)]).medianMinutes).toBe(-1);
  });

  it("an empty period has no median", () => {
    expect(periodSaldoFigures([])).toEqual({ counted: 0, medianMinutes: null, excluded: [] });
  });

  it("a closing saldo of exactly zero counts and a negative zero never leaks", () => {
    const figures = periodSaldoFigures([periodRow("A", 0), periodRow("B", 0)]);
    expect(figures.counted).toBe(2);
    expect(Object.is(figures.medianMinutes, 0)).toBe(true);
    expect(
      Object.is(periodSaldoFigures([periodRow("A", 1), periodRow("B", -1)]).medianMinutes, 0),
    ).toBe(true);
  });

  it("no closing saldo and no labelled month is „nur Zeiterfassung“ - the module's own label", () => {
    const figures = periodSaldoFigures([
      periodRow("A", 100),
      periodRow("B", null, { labelled: false }),
    ]);
    expect(figures.counted).toBe(1);
    expect(figures.excluded).toEqual([
      {
        employeeId: "B",
        name: "Person B",
        reason: "TIME_TRACKING_ONLY",
        reasonLabel: TEAM_SALDO_EXCLUSION_LABEL.TIME_TRACKING_ONLY,
      },
    ]);
    expect(figures.excluded[0].reasonLabel).toBe("nur Zeiterfassung");
  });

  it("a withheld closing saldo of a person WITH a Soll is „Saldo nicht verfügbar“", () => {
    const figures = periodSaldoFigures([periodRow("A", null)]);
    expect(figures.medianMinutes).toBeNull();
    expect(figures.excluded[0]).toMatchObject({
      reason: "SALDO_UNAVAILABLE",
      reasonLabel: "Saldo nicht verfügbar",
    });
  });

  it("a person who never recorded time is „ohne Erfassung“; an absent fact never excludes", () => {
    const figures = periodSaldoFigures([
      periodRow("A", -2400, { hasRecordedTime: false }),
      periodRow("B", 60, { hasRecordedTime: undefined }),
      periodRow("C", 120),
    ]);
    expect(figures.counted).toBe(2);
    expect(figures.medianMinutes).toBe(90);
    expect(figures.excluded.map((e) => [e.employeeId, e.reasonLabel])).toEqual([
      ["A", "ohne Erfassung"],
    ]);
  });

  it("each excluded person carries exactly one reason, in the module's precedence", () => {
    // No Soll wins over a withheld saldo, which wins over no recorded time.
    expect(
      periodSaldoExclusion(periodRow("A", null, { labelled: false, hasRecordedTime: false })),
    ).toBe("TIME_TRACKING_ONLY");
    expect(periodSaldoExclusion(periodRow("A", null, { hasRecordedTime: false }))).toBe(
      "SALDO_UNAVAILABLE",
    );
    expect(periodSaldoExclusion(periodRow("A", 0, { hasRecordedTime: false }))).toBe(
      "NO_RECORDED_TIME",
    );
    // A track-only contract's saldo of 0 does not count either (rule (c) of the module header).
    expect(periodSaldoExclusion(periodRow("A", 0, { labelled: false }))).toBe("TIME_TRACKING_ONLY");
    expect(periodSaldoExclusion(periodRow("A", 5))).toBeNull();
  });

  it("lists the excluded persons ordered by name, then id, with the German collation", () => {
    const figures = periodSaldoFigures([
      periodRow("2", null, { employeeName: "Zoe" }),
      periodRow("1", null, { employeeName: "Äpfel" }),
      periodRow("3", null, { employeeName: "Anna" }),
    ]);
    expect(figures.excluded.map((e) => e.name)).toEqual(["Anna", "Äpfel", "Zoe"]);
  });

  it("does not mutate its input", () => {
    const rows = [periodRow("B", 5), periodRow("A", -5)];
    const copy = JSON.stringify(rows);
    periodSaldoFigures(rows);
    expect(JSON.stringify(rows)).toBe(copy);
  });
});
