/**
 * Issue #657 (D-01/D-02) — the pure part of the Zeitnachtrag interval rule: HH:MM to instants in
 * the tenant time zone, the whole-day fallback for a request without times, the half-open overlap.
 * No database.
 */
import { describe, it, expect } from "vitest";
import { intervalsOverlap, retroRequestInterval, wholeTenantDay } from "../retro-request-overlap";

const TZ = "Europe/Berlin";
const HOUR = 3600 * 1000;

const iv = (startH: number, endH: number) => ({
  start: new Date(Date.UTC(2026, 5, 9, startH)),
  end: new Date(Date.UTC(2026, 5, 9, endH)),
});

describe("Issue #657 — retro request interval (pure)", () => {
  it("maps HH:MM on a summer day to UTC instants (+2 h)", () => {
    const r = retroRequestInterval(
      { targetDateStr: "2026-06-09", startTime: "08:00", endTime: "12:00" },
      TZ,
    );
    expect(r.start.toISOString()).toBe("2026-06-09T06:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-09T10:00:00.000Z");
  });

  it("a whole tenant day is 23 h on the DST start day and 25 h on the DST end day", () => {
    const spring = wholeTenantDay("2026-03-29", TZ);
    expect((spring.end.getTime() - spring.start.getTime()) / HOUR).toBe(23);
    const autumn = wholeTenantDay("2026-10-25", TZ);
    expect((autumn.end.getTime() - autumn.start.getTime()) / HOUR).toBe(25);
    const plain = wholeTenantDay("2026-06-09", TZ);
    expect((plain.end.getTime() - plain.start.getTime()) / HOUR).toBe(24);
  });

  it("a request without start, without end or without both covers the whole day (D-02)", () => {
    const day = wholeTenantDay("2026-06-09", TZ);
    for (const times of [
      { startTime: null, endTime: "12:00" },
      { startTime: "08:00", endTime: null },
      { startTime: null, endTime: null },
    ]) {
      expect(retroRequestInterval({ targetDateStr: "2026-06-09", ...times }, TZ)).toEqual(day);
    }
  });

  it("half-open overlap truth table", () => {
    // touching in either order is no overlap
    expect(intervalsOverlap(iv(8, 12), iv(12, 16))).toBe(false);
    expect(intervalsOverlap(iv(12, 16), iv(8, 12))).toBe(false);
    // contained, identical, partial
    expect(intervalsOverlap(iv(8, 16), iv(10, 12))).toBe(true);
    expect(intervalsOverlap(iv(10, 12), iv(8, 16))).toBe(true);
    expect(intervalsOverlap(iv(8, 12), iv(8, 12))).toBe(true);
    expect(intervalsOverlap(iv(8, 12), iv(11, 14))).toBe(true);
    // disjoint
    expect(intervalsOverlap(iv(8, 10), iv(12, 14))).toBe(false);
  });
});
