// Issue #80 (D-09/D-11/D-20) + Issue #511 (D-10/D-12/D-18) — the presentation helpers for the
// server-computed day check. The browser computes no § 4 / § 11 finding itself, so these tests pin
// the mapping from the API's DayCheck (its `warnings`, `breakFinding`) to badge, calendar markers,
// toast and month-close chip. The former client-built § 4 message expectations are gone on
// purpose: D-18 makes the server's message the only message.

import { describe, it, expect } from "vitest";
import {
  type DayCheck,
  type FullDayCheck,
  type WithheldDayCheck,
  hasPlacementFinding,
  isChecksRangeAllowed,
  dayCheckBadge,
  type DayCheckWarning,
  dayCheckWarnings,
  dayChecksToArbzgMap,
  breakFindingSaveNotice,
  breakFindingMonthCloseHint,
} from "../day-break-violation";

function serverWarning(over: Partial<DayCheckWarning> = {}): DayCheckWarning {
  return {
    code: "BREAK_TOO_SHORT",
    severity: "warning",
    message: "SERVER-TEXT § 4 ArbZG",
    ...over,
  };
}

function check(over: Partial<FullDayCheck> = {}): FullDayCheck {
  return {
    date: "2026-03-10",
    detail: "full",
    crossSalon: true,
    netWorkedMinutes: 480,
    totalBreakMinutes: 0,
    requiredBreakMinutes: 30,
    breakShortfall: true,
    maxDailyExceeded: false,
    breakFinding: true,
    positionUnknown: false,
    warnings: [serverWarning({ crossSalon: true })],
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

/** The number-free object the API returns for a partially covered day (Issue #85 D-07). */
function withheld(over: Partial<WithheldDayCheck> = {}): WithheldDayCheck {
  return {
    date: "2026-03-10",
    detail: "redacted",
    crossSalon: true,
    netWorkedMinutes: null,
    totalBreakMinutes: null,
    requiredBreakMinutes: null,
    breakShortfall: null,
    maxDailyExceeded: null,
    breakFinding: null,
    positionUnknown: null,
    warnings: [
      {
        code: "FINDING_WITHHELD",
        severity: "warning",
        message:
          "Für diesen Tag liegt ein Prüfhinweis vor; die Klärung erfolgt über den Stammsalon.",
        hint: true,
      },
    ],
    acknowledged: null,
    locked: false,
    mayAcknowledge: false,
    mayRecordDayBreak: false,
    acknowledgement: null,
    entries: null,
    gaps: null,
    dayBreaks: null,
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
  it("marks an open cross-salon shortfall as yellow 'Pause fehlt' (#80 label unchanged)", () => {
    expect(dayCheckBadge(check())).toEqual({
      cls: "badge-yellow",
      label: "Salonübergreifend: Pause fehlt",
    });
  });

  it("marks an acknowledged cross-salon day as gray 'quittiert' (#80 label unchanged)", () => {
    expect(dayCheckBadge(check({ acknowledged: true }))).toEqual({
      cls: "badge-gray",
      label: "Salonübergreifend: quittiert",
    });
  });

  it("returns null without a break finding", () => {
    expect(dayCheckBadge(check({ breakFinding: false }))).toBeNull();
    expect(
      dayCheckBadge(check({ crossSalon: false, breakShortfall: false, breakFinding: false })),
    ).toBeNull();
  });

  it("marks a single-salon placement finding as yellow 'Pausenregel verletzt'", () => {
    const single = check({
      crossSalon: false,
      breakShortfall: false,
      warnings: [
        serverWarning({ code: "BREAK_TOO_LATE", certainty: "VIOLATION", legalBasis: "§ 4 ArbZG" }),
      ],
    });
    expect(dayCheckBadge(single)).toEqual({ cls: "badge-yellow", label: "Pausenregel verletzt" });
  });

  it("marks an acknowledged single-salon finding as gray 'Pausenverstoß: quittiert'", () => {
    const single = check({
      crossSalon: false,
      breakShortfall: false,
      acknowledged: true,
      warnings: [serverWarning({ code: "BREAK_TOO_LATE", certainty: "VIOLATION" })],
    });
    expect(dayCheckBadge(single)).toEqual({
      cls: "badge-gray",
      label: "Pausenverstoß: quittiert",
    });
  });

  it("asks for clarification when a finding is UNCLEAR and the day is not acknowledged", () => {
    const unclear = check({
      crossSalon: false,
      breakShortfall: false,
      warnings: [serverWarning({ code: "BREAK_SEGMENT_TOO_SHORT", certainty: "UNCLEAR" })],
    });
    expect(dayCheckBadge(unclear)).toEqual({
      cls: "badge-yellow",
      label: "Pause: Klärung nötig",
    });
    // Once acknowledged the quiet marker wins: the decision is documented.
    expect(dayCheckBadge({ ...unclear, acknowledged: true })?.cls).toBe("badge-gray");
  });
});

describe("dayCheckWarnings", () => {
  it("passes the server warnings through, in server order, without hints", () => {
    const w = dayCheckWarnings(
      check({
        warnings: [
          serverWarning({ code: "MAX_DAILY_EXCEEDED", severity: "error", message: "A" }),
          serverWarning({ code: "BREAK_POSITION_UNKNOWN", message: "H", hint: true }),
          serverWarning({ code: "BREAK_TOO_LATE", message: "B", certainty: "VIOLATION" }),
        ],
      }),
    );
    expect(w).toEqual([
      { code: "MAX_DAILY_EXCEEDED", severity: "error", message: "A" },
      { code: "BREAK_TOO_LATE", severity: "warning", message: "B" },
    ]);
  });

  it("composes no text of its own: the message is the server's message, whatever the totals say", () => {
    const w = dayCheckWarnings(check({ netWorkedMinutes: 9999, requiredBreakMinutes: 45 }));
    expect(w).toHaveLength(1);
    expect(w[0].message).toBe("SERVER-TEXT § 4 ArbZG");
    expect(w[0].severity).toBe("warning");
  });

  it("returns [] for a day without warnings and for a stale API without the field", () => {
    expect(dayCheckWarnings(check({ warnings: [] }))).toEqual([]);
    const stale = check() as unknown as Record<string, unknown>;
    delete stale.warnings;
    expect(dayCheckWarnings(stale as unknown as DayCheck)).toEqual([]);
  });
});

describe("dayChecksToArbzgMap", () => {
  it("maps date to the server warnings and leaves out hint-only and warning-free days", () => {
    const map = dayChecksToArbzgMap([
      check({ date: "2026-03-10" }),
      check({
        date: "2026-03-11",
        warnings: [serverWarning({ code: "BREAK_POSITION_UNKNOWN", hint: true })],
      }),
      check({ date: "2026-03-12", warnings: [] }),
    ]);
    expect([...map.keys()]).toEqual(["2026-03-10"]);
    expect(map.get("2026-03-10")?.[0]).toEqual({
      code: "BREAK_TOO_SHORT",
      severity: "warning",
      message: "SERVER-TEXT § 4 ArbZG",
    });
  });
});

const PRONOUN = /\b(du|dir|dich|dein\w*|Sie|Ihnen?|Ihr\w*)\b/;

describe("breakFindingSaveNotice", () => {
  it("names § 4 ArbZG, 'salonübergreifend' and that travel time is no break (#80 text)", () => {
    const text = breakFindingSaveNotice([
      { code: "BREAK_TOO_SHORT", severity: "warning", message: "x", crossSalon: true },
    ]);
    expect(text).toContain("§ 4 ArbZG");
    expect(text).toContain("salonübergreifend");
    expect(text).toContain("Fahrzeit");
    expect(text).toContain("keine Pause");
  });

  it("is pronoun-free because employees AND managers (team page) read it", () => {
    const texts = [
      breakFindingSaveNotice([
        { code: "BREAK_TOO_SHORT", severity: "warning", message: "x", crossSalon: true },
        { code: "MAX_DAILY_EXCEEDED", severity: "error", message: "x", crossSalon: true },
      ]),
      breakFindingSaveNotice([
        { code: "BREAK_TOO_LATE", severity: "warning", message: "Pause fehlt am Stück." },
      ]),
    ];
    for (const text of texts) {
      expect(text).not.toBeNull();
      expect(text).not.toMatch(PRONOUN);
    }
    expect(texts[0]).toContain(
      "eine tatsächlich genommene Pause kann für den Tag eingetragen werden.",
    );
  });

  it("names the 10-hour limit over the day sum for a cross-salon MAX_DAILY_EXCEEDED", () => {
    const text = breakFindingSaveNotice([
      { code: "MAX_DAILY_EXCEEDED", severity: "error", message: "x", crossSalon: true },
    ]);
    expect(text).toBe(
      "Gespeichert. Die salonübergreifende Tagessumme überschreitet die 10-Stunden-Grenze " +
        "(§ 3 ArbZG).",
    );
  });

  it("quotes the server message of a placement finding behind 'Gespeichert.'", () => {
    const text = breakFindingSaveNotice([
      {
        code: "BREAK_TOO_LATE",
        severity: "warning",
        message: "§ 4 Satz 3 ArbZG: 6:10 Std. am Stück ohne Ruhepause von mindestens 15 Min.",
      },
    ]);
    expect(text).toBe(
      "Gespeichert. Pausenregel nicht eingehalten: " +
        "§ 4 Satz 3 ArbZG: 6:10 Std. am Stück ohne Ruhepause von mindestens 15 Min.",
    );
  });

  it("handles all three placement codes and joins several messages with a space", () => {
    for (const code of ["BREAK_SEGMENT_TOO_SHORT", "BREAK_TOO_LATE", "BREAK_OUTSIDE_WINDOW"]) {
      expect(breakFindingSaveNotice([{ code, severity: "warning", message: "m" }])).toContain(
        "Pausenregel nicht eingehalten: m",
      );
    }
    const both = breakFindingSaveNotice([
      { code: "BREAK_SEGMENT_TOO_SHORT", severity: "warning", message: "m1" },
      { code: "BREAK_OUTSIDE_WINDOW", severity: "warning", message: "m2" },
    ]);
    expect(both).toBe("Gespeichert. Pausenregel nicht eingehalten: m1 m2");
  });

  it("appends the placement part to the cross-salon text without a second 'Gespeichert.'", () => {
    const text = breakFindingSaveNotice([
      { code: "BREAK_TOO_SHORT", severity: "warning", message: "x", crossSalon: true },
      { code: "BREAK_TOO_LATE", severity: "warning", message: "Spät." },
    ]) as string;
    expect(text.startsWith("Gespeichert. Über beide Salons gerechnet")).toBe(true);
    expect(text.endsWith(" Pausenregel nicht eingehalten: Spät.")).toBe(true);
    expect(text.match(/Gespeichert\./g)).toHaveLength(1);
  });

  it("shows nothing for a hint alone, even one carrying a placement code", () => {
    expect(
      breakFindingSaveNotice([
        { code: "BREAK_POSITION_UNKNOWN", severity: "warning", message: "h", hint: true },
        { code: "BREAK_TOO_LATE", severity: "warning", message: "h2", hint: true },
      ]),
    ).toBeNull();
  });

  it("returns null without a cross-salon or placement warning, for empty, undefined and malformed input", () => {
    expect(
      breakFindingSaveNotice([{ code: "BREAK_TOO_SHORT", severity: "warning", message: "x" }]),
    ).toBeNull();
    expect(breakFindingSaveNotice([])).toBeNull();
    expect(breakFindingSaveNotice(undefined)).toBeNull();
    expect(breakFindingSaveNotice("nope")).toBeNull();
    expect(breakFindingSaveNotice([null, 3, { code: 7 }])).toBeNull();
    // A placement warning without a usable message cannot be quoted.
    expect(breakFindingSaveNotice([{ code: "BREAK_TOO_LATE", message: 5 }])).toBeNull();
  });
});

describe("breakFindingMonthCloseHint", () => {
  it("labels one day with the count and names the statutes and the date as DD.MM.", () => {
    const hint = breakFindingMonthCloseHint(["2026-03-10"]);
    expect(hint?.label).toBe("Pausenverstoß offen (1)");
    expect(hint?.title).toBe(
      "Offener Pausenverstoß (§ 4 ArbZG / § 11 JArbSchG) an: 10.03.; " +
        "vor dem Abschluss eine Pause erfassen oder den Tag quittieren.",
    );
    expect(hint?.title).not.toMatch(PRONOUN);
  });

  it("counts every day and lists the first three dates, then the remainder", () => {
    const hint = breakFindingMonthCloseHint([
      "2026-03-02",
      "2026-03-10",
      "2026-03-11",
      "2026-03-20",
      "2026-03-25",
    ]);
    expect(hint?.label).toBe("Pausenverstoß offen (5)");
    expect(hint?.title).toContain("02.03., 10.03., 11.03.");
    expect(hint?.title).toContain("+2");
    expect(hint?.title).not.toContain("20.03.");
  });

  it("returns null for no days, undefined and null", () => {
    expect(breakFindingMonthCloseHint([])).toBeNull();
    expect(breakFindingMonthCloseHint(undefined)).toBeNull();
    expect(breakFindingMonthCloseHint(null as unknown as undefined)).toBeNull();
  });

  it("ignores a malformed date instead of printing it", () => {
    const hint = breakFindingMonthCloseHint(["nonsense", "2026-03-10"]);
    expect(hint?.label).toBe("Pausenverstoß offen (1)");
    expect(hint?.title).toContain("10.03.");
    expect(hint?.title).not.toContain("nonsense");
  });
});

// Issue #85 D-07: a withheld day is a neutral hint, never a marker, badge or placement finding.
describe("a withheld (redacted) day", () => {
  it("never becomes a calendar marker", () => {
    const days: DayCheck[] = [withheld(), check({ date: "2026-03-11" })];
    const map = dayChecksToArbzgMap(days);
    expect(map.has("2026-03-10")).toBe(false);
    expect(map.has("2026-03-11")).toBe(true);
    expect(dayChecksToArbzgMap([withheld()]).size).toBe(0);
    expect(dayCheckWarnings(withheld())).toEqual([]);
  });

  it("never gets a badge", () => {
    expect(dayCheckBadge(withheld())).toBeNull();
    expect(dayCheckBadge(withheld({ crossSalon: false }))).toBeNull();
  });

  it("carries no placement finding", () => {
    expect(hasPlacementFinding(withheld())).toBe(false);
  });

  it("gives no save notice for the withheld hint", () => {
    expect(breakFindingSaveNotice(withheld().warnings)).toBeNull();
  });
});
