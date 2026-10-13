// Issue #511 (D-02, D-07, D-10) — placementWarnings(): the one message builder for the Satz-2/3
// findings. Pure: evaluations are constructed with the real kernel from Break rows, nothing here
// touches the database. The builder renders findings; it decides nothing.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { evaluateDayBreaks } from "../day-break-rule";
import type { DayBreakRow, DayBreakInterval } from "../day-break-rule";
import { placementWarnings, dayLimitWarnings } from "../arbzg";
import { isApprenticeWithoutBirthDate } from "../break-regime";

const TZ = "Europe/Berlin";
const DAY = "2026-03-23";
const SALON_A = "salon-a";
const SALON_B = "salon-b";
const ALLOWED_KEYS = new Set([
  "code",
  "severity",
  "message",
  "certainty",
  "legalBasis",
  "hint",
  "waived",
  "crossSalon",
]);

/** Tenant-local wall clock time on DAY as an instant. */
function at(hhmm: string): Date {
  return fromZonedTime(`${DAY}T${hhmm}:00`, TZ);
}

function entry(
  id: string,
  start: string,
  end: string,
  breakMinutes: number,
  breaks?: DayBreakInterval[],
  salonId = SALON_A,
): DayBreakRow {
  return {
    id,
    startTime: at(start),
    endTime: at(end),
    breakMinutes,
    breakStatus: "CONFIRMED",
    salonId,
    breaks,
  };
}

function iv(start: string, end: string): DayBreakInterval {
  return { startTime: at(start), endTime: at(end) };
}

function evaluate(rows: DayBreakRow[]) {
  return evaluateDayBreaks({ rows, dayBreaks: [], acks: [] });
}

