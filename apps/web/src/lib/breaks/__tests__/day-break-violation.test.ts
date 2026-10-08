// Issue #80 (D-09/D-11/D-20) — the presentation helpers for the server-computed day check.
// The browser never computes a cross-salon finding itself, so these tests pin the mapping from
// the API's DayCheck to badge, warnings and calendar-marker merge.

import { describe, it, expect } from "vitest";
import {
  type DayCheck,
  type DayWarning,
  isChecksRangeAllowed,
  dayCheckBadge,
  dayCheckWarnings,
  mergeDayChecksIntoArbzgMap,
  crossSalonSaveNotice,
  crossSalonMonthCloseHint,
} from "../day-break-violation";

function check(over: Partial<DayCheck> = {}): DayCheck {
  return {
    date: "2026-03-10",
    detail: "full",
    crossSalon: true,
    netWorkedMinutes: 480,
    totalBreakMinutes: 0,
    requiredBreakMinutes: 30,
    breakShortfall: true,
    maxDailyExceeded: false,
    acknowledged: false,
    locked: false,
    mayAcknowledge: false,
    mayRecordDayBreak: true,
    acknowledgement: null,
    entries: [],
    gaps: [],
    dayBreaks: [],
    ...over,
  };
}

describe("isChecksRangeAllowed", () => {
  it("accepts a calendar month", () => {
    expect(isChecksRangeAllowed("2026-03-01", "2026-03-31")).toBe(true);
    expect(isChecksRangeAllowed("2026-03-10", "2026-03-10")).toBe(true);
  });

  it("rejects more than 62 days and an inverted range", () => {
    expect(isChecksRangeAllowed("2026-03-01", "2026-05-03")).toBe(false); // 64 days
    expect(isChecksRangeAllowed("2026-03-31", "2026-03-01")).toBe(false);
    expect(isChecksRangeAllowed("garbage", "2026-03-01")).toBe(false);
  });

  it("accepts exactly 62 inclusive days and rejects 63", () => {
    expect(isChecksRangeAllowed("2026-03-01", "2026-05-01")).toBe(true); // 62 days
    expect(isChecksRangeAllowed("2026-03-01", "2026-05-02")).toBe(false); // 63 days
  });
});

describe("dayCheckBadge", () => {
  it("marks an open cross-salon shortfall as yellow 'Pause fehlt'", () => {
    expect(dayCheckBadge(check())).toEqual({
      cls: "badge-yellow",
      label: "Salonübergreifend: Pause fehlt",
    });
  });

  it("marks an acknowledged cross-salon day as gray 'quittiert'", () => {
    expect(dayCheckBadge(check({ acknowledged: true }))).toEqual({
      cls: "badge-gray",
      label: "Salonübergreifend: quittiert",
    });
  });

  it("returns null without a cross-salon finding", () => {
    expect(dayCheckBadge(check({ crossSalon: false }))).toBeNull();
    expect(dayCheckBadge(check({ breakShortfall: false }))).toBeNull();
  });
});

