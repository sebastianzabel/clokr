// Issue #80 (D-11) — the pure manager-notification text of the next-day cross-salon § 4 job.
// DB-free. The redacted variant must hold no salon name and no clock time by construction, even
// when a caller passes the entries by mistake (T-80-37).

import { describe, it, expect } from "vitest";
import { buildCrossSalonNotice, CROSS_SALON_NOTICE_TITLE } from "../cross-salon-notice";
import { evaluateDayBreaks } from "../day-break-rule";

const CLOCK_TIME = /\d{1,2}:\d{2}/;

const ENTRIES = [
  { salonName: "Salon Alpha", startLocal: "08:00", endLocal: "12:00" },
  { salonName: "Salon Beta", startLocal: "12:30", endLocal: "16:30" },
];

function evaluation(netWorkedMin: number, totalBreakMin: number, requiredBreakMin: 30 | 45) {
  return { netWorkedMin, totalBreakMin, requiredBreakMin };
}

describe("buildCrossSalonNotice", () => {
  it("builds the exact redacted sentence for an 8 h day without any break", () => {
    const { message } = buildCrossSalonNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(480, 0, 30),
      detail: "redacted",
    });

    expect(message).toBe(
      "Fixture Alpha: Am 10.03.2026 insgesamt 8 h ohne 30 Min Pause, salonübergreifend.",
    );
  });

  it("names the recorded break against the required one when some break exists", () => {
    const { message } = buildCrossSalonNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(480, 15, 30),
      detail: "redacted",
    });

    expect(message).toBe(
      "Fixture Alpha: Am 10.03.2026 insgesamt 8 h mit 15 statt 30 Min Pause, salonübergreifend.",
    );
  });

  it("formats a 9.5 h day with a decimal comma and the 45 minute requirement", () => {
    const { message } = buildCrossSalonNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(570, 0, 45),
      detail: "redacted",
    });

    expect(message).toContain("insgesamt 9,5 h");
    expect(message).toContain("ohne 45 Min Pause");
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

  it("falls back to the redacted text when the full variant has no entries to show", () => {
    const { message } = buildCrossSalonNotice({
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(480, 0, 30),
      detail: "full",
    });

    expect(message.endsWith("salonübergreifend.")).toBe(true);
  });

  it("uses one neutral title for both variants", () => {
    const base = {
      employeeName: "Fixture Alpha",
      date: "2026-03-10",
      evaluation: evaluation(480, 0, 30 as const),
    };
    const full = buildCrossSalonNotice({ ...base, detail: "full", entries: ENTRIES });
    const redacted = buildCrossSalonNotice({ ...base, detail: "redacted" });

    expect(full.title).toBe(CROSS_SALON_NOTICE_TITLE);
    expect(redacted.title).toBe(CROSS_SALON_NOTICE_TITLE);
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
      detail: "redacted",
    });

    expect(message).toBe(
      "Fixture Alpha: Am 10.03.2026 insgesamt 8 h ohne 30 Min Pause, salonübergreifend.",
    );
  });
});
