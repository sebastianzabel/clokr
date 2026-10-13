// Issue #80 (D-11) / #511 (D-13) — the pure manager-notification texts of the next-day break-finding job.
// DB-free. The redacted variant must hold no salon name and no clock time by construction, even
// when a caller passes the entries by mistake (T-80-37).
//
// Amendment 2026-10-13 (Phase 85b, Issue #85 D-07): the redacted level no longer carries the day
// sum ("insgesamt 8 h ohne 30 Min Pause, salonübergreifend"). It is the neutral notice of
// `buildWithheldNotice` (no figure, no category, only the calendar date); the redacted cases below
// were rewritten accordingly. The full-level expectations are untouched.

import { describe, it, expect } from "vitest";
import {
  buildCrossSalonNotice,
  CROSS_SALON_NOTICE_TITLE,
  buildBreakPlacementNotice,
  buildWithheldNotice,
  BREAK_PLACEMENT_NOTICE_TITLE,
} from "../break-finding-notice";
import { evaluateDayBreaks } from "../day-break-rule";

const CLOCK_TIME = /\d{1,2}:\d{2}/;

const ENTRIES = [
  { salonName: "Salon Alpha", startLocal: "08:00", endLocal: "12:00" },
  { salonName: "Salon Beta", startLocal: "12:30", endLocal: "16:30" },
];

function evaluation(netWorkedMin: number, totalBreakMin: number, requiredBreakMin: 30 | 45) {
  return { netWorkedMin, totalBreakMin, requiredBreakMin };
}

const NEUTRAL_TITLE = "Prüfhinweis zu einem Arbeitstag";
const NEUTRAL_MESSAGE =
  "Fixture Alpha, 10.03.2026: Für diesen Tag liegt ein Prüfhinweis vor; die Klärung erfolgt über den Stammsalon.";

/** The title and message with the calendar date removed: nothing numeric may be left. */
function withoutDate(text: string): string {
  return text.replace("10.03.2026", "");
}

describe("buildWithheldNotice (Issue #85 D-07)", () => {
  it("builds the exact neutral title and message", () => {
    expect(buildWithheldNotice({ employeeName: "Probe Test", date: "2026-03-10" })).toEqual({
      title: "Prüfhinweis zu einem Arbeitstag",
      message:
        "Probe Test, 10.03.2026: Für diesen Tag liegt ein Prüfhinweis vor; die Klärung erfolgt über den Stammsalon.",
    });
  });

  it("holds no figure, paragraph or finding wording apart from the date", () => {
    const { title, message } = buildWithheldNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
    });
    for (const text of [title, withoutDate(message)]) {
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain("§");
      expect(text).not.toContain(" h");
      expect(text).not.toContain("Min");
      expect(text).not.toContain("Pause");
    }
  });
});