describe("dayCheckWarnings", () => {
  it("maps a 30 minute shortfall to one BREAK_TOO_SHORT warning naming the numbers", () => {
    const w = dayCheckWarnings(check({ totalBreakMinutes: 10 }));
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe("BREAK_TOO_SHORT");
    expect(w[0].severity).toBe("warning");
    expect(w[0].message).toContain("§ 4 ArbZG");
    expect(w[0].message).toContain("salonübergreifend");
    expect(w[0].message).toContain("8,0 h");
    expect(w[0].message).toContain("10 Min");
    expect(w[0].message).toContain("30 Min");
  });

  it("maps a 45 minute shortfall to an error unless the day is acknowledged", () => {
    const open = dayCheckWarnings(check({ netWorkedMinutes: 600, requiredBreakMinutes: 45 }));
    expect(open[0].severity).toBe("error");
    const acked = dayCheckWarnings(
      check({ netWorkedMinutes: 600, requiredBreakMinutes: 45, acknowledged: true }),
    );
    expect(acked[0].severity).toBe("warning");
    expect(acked[0].message).toContain("quittiert");
  });

  it("omits the 'salonübergreifend' wording on a single-salon day", () => {
    const w = dayCheckWarnings(check({ crossSalon: false }));
    expect(w[0].message).not.toContain("salonübergreifend");
  });

  it("maps maxDailyExceeded to an error with the day total, even when acknowledged", () => {
    const w = dayCheckWarnings(
      check({
        breakShortfall: false,
        maxDailyExceeded: true,
        netWorkedMinutes: 660,
        acknowledged: true,
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe("MAX_DAILY_EXCEEDED");
    expect(w[0].severity).toBe("error");
    expect(w[0].message).toContain("11,0 h");
  });

  it("returns no warnings for a day without a finding", () => {
    expect(dayCheckWarnings(check({ breakShortfall: false }))).toEqual([]);
  });
});

describe("mergeDayChecksIntoArbzgMap", () => {
  const clientWarning: DayWarning = { code: "§ 4", severity: "warning", message: "client" };

  it("replaces the client warnings of a server day and removes the date on an empty result", () => {
    const client = new Map<string, DayWarning[]>([
      ["2026-03-10", [clientWarning]],
      ["2026-03-11", [clientWarning]],
      ["2026-03-12", [clientWarning]],
    ]);
    const merged = mergeDayChecksIntoArbzgMap(client, [
      check({ date: "2026-03-10" }),
      check({ date: "2026-03-11", breakShortfall: false }),
    ]);
    expect(merged.get("2026-03-10")?.[0].code).toBe("BREAK_TOO_SHORT");
    expect(merged.has("2026-03-11")).toBe(false);
    expect(merged.get("2026-03-12")).toEqual([clientWarning]);
  });

  it("adds a date the client map did not have and does not mutate the input", () => {
    const client = new Map<string, DayWarning[]>();
    const merged = mergeDayChecksIntoArbzgMap(client, [check({ date: "2026-03-10" })]);
    expect(merged.has("2026-03-10")).toBe(true);
    expect(client.size).toBe(0);
  });
});

describe("crossSalonSaveNotice", () => {
  it("names § 4 ArbZG, 'salonübergreifend' and that travel time is no break", () => {
    const text = crossSalonSaveNotice([
      { code: "BREAK_TOO_SHORT", severity: "warning", message: "x", crossSalon: true },
    ]);
    expect(text).toContain("§ 4 ArbZG");
    expect(text).toContain("salonübergreifend");
    expect(text).toContain("Fahrzeit");
    expect(text).toContain("keine Pause");
  });

  it("is pronoun-free because employees AND managers (team page) read it", () => {
    const texts = [
      crossSalonSaveNotice([
        { code: "BREAK_TOO_SHORT", severity: "warning", message: "x", crossSalon: true },
        { code: "MAX_DAILY_EXCEEDED", severity: "error", message: "x", crossSalon: true },
      ]),
    ];
    for (const text of texts) {
      expect(text).not.toBeNull();
      expect(text).not.toMatch(/\b(du|dir|dich|dein\w*|Sie|Ihnen?|Ihr\w*)\b/);
    }
    expect(texts[0]).toContain(
      "eine tatsächlich genommene Pause kann für den Tag eingetragen werden.",
    );
  });

  it("names the 10-hour limit over the day sum for a cross-salon MAX_DAILY_EXCEEDED", () => {
    const text = crossSalonSaveNotice([
      { code: "MAX_DAILY_EXCEEDED", severity: "error", message: "x", crossSalon: true },
    ]);
    expect(text).toContain("10-Stunden-Grenze");
    expect(text).toContain("Tagessumme");
  });

  it("returns null without a cross-salon warning, for empty, undefined and malformed input", () => {
    expect(
      crossSalonSaveNotice([{ code: "BREAK_TOO_SHORT", severity: "warning", message: "x" }]),
    ).toBeNull();
    expect(crossSalonSaveNotice([])).toBeNull();
    expect(crossSalonSaveNotice(undefined)).toBeNull();
    expect(crossSalonSaveNotice("nope")).toBeNull();
    expect(crossSalonSaveNotice([null, 3, { code: 7 }])).toBeNull();
  });
});

describe("crossSalonMonthCloseHint", () => {
  it("labels one day with the count and names § 4 ArbZG and the date as DD.MM.", () => {
    const hint = crossSalonMonthCloseHint(["2026-03-10"]);
    expect(hint?.label).toBe("Pause fehlt (salonübergreifend) (1)");
    expect(hint?.title).toContain("§ 4 ArbZG");
    expect(hint?.title).toContain("10.03.");
    expect(hint?.title).toContain("quittieren");
  });

  it("counts every day and lists the first three dates, then the remainder", () => {
    const hint = crossSalonMonthCloseHint([
      "2026-03-02",
      "2026-03-10",
      "2026-03-11",
      "2026-03-20",
      "2026-03-25",
    ]);
    expect(hint?.label).toBe("Pause fehlt (salonübergreifend) (5)");
    expect(hint?.title).toContain("02.03., 10.03., 11.03.");
    expect(hint?.title).toContain("+2");
    expect(hint?.title).not.toContain("20.03.");
  });

  it("returns null for no days, undefined and null", () => {
    expect(crossSalonMonthCloseHint([])).toBeNull();
    expect(crossSalonMonthCloseHint(undefined)).toBeNull();
    expect(crossSalonMonthCloseHint(null as unknown as undefined)).toBeNull();
  });

  it("ignores a malformed date instead of printing it", () => {
    const hint = crossSalonMonthCloseHint(["nonsense", "2026-03-10"]);
    expect(hint?.label).toBe("Pause fehlt (salonübergreifend) (1)");
    expect(hint?.title).toContain("10.03.");
    expect(hint?.title).not.toContain("nonsense");
  });
});
