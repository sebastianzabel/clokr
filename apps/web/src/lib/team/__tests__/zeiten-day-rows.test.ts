// Issue #853 (owner review of Team › Zeiten): one row per day, the prototype's columns, no raw
// break intervals, no emoji, no „---“.
import { describe, expect, it } from "vitest";
import { pauseLabel, teamDayRows, weekdayDateLabel, type DayRowEntry } from "../zeiten-day-rows";

const PAST = { expectedMin: 480, isToday: false, isFuture: false };
const TODAY = { expectedMin: 480, isToday: true, isFuture: false };

function entry(p: Partial<DayRowEntry> & { startTime: string }): DayRowEntry {
  return { id: p.startTime, endTime: null, breakMinutes: 0, salonLabel: "Nord", ...p };
}

function rows(entries: DayRowEntry[], opts: { sollVisible?: boolean; today?: string } = {}) {
  return teamDayRows({
    entries,
    vocationalSchoolDays: [],
    dayInfo: (day) => (day === opts.today ? TODAY : PAST),
    sollVisible: opts.sollVisible ?? true,
    findingDays: new Set(),
  });
}

describe("teamDayRows", () => {
  it("one row per day with the prototype's columns and a positive difference chip", () => {
    const [row] = rows([
      entry({
        id: "a",
        startTime: "2026-11-06T09:30:00",
        endTime: "2026-11-06T20:10:00",
        breakMinutes: 45,
      }),
    ]);
    expect(row).toMatchObject({
      day: "2026-11-06",
      dayLabel: "Fr 6.11.",
      salon: "Nord",
      times: "09:30–20:10",
      pause: "0:45",
      net: "9:55",
      soll: "8:00",
      diff: { label: "+1:55", tone: "ok" },
      state: null,
    });
  });

  it("several entries of a day are one row: times joined, minutes summed, salons once", () => {
    const [row] = rows([
      entry({
        id: "b",
        startTime: "2026-11-05T13:00:00",
        endTime: "2026-11-05T17:00:00",
        salonLabel: "Süd",
      }),
      entry({ id: "a", startTime: "2026-11-05T08:00:00", endTime: "2026-11-05T12:00:00" }),
    ]);
    expect(row.times).toBe("08:00–12:00, 13:00–17:00");
    expect(row.salon).toBe("Nord, Süd");
    expect(row.net).toBe("8:00");
    expect(row.diff).toEqual({ label: "±0:00", tone: "neutral" });
    expect(row.entryIds).toEqual(["a", "b"]);
  });

  it("a running entry is quiet: start time, stored break as H:MM, no difference", () => {
    const [row] = rows(
      [
        entry({
          id: "r",
          startTime: "2026-11-09T00:27:00",
          // a running entry's stored minutes are not final and never shown
          breakMinutes: 932,
        }),
      ],
      { today: "2026-11-09" },
    );
    expect(row.times).toBe("ab 00:27");
    expect(row.pause).toBe("–");
    expect(row.net).toBe("–");
    expect(row.diff).toBeNull();
    expect(row.state).toEqual({ label: "läuft", tone: "neutral" });
  });

  it("a running entry of an earlier day says it was never clocked out", () => {
    const [row] = rows([entry({ id: "r", startTime: "2026-11-09T00:27:00", isInvalid: true })]);
    expect(row.state).toEqual({ label: "nicht ausgestempelt", tone: "warn" });
  });

  it("never prints break intervals: two break rows are their stored sum", () => {
    expect(
      pauseLabel([
        entry({
          startTime: "2026-11-09T08:00:00",
          endTime: "2026-11-09T17:00:00",
          breakMinutes: 75,
        }),
      ]),
    ).toBe("1:15");
    expect(
      pauseLabel([
        entry({ startTime: "2026-11-09T08:00:00", breakStartedAt: "2026-11-09T12:00:00" }),
      ]),
    ).toBe("läuft");
  });

  it("without a visible Soll there is no Soll and no difference", () => {
    const [row] = rows(
      [entry({ startTime: "2026-11-06T09:00:00", endTime: "2026-11-06T17:00:00" })],
      { sollVisible: false },
    );
    expect(row.soll).toBeNull();
    expect(row.diff).toBeNull();
  });

  it("an invalid closed entry is not counted and marks the day", () => {
    const [row] = rows([
      entry({ startTime: "2026-11-04T09:00:00", endTime: "2026-11-04T17:00:00", isInvalid: true }),
    ]);
    expect(row.net).toBe("–");
    expect(row.state).toEqual({ label: "ungültig", tone: "warn" });
  });

  it("days are newest first, and no value is „---“ or an emoji", () => {
    const list = teamDayRows({
      entries: [
        entry({ startTime: "2026-11-03T09:00:00", endTime: "2026-11-03T17:00:00" }),
        entry({ startTime: "2026-11-06T09:00:00", endTime: "2026-11-06T17:00:00" }),
      ],
      vocationalSchoolDays: ["2026-11-04"],
      dayInfo: () => PAST,
      sollVisible: true,
      findingDays: new Set(["2026-11-06"]),
    });
    expect(list.map((r) => r.day)).toEqual(["2026-11-06", "2026-11-04", "2026-11-03"]);
    expect(list[0].finding).toBe(true);
    expect(list[1]).toMatchObject({ vocationalSchool: true, times: "Berufsschule", diff: null });
    const text = JSON.stringify(list);
    expect(text).not.toContain("---");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("weekday labels are German two-letter days", () => {
    expect(weekdayDateLabel("2026-11-09")).toBe("Mo 9.11.");
  });
});