describe("buildCrossSalonNotice", () => {
  for (const [label, evalIn] of [
    ["an 8 h day without any break", evaluation(480, 0, 30)],
    ["a day with a short break", evaluation(480, 15, 30)],
    ["a 9.5 h day with the 45 minute requirement", evaluation(570, 0, 45)],
  ] as const) {
    it(`returns the neutral notice for redacted detail: ${label}`, () => {
      const { title, message } = buildCrossSalonNotice({
        employeeName: "Fixture Alpha",
        date: "2026-03-10",
        evaluation: evalIn,
        detail: "redacted",
      });

      expect(title).toBe(NEUTRAL_TITLE);
      expect(message).toBe(NEUTRAL_MESSAGE);
      expect(withoutDate(message)).not.toMatch(/\d/);
      expect(message).not.toContain("§");
      expect(message).not.toContain(" h ");
      expect(message).not.toContain("Min");
      expect(message).not.toContain("Pause");
    });
  }

  it("deep-equals buildWithheldNotice for redacted detail, with and without entries", () => {
    const neutral = buildWithheldNotice({ employeeName: "Fixture Alpha", date: "2026-03-10" });
    const base = {
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(480, 0, 30 as const),
      detail: "redacted" as const,
    };

    expect(buildCrossSalonNotice(base)).toEqual(neutral);
    expect(buildCrossSalonNotice({ ...base, entries: ENTRIES })).toEqual(neutral);
  });

  it("never lets a salon name or a clock time into the redacted text, even if entries are passed", () => {
    const { title, message } = buildCrossSalonNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(480, 0, 30),
      detail: "redacted",
      entries: ENTRIES,
    });

    for (const text of [title, message]) {
      expect(text).not.toMatch(CLOCK_TIME);
      expect(text).not.toContain("Salon Alpha");
      expect(text).not.toContain("Salon Beta");
    }
  });

  it("appends the salons and the times in the full variant", () => {
    const { message } = buildCrossSalonNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(480, 0, 30),
      detail: "full",
      entries: ENTRIES,
    });

    expect(message).toBe(
      "Fixture Alpha: Am 10.03.2026 insgesamt 8 h ohne 30 Min Pause, salonübergreifend " +
        "(Salon Alpha 08:00–12:00, Salon Beta 12:30–16:30).",
    );
  });

  it("keeps the sentence without the parenthesis when the full variant has no entries to show", () => {
    const { message } = buildCrossSalonNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(480, 0, 30),
      detail: "full",
    });

    expect(message).toBe(
      "Fixture Alpha: Am 10.03.2026 insgesamt 8 h ohne 30 Min Pause, salonübergreifend.",
    );
  });

  it("uses the cross-salon title for full and the neutral withheld title for redacted", () => {
    const base = {
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(480, 0, 30 as const),
    };
    const full = buildCrossSalonNotice({ ...base, detail: "full", entries: ENTRIES });
    const redacted = buildCrossSalonNotice({ ...base, detail: "redacted" });

    expect(full.title).toBe(CROSS_SALON_NOTICE_TITLE);
    expect(redacted.title).toBe(NEUTRAL_TITLE);
    expect(CROSS_SALON_NOTICE_TITLE).not.toMatch(CLOCK_TIME);
  });

  it("accepts the evaluation the day-break kernel produces", () => {
    const evaluated = evaluateDayBreaks({
      rows: [
        {
          id: "r1",
          startTime: new Date("2026-03-10T07:00:00Z"),
          endTime: new Date("2026-03-10T11:00:00Z"),
          breakMinutes: 0,
          salonId: "salon-a",
        },
        {
          id: "r2",
          startTime: new Date("2026-03-10T11:30:00Z"),
          endTime: new Date("2026-03-10T15:30:00Z"),
          breakMinutes: 0,
          salonId: "salon-b",
        },
      ],
      dayBreaks: [],
      acks: [],
    });

    const { message } = buildCrossSalonNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluated,
      detail: "full",
      entries: ENTRIES,
    });

    expect(message).toBe(
      "Fixture Alpha: Am 10.03.2026 insgesamt 8 h ohne 30 Min Pause, salonübergreifend " +
        "(Salon Alpha 08:00–12:00, Salon Beta 12:30–16:30).",
    );
  });
});

describe("buildBreakPlacementNotice (Issue #511, D-13)", () => {
  it("joins the finding messages behind the employee and the German date", () => {
    const { title, message } = buildBreakPlacementNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      findingMessages: ["§ 4 Satz 3 ArbZG: Erste Meldung.", "§ 4 Satz 2 ArbZG: Zweite Meldung."],
    });

    expect(title).toBe(BREAK_PLACEMENT_NOTICE_TITLE);
    expect(message).toBe(
      "Fixture Alpha: Am 10.03.2026 § 4 Satz 3 ArbZG: Erste Meldung. § 4 Satz 2 ArbZG: Zweite Meldung.",
    );
  });

  it("uses a neutral title that differs from the cross-salon one and holds no clock time", () => {
    expect(BREAK_PLACEMENT_NOTICE_TITLE).toBe("Pausenverstoß (Pausenlage)");
    expect(BREAK_PLACEMENT_NOTICE_TITLE).not.toBe(CROSS_SALON_NOTICE_TITLE);
    expect(BREAK_PLACEMENT_NOTICE_TITLE).not.toMatch(CLOCK_TIME);
  });

  it("adds no time of its own: a redacted finding text stays free of clock times", () => {
    const { message } = buildBreakPlacementNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      findingMessages: ["§ 4 Satz 3 ArbZG: 6 Std. 30 Min am Stück ohne Ruhepause."],
    });

    expect(message).not.toMatch(CLOCK_TIME);
  });
});