describe("placementWarnings (Issue #511)", () => {
  it("BREAK_TOO_LATE: a 6:01 block names duration, legal basis and the block range", () => {
    const ev = evaluate([entry("e1", "08:00", "15:00", 30, [iv("14:01", "14:31")])]);
    const out = placementWarnings(ev, { tz: TZ });
    const late = out.filter((w) => w.code === "BREAK_TOO_LATE");
    expect(late).toHaveLength(1);
    expect(late[0].severity).toBe("warning");
    expect(late[0].certainty).toBe("VIOLATION");
    expect(late[0].legalBasis).toBe("§ 4 S. 3 ArbZG");
    expect(late[0].message).toContain("6:01");
    expect(late[0].message).toContain("08:00–14:01");
    expect(late[0].message).toContain("Zulässig sind höchstens 6 Std.");
  });

  it("BREAK_TOO_LATE: absent for a block of exactly six hours", () => {
    const ev = evaluate([entry("e1", "08:00", "15:00", 30, [iv("14:00", "14:30")])]);
    const out = placementWarnings(ev, { tz: TZ });
    expect(out.some((w) => w.code === "BREAK_TOO_LATE")).toBe(false);
  });

  it("BREAK_SEGMENT_TOO_SHORT: three 10-minute breaks are named in the message (AK-1)", () => {
    const ev = evaluate([
      entry("e1", "08:00", "15:00", 30, [
        iv("10:00", "10:10"),
        iv("11:30", "11:40"),
        iv("13:00", "13:10"),
      ]),
    ]);
    const out = placementWarnings(ev, { tz: TZ });
    const short = out.filter((w) => w.code === "BREAK_SEGMENT_TOO_SHORT");
    expect(short).toHaveLength(1);
    expect(short[0].message).toContain("3 Pausen unter 15 Min nicht angerechnet");
    expect(short[0].legalBasis).toBe("§ 4 S. 2 ArbZG");
  });

  it("BREAK_SEGMENT_TOO_SHORT: singular for one segment", () => {
    // 20 + 14 = 34 stored minutes meet the sum rule, so BREAK_TOO_SHORT stays silent; neither
    // segment is a Ruhepause (one touches the start, one is under 15 minutes).
    const ev = evaluate([
      entry("e1", "08:00", "15:00", 34, [iv("08:00", "08:20"), iv("11:00", "11:14")]),
    ]);
    const short = placementWarnings(ev, { tz: TZ }).filter(
      (w) => w.code === "BREAK_SEGMENT_TOO_SHORT",
    );
    expect(short).toHaveLength(1);
    expect(short[0].message).toContain("1 Pause unter 15 Min nicht angerechnet");
  });

  it("BREAK_SEGMENT_TOO_SHORT: an edge segment is named separately", () => {
    const ev = evaluate([entry("e1", "08:00", "15:00", 30, [iv("08:00", "08:30")])]);
    const short = placementWarnings(ev, { tz: TZ }).filter(
      (w) => w.code === "BREAK_SEGMENT_TOO_SHORT",
    );
    expect(short).toHaveLength(1);
    expect(short[0].message).toContain("am Beginn oder Ende der Arbeitszeit nicht angerechnet");
  });

  it("BREAK_POSITION_UNKNOWN: carries hint true and no certainty, never a violation (AK-3)", () => {
    const ev = evaluate([entry("e1", "08:00", "15:00", 30)]);
    const out = placementWarnings(ev, { tz: TZ });
    const hint = out.filter((w) => w.code === "BREAK_POSITION_UNKNOWN");
    expect(hint).toHaveLength(1);
    expect(hint[0].hint).toBe(true);
    expect(hint[0].certainty).toBeUndefined();
    expect(hint[0].severity).toBe("warning");
    expect(out.some((w) => w.code === "BREAK_TOO_LATE")).toBe(false);
  });

  it("an UNCLEAR finding ends with the clarification request (D-07) and flags crossSalon", () => {
    // 3 h in salon A, 4 h travel gap without a record, 4 h in salon B: the gap may or may not
    // have been free, so the 11 h block is unclear.
    const ev = evaluate([
      entry("e1", "08:00", "11:00", 0, undefined, SALON_A),
      entry("e2", "15:00", "19:00", 0, undefined, SALON_B),
    ]);
    const late = placementWarnings(ev, { tz: TZ }).filter((w) => w.code === "BREAK_TOO_LATE");
    expect(late).toHaveLength(1);
    expect(late[0].certainty).toBe("UNCLEAR");
    expect(late[0].message.endsWith("Klärung nötig: Fahrzeit oder Pause?")).toBe(true);
    expect(late[0].crossSalon).toBe(true);
  });

  it("a waived day flags every finding waived and keeps the severity", () => {
    const rows = [entry("e1", "08:00", "15:00", 30, [iv("14:01", "14:31")])];
    const base = evaluate(rows);
    const ev = evaluateDayBreaks({
      rows,
      dayBreaks: [],
      acks: [{ snapshot: base.snapshot }],
    });
    expect(ev.waived).toBe(true);
    const late = placementWarnings(ev, { tz: TZ }).filter((w) => w.code === "BREAK_TOO_LATE");
    expect(late).toHaveLength(1);
    expect(late[0].waived).toBe(true);
    expect(late[0].severity).toBe("warning");
  });

  // Amended 2026-10-13 (Phase 85b, Issue #85 D-07): this case used to pin the count-and-duration
  // "redacted" variant of placementWarnings(). A partially covered day now carries one neutral
  // hint only (redactedDayCheck in api/day-breaks.ts), no production caller used the variant any
  // more, and its sum-bearing text must not be reusable by accident - so the variant was removed
  // and the case pins the removal. The T-511-07 intent (a reduced-reach reader never receives
  // clock times, ranges or ids from this builder) is now carried by the neutral-hint tests in
  // day-break-checks.test.ts.
  it("has no redacted detail variant any more, and the output keeps the finding shape (T-511-07, retired by Phase 85b D-07)", () => {
    const ev = evaluate([
      entry("secret-entry-id", "08:00", "15:00", 30, [
        iv("10:00", "10:10"),
        iv("14:01", "14:11"),
        iv("08:00", "08:10"),
      ]),
    ]);
    const out = placementWarnings(ev, { tz: TZ, birthDateMissing: true });
    expect(out.length).toBeGreaterThan(0);
    for (const w of out) {
      // no field outside the finding shape (no interval, entry id or salon id)
      for (const key of Object.keys(w)) expect(ALLOWED_KEYS.has(key)).toBe(true);
      expect(w.message).not.toContain("secret-entry-id");
      expect(w.message).not.toContain(SALON_A);
    }
    // anti-vacuity: the only variant is the clock-time one, so it is for whole-day readers only
    expect(out.some((w) => /\d{1,2}:\d{2}–\d{1,2}:\d{2}/.test(w.message))).toBe(true);
    // the builder takes no detail option any more
    const source = readFileSync(resolve(__dirname, "../arbzg.ts"), "utf8");
    expect(source).not.toMatch(/detail\s*:\s*"(full|redacted)"/);
    expect(source).not.toContain('"redacted"');
  });

  it("birthDateMissing appends the note in the full variant only", () => {
    const ev = evaluate([entry("e1", "08:00", "15:00", 30, [iv("14:01", "14:31")])]);
    const withNote = placementWarnings(ev, { tz: TZ, birthDateMissing: true });
    const without = placementWarnings(ev, { tz: TZ });
    expect(withNote.every((w) => w.message.includes("Geburtsdatum nicht hinterlegt"))).toBe(true);
    expect(without.some((w) => w.message.includes("Geburtsdatum nicht hinterlegt"))).toBe(false);
  });
});

