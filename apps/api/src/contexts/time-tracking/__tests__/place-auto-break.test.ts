// Issue #511 (AK-4, D-17, D-19, D-20) — the pure placement of the automatic break.
// DB-free; every instant is fixed. The sweep evaluates what the placement produces with the day
// kernel itself, so the system cannot write a break the kernel would flag.

import { describe, it, expect } from "vitest";
import { placeAutoBreak, resolveDefaultBreakStart, autoBreakAmountFor } from "../place-auto-break";
import { evaluateDayBreaks } from "../day-break-rule";
import { BREAK_REGIMES, requiredBreakFor, type BreakRegime } from "../break-regime";

const BERLIN = "Europe/Berlin";
const MIN = 60_000;

function at(iso: string): Date {
  return new Date(iso);
}

describe("resolveDefaultBreakStart (D-17: the setting is tenant wall-clock time)", () => {
  it("summer: 12:00 Berlin is 10:00Z", () => {
    const d = resolveDefaultBreakStart({
      entryStart: at("2026-07-15T06:00:00.000Z"),
      hhmm: "12:00",
      tz: BERLIN,
    });
    expect(d?.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("winter: 12:00 Berlin is 11:00Z", () => {
    const d = resolveDefaultBreakStart({
      entryStart: at("2026-01-14T07:00:00.000Z"),
      hhmm: "12:00",
      tz: BERLIN,
    });
    expect(d?.toISOString()).toBe("2026-01-14T11:00:00.000Z");
  });

  it("spring-forward day (2026-03-29): 12:00 Berlin is 10:00Z", () => {
    const d = resolveDefaultBreakStart({
      entryStart: at("2026-03-29T06:00:00.000Z"),
      hhmm: "12:00",
      tz: BERLIN,
    });
    expect(d?.toISOString()).toBe("2026-03-29T10:00:00.000Z");
  });

  it("fall-back day (2026-10-25): 12:00 Berlin is 11:00Z", () => {
    const d = resolveDefaultBreakStart({
      entryStart: at("2026-10-25T06:00:00.000Z"),
      hhmm: "12:00",
      tz: BERLIN,
    });
    expect(d?.toISOString()).toBe("2026-10-25T11:00:00.000Z");
  });

  it("anchors a late-evening UTC start to the tenant-local calendar day", () => {
    // 23:30Z on 14 July is 01:30 on 15 July in Berlin: the anchor day is the 15th.
    const d = resolveDefaultBreakStart({
      entryStart: at("2026-07-14T23:30:00.000Z"),
      hhmm: "12:00",
      tz: BERLIN,
    });
    expect(d?.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it.each([null, undefined, "", "12", "ab:cd", "25:00", "12:60", "12:5", "12:00:00"])(
    "malformed or missing %j yields null (T-511-11)",
    (bad) => {
      expect(
        resolveDefaultBreakStart({
          entryStart: at("2026-07-15T06:00:00.000Z"),
          hhmm: bad,
          tz: BERLIN,
        }),
      ).toBeNull();
    },
  );

  it("accepts a one-digit hour", () => {
    const d = resolveDefaultBreakStart({
      entryStart: at("2026-07-15T06:00:00.000Z"),
      hhmm: "9:30",
      tz: BERLIN,
    });
    expect(d?.toISOString()).toBe("2026-07-15T07:30:00.000Z");
  });
});

describe("autoBreakAmountFor (D-17 adults unchanged, D-20 minors raised)", () => {
  it("ARBZG_4 returns the configured amount for every presence", () => {
    for (const configuredMin of [0, 15, 30, 45, 90]) {
      for (const presenceMin of [0, 200, 271, 361, 541, 900]) {
        expect(autoBreakAmountFor({ configuredMin, presenceMin, regime: "ARBZG_4" })).toBe(
          configuredMin,
        );
      }
    }
  });

  it("JARBSCHG_11: nothing up to and including 270 minutes", () => {
    expect(autoBreakAmountFor({ configuredMin: 0, presenceMin: 270, regime: "JARBSCHG_11" })).toBe(
      0,
    );
  });

  it("JARBSCHG_11: 30 minutes above 270, 60 above 360, never below the configured amount", () => {
    const f = (configuredMin: number, presenceMin: number) =>
      autoBreakAmountFor({ configuredMin, presenceMin, regime: "JARBSCHG_11" });
    expect(f(0, 271)).toBe(30);
    expect(f(15, 271)).toBe(30);
    expect(f(45, 271)).toBe(45);
    expect(f(30, 361)).toBe(60);
    expect(f(0, 361)).toBe(60);
    expect(f(75, 361)).toBe(75);
  });
});

describe("placeAutoBreak", () => {
  const start = at("2026-07-15T06:00:00.000Z");

  it("10 h, 45 min, no preferred start: the centred break of today", () => {
    const end = new Date(start.getTime() + 600 * MIN);
    const seg = placeAutoBreak({
      start,
      end,
      amountMin: 45,
      preferredStart: null,
      regime: "ARBZG_4",
    });
    expect(seg).toHaveLength(1);
    // today: midpoint - amount / 2
    const expectedStart = start.getTime() + 300 * MIN - 22.5 * MIN;
    expect(seg[0].startTime.getTime()).toBe(expectedStart);
    expect(seg[0].endTime.getTime() - seg[0].startTime.getTime()).toBe(45 * MIN);
  });

  it("7 h, 30 min, no preferred start: the centred break of today", () => {
    const end = new Date(start.getTime() + 420 * MIN);
    const seg = placeAutoBreak({
      start,
      end,
      amountMin: 30,
      preferredStart: null,
      regime: "ARBZG_4",
    });
    expect(seg[0].startTime.getTime()).toBe(start.getTime() + 195 * MIN);
  });

  it("a conformant preferred start is kept exactly", () => {
    const end = new Date(start.getTime() + 540 * MIN);
    const preferred = new Date(start.getTime() + 240 * MIN);
    const seg = placeAutoBreak({
      start,
      end,
      amountMin: 30,
      preferredStart: preferred,
      regime: "ARBZG_4",
    });
    expect(seg[0].startTime.getTime()).toBe(preferred.getTime());
  });

  it("12 h with the preferred start at hour 7 moves to the latest start that keeps block 1 at 6 h", () => {
    const end = new Date(start.getTime() + 720 * MIN);
    const seg = placeAutoBreak({
      start,
      end,
      amountMin: 45,
      preferredStart: new Date(start.getTime() + 420 * MIN),
      regime: "ARBZG_4",
    });
    expect(seg).toHaveLength(1);
    expect(seg[0].startTime.getTime()).toBe(start.getTime() + 360 * MIN);
  });

  it("a preferred start outside the entry falls back to the middle", () => {
    const end = new Date(start.getTime() + 420 * MIN);
    for (const offset of [-10, 0, 420, 500]) {
      const seg = placeAutoBreak({
        start,
        end,
        amountMin: 30,
        preferredStart: new Date(start.getTime() + offset * MIN),
        regime: "ARBZG_4",
      });
      expect(seg[0].startTime.getTime()).toBe(start.getTime() + 195 * MIN);
    }
  });

  it("14 h, 45 min, adult: two segments of 23 + 22 minutes, every block at most 6 h", () => {
    const end = new Date(start.getTime() + 840 * MIN);
    const seg = placeAutoBreak({
      start,
      end,
      amountMin: 45,
      preferredStart: null,
      regime: "ARBZG_4",
    });
    expect(seg).toHaveLength(2);
    expect(seg.map((s) => (s.endTime.getTime() - s.startTime.getTime()) / MIN)).toEqual([23, 22]);
    const blocks = [
      seg[0].startTime.getTime() - start.getTime(),
      seg[1].startTime.getTime() - seg[0].endTime.getTime(),
      end.getTime() - seg[1].endTime.getTime(),
    ];
    for (const b of blocks) expect(b).toBeLessThanOrEqual(360 * MIN);
  });

  it("presence shorter than amount + two margins places nothing", () => {
    const end = new Date(start.getTime() + 31 * MIN);
    expect(
      placeAutoBreak({ start, end, amountMin: 30, preferredStart: null, regime: "ARBZG_4" }),
    ).toEqual([]);
    const end2 = new Date(start.getTime() + 150 * MIN - 1);
    expect(
      placeAutoBreak({
        start,
        end: end2,
        amountMin: 30,
        preferredStart: null,
        regime: "JARBSCHG_11",
      }),
    ).toEqual([]);
  });

  it("an amount below the minimum segment places nothing", () => {
    const end = new Date(start.getTime() + 600 * MIN);
    expect(
      placeAutoBreak({ start, end, amountMin: 10, preferredStart: null, regime: "ARBZG_4" }),
    ).toEqual([]);
  });

  it("minors: the segment keeps one hour clear of both edges", () => {
    const end = new Date(start.getTime() + 300 * MIN);
    // preferred start at minute 10 would lie inside the one-hour window
    const seg = placeAutoBreak({
      start,
      end,
      amountMin: 30,
      preferredStart: new Date(start.getTime() + 10 * MIN),
      regime: "JARBSCHG_11",
    });
    expect(seg[0].startTime.getTime()).toBe(start.getTime() + 60 * MIN);
    const lateSeg = placeAutoBreak({
      start,
      end,
      amountMin: 30,
      preferredStart: new Date(start.getTime() + 290 * MIN),
      regime: "JARBSCHG_11",
    });
    expect(lateSeg[0].endTime.getTime()).toBe(end.getTime() - 60 * MIN);
  });
});

// ── The AK-4 sweep: what the placement writes is never flagged by the kernel ────────────────────

const STARTS: Array<{ label: string; start: string; tz: string }> = [
  { label: "plain summer day", start: "2026-07-15T06:00:00.000Z", tz: BERLIN },
  { label: "spring-forward day", start: "2026-03-29T00:00:00.000Z", tz: BERLIN },
  { label: "fall-back day", start: "2026-10-24T22:00:00.000Z", tz: BERLIN },
  // 20:00 Berlin; with a long presence the entry crosses midnight
  { label: "evening start (cross-midnight)", start: "2026-07-15T18:00:00.000Z", tz: BERLIN },
];

const FORBIDDEN = ["BREAK_SEGMENT_TOO_SHORT", "BREAK_TOO_LATE", "BREAK_OUTSIDE_WINDOW"];

function kernelCodes(
  start: Date,
  end: Date,
  segments: Array<{ startTime: Date; endTime: Date }>,
  amountMin: number,
  regime: BreakRegime,
): string[] {
  const ev = evaluateDayBreaks({
    rows: [
      {
        id: "entry-1",
        startTime: start,
        endTime: end,
        breakMinutes: amountMin,
        breakStatus: "AUTO",
        salonId: "salon-1",
        breaks: segments,
      },
    ],
    dayBreaks: [],
    acks: [],
    regime,
  });
  return ev.placement.findings.map((f) => f.code);
}

describe("AK-4 sweep against the day kernel", () => {
  it("no automatic placement is flagged by the kernel (adults and minors)", () => {
    let cases = 0;
    const failures: string[] = [];

    const run = (regime: BreakRegime, presenceMin: number, configured: number) => {
      for (const s of STARTS) {
        for (const pref of ["none", "12:00", "06:00"] as const) {
          const start = at(s.start);
          const end = new Date(start.getTime() + presenceMin * MIN);
          const amountMin = autoBreakAmountFor({ configuredMin: configured, presenceMin, regime });
          if (amountMin <= 0) continue;
          const preferredStart =
            pref === "none"
              ? null
              : resolveDefaultBreakStart({ entryStart: start, hhmm: pref, tz: s.tz });
          const segments = placeAutoBreak({ start, end, amountMin, preferredStart, regime });
          if (segments.length === 0) continue;
          cases += 1;
          const placed = segments.reduce(
            (sum, g) => sum + (g.endTime.getTime() - g.startTime.getTime()) / MIN,
            0,
          );
          if (placed !== amountMin) failures.push(`${regime} ${presenceMin} ${s.label}: amount`);
          const bad = kernelCodes(start, end, segments, amountMin, regime).filter((c) =>
            FORBIDDEN.includes(c),
          );
          if (bad.length > 0) {
            failures.push(`${regime} P=${presenceMin} B=${amountMin} ${s.label} ${pref}: ${bad}`);
          }
        }
      }
    };

    for (let presence = 361; presence <= 960; presence += 7) {
      for (const configured of [30, 45, 60]) run("ARBZG_4", presence, configured);
    }
    for (let presence = 271; presence <= 720; presence += 7) {
      // a tenant setting below the statutory minimum (15 / 0) is raised by autoBreakAmountFor
      for (const configured of [0, 15, 30, 45]) run("JARBSCHG_11", presence, configured);
    }

    expect(failures).toEqual([]);
    expect(cases).toBeGreaterThan(400);
  });

  it("the oracle is not blind: a break at the very start and a break at hour 7 are flagged", () => {
    const start = at("2026-07-15T06:00:00.000Z");
    const end = new Date(start.getTime() + 600 * MIN);
    const atEdge = [{ startTime: start, endTime: new Date(start.getTime() + 30 * MIN) }];
    expect(kernelCodes(start, end, atEdge, 30, "ARBZG_4")).toContain("BREAK_TOO_LATE");
    const late = [
      {
        startTime: new Date(start.getTime() + 420 * MIN),
        endTime: new Date(start.getTime() + 450 * MIN),
      },
    ];
    expect(kernelCodes(start, end, late, 30, "ARBZG_4")).toContain("BREAK_TOO_LATE");
    const minorEnd = new Date(start.getTime() + 300 * MIN);
    const inWindow = [
      {
        startTime: new Date(start.getTime() + 20 * MIN),
        endTime: new Date(start.getTime() + 50 * MIN),
      },
    ];
    expect(kernelCodes(start, minorEnd, inWindow, 30, "JARBSCHG_11")).toContain(
      "BREAK_OUTSIDE_WINDOW",
    );
  });

  it("the regime table, not a literal, drives the limits used here", () => {
    expect(BREAK_REGIMES.ARBZG_4.maxBlockMin).toBe(360);
    expect(requiredBreakFor(BREAK_REGIMES.JARBSCHG_11, 271)).toBe(30);
  });
});
