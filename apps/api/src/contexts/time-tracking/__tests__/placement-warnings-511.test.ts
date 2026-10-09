// Issue #511 (D-02, D-07, D-10) — placementWarnings(): the one message builder for the Satz-2/3
// findings. Pure: evaluations are constructed with the real kernel from Break rows, nothing here
// touches the database. The builder renders findings; it decides nothing.

import { describe, it, expect } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { evaluateDayBreaks } from "../day-break-rule";
import type { DayBreakRow, DayBreakInterval } from "../day-break-rule";
import { placementWarnings } from "../arbzg";

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
    const out = placementWarnings(ev, { tz: TZ, detail: "full" });
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
    const out = placementWarnings(ev, { tz: TZ, detail: "full" });
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
    const out = placementWarnings(ev, { tz: TZ, detail: "full" });
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
    const short = placementWarnings(ev, { tz: TZ, detail: "full" }).filter(
      (w) => w.code === "BREAK_SEGMENT_TOO_SHORT",
    );
    expect(short).toHaveLength(1);
    expect(short[0].message).toContain("1 Pause unter 15 Min nicht angerechnet");
  });

  it("BREAK_SEGMENT_TOO_SHORT: an edge segment is named separately", () => {
    const ev = evaluate([entry("e1", "08:00", "15:00", 30, [iv("08:00", "08:30")])]);
    const short = placementWarnings(ev, { tz: TZ, detail: "full" }).filter(
      (w) => w.code === "BREAK_SEGMENT_TOO_SHORT",
    );
    expect(short).toHaveLength(1);
    expect(short[0].message).toContain("am Beginn oder Ende der Arbeitszeit nicht angerechnet");
  });

  it("BREAK_POSITION_UNKNOWN: carries hint true and no certainty, never a violation (AK-3)", () => {
    const ev = evaluate([entry("e1", "08:00", "15:00", 30)]);
    const out = placementWarnings(ev, { tz: TZ, detail: "full" });
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
    const late = placementWarnings(ev, { tz: TZ, detail: "full" }).filter(
      (w) => w.code === "BREAK_TOO_LATE",
    );
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
    const late = placementWarnings(ev, { tz: TZ, detail: "full" }).filter(
      (w) => w.code === "BREAK_TOO_LATE",
    );
    expect(late).toHaveLength(1);
    expect(late[0].waived).toBe(true);
    expect(late[0].severity).toBe("warning");
  });

  it("redacted detail carries no clock time, no time range and no id (T-511-07)", () => {
    const ev = evaluate([
      entry("secret-entry-id", "08:00", "15:00", 30, [
        iv("10:00", "10:10"),
        iv("14:01", "14:11"),
        iv("08:00", "08:10"),
      ]),
    ]);
    const out = placementWarnings(ev, { tz: TZ, detail: "redacted", birthDateMissing: true });
    expect(out.length).toBeGreaterThan(0);
    for (const w of out) {
      expect(w.message).not.toMatch(/\d{1,2}:\d{2}/);
      expect(w.message).not.toContain("secret-entry-id");
      expect(w.message).not.toContain(SALON_A);
      expect(w.message).not.toContain("Geburtsdatum nicht hinterlegt");
      // whitelist: no field outside the finding shape (no interval, entry id or salon id)
      for (const key of Object.keys(w)) expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
    // anti-vacuity: the full variant of the same day does contain clock times
    const full = placementWarnings(ev, { tz: TZ, detail: "full" });
    expect(full.some((w) => /\d{1,2}:\d{2}–\d{1,2}:\d{2}/.test(w.message))).toBe(true);
  });

  it("birthDateMissing appends the note in the full variant only", () => {
    const ev = evaluate([entry("e1", "08:00", "15:00", 30, [iv("14:01", "14:31")])]);
    const withNote = placementWarnings(ev, { tz: TZ, detail: "full", birthDateMissing: true });
    const without = placementWarnings(ev, { tz: TZ, detail: "full" });
    expect(withNote.every((w) => w.message.includes("Geburtsdatum nicht hinterlegt"))).toBe(true);
    expect(without.some((w) => w.message.includes("Geburtsdatum nicht hinterlegt"))).toBe(false);
  });
});