describe("dayLimitWarnings — § 11 JArbSchG branch and the birth-date note (Issue #511, D-05)", () => {
  function minorDay(rows: DayBreakRow[]) {
    return evaluateDayBreaks({ rows, dayBreaks: [], acks: [], regime: "JARBSCHG_11" });
  }

  it("above 6 h: BREAK_TOO_SHORT cites § 11 Abs. 1, names 60 minutes and is an error", () => {
    const ev = minorDay([entry("e1", "08:00", "15:00", 30)]);
    const out = dayLimitWarnings(ev, 0);
    const short = out.filter((w) => w.code === "BREAK_TOO_SHORT");
    expect(short).toHaveLength(1);
    expect(short[0].severity).toBe("error");
    expect(short[0].message).toBe(
      "§ 11 Abs. 1 JArbSchG: Bei mehr als 6 Stunden Arbeitszeit sind mindestens 60 Minuten Ruhepause vorgeschrieben. Erfasst: 30 Min.",
    );
  });

  it("between 4.5 h and 6 h: 30 minutes are required and the finding is a warning", () => {
    const ev = minorDay([entry("e1", "08:00", "13:30", 0)]);
    const short = dayLimitWarnings(ev, 0).filter((w) => w.code === "BREAK_TOO_SHORT");
    expect(short).toHaveLength(1);
    expect(short[0].severity).toBe("warning");
    expect(short[0].message).toContain("Bei mehr als 4,5 Stunden");
    expect(short[0].message).toContain("mindestens 30 Minuten");
  });

  it("a waived minor day downgrades the 60-minute band to a warning and flags waived", () => {
    const waivedRow = { ...entry("e1", "08:00", "15:00", 30), breakStatus: "WAIVED" };
    const short = dayLimitWarnings(minorDay([waivedRow]), 0).filter(
      (w) => w.code === "BREAK_TOO_SHORT",
    );
    expect(short).toHaveLength(1);
    expect(short[0].severity).toBe("warning");
    expect(short[0].waived).toBe(true);
  });

  it("the same day under the adult regime keeps the pre-80 strings (two-argument call)", () => {
    const ev = evaluate([entry("e1", "08:00", "15:00", 10)]);
    const short = dayLimitWarnings(ev, 0).filter((w) => w.code === "BREAK_TOO_SHORT");
    expect(short).toHaveLength(1);
    expect(short[0].message).toBe(
      "§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: 10 Min.",
    );
    expect(Object.keys(short[0])).toEqual(["code", "severity", "message"]);
  });

  it("birthDateMissing appends the note to BREAK_TOO_SHORT only, never to MAX_DAILY_EXCEEDED", () => {
    // 11 h presence, 45 min break: net 10 h 15 min -> MAX_DAILY_EXCEEDED; a short break too.
    const ev = evaluate([entry("e1", "06:00", "17:30", 10)]);
    const out = dayLimitWarnings(ev, 0, { birthDateMissing: true });
    const short = out.find((w) => w.code === "BREAK_TOO_SHORT");
    const max = out.find((w) => w.code === "MAX_DAILY_EXCEEDED");
    expect(short?.message).toContain("Geburtsdatum nicht hinterlegt");
    expect(max).toBeDefined();
    expect(max?.message).not.toContain("Geburtsdatum");
    // without the option the strings are the pre-80 ones
    const plain = dayLimitWarnings(ev, 0);
    expect(plain.find((w) => w.code === "BREAK_TOO_SHORT")?.message).not.toContain("Geburtsdatum");
  });
});

describe("isApprenticeWithoutBirthDate (Issue #511, D-05)", () => {
  it("is true only for an AZUBI without a birth date", () => {
    expect(isApprenticeWithoutBirthDate({ classification: "AZUBI", birthDate: null })).toBe(true);
    expect(isApprenticeWithoutBirthDate({ classification: "AZUBI", birthDate: undefined })).toBe(
      true,
    );
    expect(
      isApprenticeWithoutBirthDate({ classification: "AZUBI", birthDate: new Date("2009-01-01") }),
    ).toBe(false);
    expect(isApprenticeWithoutBirthDate({ classification: "VOLLZEIT", birthDate: null })).toBe(
      false,
    );
    expect(isApprenticeWithoutBirthDate({ classification: null, birthDate: null })).toBe(false);
  });
});
