// Issue #80 D-22 — the interval model of the day-break kernel, prepared for #511.
// § 4 ArbZG Satz 2 (segments of at least 15 min) and Satz 3 (no block above 6 h without a break)
// are NOT evaluated in Phase 80; this file only proves the kernel exposes the break segments with
// their source, the gaps and the work blocks, consistently with the unchanged minute sums.
// DB-free: every instant is a fixed UTC instant on 2026-03-10.

import { describe, it, expect } from "vitest";
import {
  evaluateDayBreaks,
  type DayBreakRow,
  type DayBreakInterval,
  type DayBreakEvaluation,
} from "../day-break-rule";

const A = "salon-a";
const B = "salon-b";

function t(hhmm: string, extraMs = 0): Date {
  return new Date(new Date(`2026-03-10T${hhmm}:00.000Z`).getTime() + extraMs);
}

let seq = 0;
function row(
  salonId: string,
  start: string,
  end: string,
  opts: {
    breakMinutes?: number;
    id?: string;
    breaks?: DayBreakInterval[] | null;
    endExtraMs?: number;
  } = {},
): DayBreakRow {
  seq += 1;
  const r: DayBreakRow = {
    id: opts.id ?? `e${String(seq).padStart(3, "0")}`,
    startTime: t(start),
    endTime: t(end, opts.endExtraMs ?? 0),
    breakMinutes: opts.breakMinutes ?? 0,
    breakStatus: "CONFIRMED",
    salonId,
  };
  if (opts.breaks !== undefined) r.breaks = opts.breaks;
  return r;
}

function brk(start: string, end: string): DayBreakInterval {
  return { startTime: t(start), endTime: t(end) };
}

function evaluate(rows: DayBreakRow[], dayBreaks: DayBreakInterval[] = []): DayBreakEvaluation {
  return evaluateDayBreaks({ rows, dayBreaks, acks: [] });
}

describe("D-22: break segments carry their source", () => {
  it("legacy breakMinutes without Break rows is one unplaced segment with null positions", () => {
    const e = row(A, "08:00", "16:00", { id: "x1", breakMinutes: 30 });
    const ev = evaluate([e]);
    expect(ev.breakSegments).toEqual([
      {
        source: "unplaced-entry-break",
        entryId: "x1",
        startTime: null,
        endTime: null,
        minutes: 30,
      },
    ]);
  });

  it("a Break row covering the stored break is one entry-break segment and nothing is unplaced", () => {
    const e = row(A, "08:00", "16:00", {
      id: "x1",
      breakMinutes: 30,
      breaks: [brk("12:00", "12:30")],
    });
    const ev = evaluate([e]);
    expect(ev.breakSegments).toEqual([
      {
        source: "entry-break",
        entryId: "x1",
        startTime: t("12:00"),
        endTime: t("12:30"),
        minutes: 30,
      },
    ]);
  });

  it("a Break row shorter than the stored break leaves the rest as an unplaced segment", () => {
    const e = row(A, "08:00", "16:00", {
      id: "x1",
      breakMinutes: 30,
      breaks: [brk("12:00", "12:20")],
    });
    const ev = evaluate([e]);
    expect(ev.breakSegments.map((s) => [s.source, s.minutes])).toEqual([
      ["entry-break", 20],
      ["unplaced-entry-break", 10],
    ]);
    const unplaced = ev.breakSegments[1];
    expect(unplaced.startTime).toBeNull();
    expect(unplaced.endTime).toBeNull();
  });

  it("a Break row that pokes out of its entry is clipped to the entry", () => {
    const e = row(A, "08:00", "16:00", {
      id: "x1",
      breakMinutes: 10,
      breaks: [brk("07:50", "08:10")],
    });
    const ev = evaluate([e]);
    expect(ev.breakSegments).toEqual([
      {
        source: "entry-break",
        entryId: "x1",
        startTime: t("08:00"),
        endTime: t("08:10"),
        minutes: 10,
      },
    ]);
  });

  it("Break rows above the stored break leave nothing unplaced and the sums keep using breakMinutes", () => {
    const e = row(A, "08:00", "16:00", {
      id: "x1",
      breakMinutes: 30,
      breaks: [brk("11:00", "11:20"), brk("13:00", "13:20")],
    });
    const ev = evaluate([e]);
    expect(ev.breakSegments.map((s) => s.source)).toEqual(["entry-break", "entry-break"]);
    expect(ev.breakSegments.reduce((sum, s) => sum + s.minutes, 0)).toBe(40);
    expect(ev.explicitBreakMin).toBe(30);
    expect(ev.totalBreakMin).toBe(30);
  });
});

describe("D-22: gaps and the segments they produce", () => {
  it("a same-salon gap of 30 minutes is a same-salon-gap segment and a counting gap", () => {
    const ev = evaluate([
      row(A, "08:00", "12:00", { id: "a1" }),
      row(A, "12:30", "16:30", { id: "a2" }),
    ]);
    expect(ev.breakSegments).toEqual([
      {
        source: "same-salon-gap",
        entryId: null,
        startTime: t("12:00"),
        endTime: t("12:30"),
        minutes: 30,
      },
    ]);
    expect(ev.gaps).toEqual([
      {
        previousEntryId: "a1",
        nextEntryId: "a2",
        startTime: t("12:00"),
        endTime: t("12:30"),
        minutes: 30,
        crossSalon: false,
        countsAsBreak: true,
      },
    ]);
  });

  it("a cross-salon gap without a day break is travel: a gap entry, no segment", () => {
    const ev = evaluate([
      row(A, "08:00", "12:00", { id: "a1" }),
      row(B, "12:30", "16:30", { id: "b1" }),
    ]);
    expect(ev.breakSegments).toEqual([]);
    expect(ev.gaps).toEqual([
      {
        previousEntryId: "a1",
        nextEntryId: "b1",
        startTime: t("12:00"),
        endTime: t("12:30"),
        minutes: 30,
        crossSalon: true,
        countsAsBreak: false,
      },
    ]);
  });

  it("a day break in a cross-salon gap is a day-break segment clipped to the gap", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(B, "12:30", "16:30")],
      [brk("12:05", "12:35")],
    );
    expect(ev.breakSegments).toEqual([
      {
        source: "day-break",
        entryId: null,
        startTime: t("12:05"),
        endTime: t("12:30"),
        minutes: 25,
      },
    ]);
  });

  it("a day break in a same-salon gap above 120 minutes is a day-break segment and the gap does not count", () => {
    const rows = [row(A, "08:00", "12:00", { id: "a1" }), row(A, "15:00", "18:00", { id: "a2" })];
    const withBreak = evaluate(rows, [brk("13:00", "13:30")]);
    expect(withBreak.breakSegments).toEqual([
      {
        source: "day-break",
        entryId: null,
        startTime: t("13:00"),
        endTime: t("13:30"),
        minutes: 30,
      },
    ]);
    expect(withBreak.gaps).toHaveLength(1);
    expect(withBreak.gaps[0]).toMatchObject({
      minutes: 180,
      crossSalon: false,
      countsAsBreak: false,
    });
  });

  it("a day break inside a counting same-salon gap adds no segment (the gap is the segment)", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(A, "12:30", "16:30")],
      [brk("12:05", "12:20")],
    );
    expect(ev.breakSegments.map((s) => s.source)).toEqual(["same-salon-gap"]);
    expect(ev.dayBreakMin).toBe(0);
  });

  it("overlapping or adjacent rows produce no gap entry", () => {
    expect(evaluate([row(A, "08:00", "12:00"), row(B, "11:30", "15:00")]).gaps).toEqual([]);
    expect(evaluate([row(A, "08:00", "12:00"), row(B, "12:00", "15:00")]).gaps).toEqual([]);
  });

  it("segments are ordered by start time, unplaced segments follow in entry order", () => {
    const ev = evaluate([
      row(A, "07:00", "11:00", { id: "a1", breakMinutes: 15 }),
      row(A, "11:30", "17:00", {
        id: "a2",
        breakMinutes: 40,
        breaks: [brk("13:00", "13:20")],
      }),
    ]);
    expect(ev.breakSegments.map((s) => [s.source, s.entryId, s.minutes])).toEqual([
      ["same-salon-gap", null, 30],
      ["entry-break", "a2", 20],
      ["unplaced-entry-break", "a1", 15],
      ["unplaced-entry-break", "a2", 20],
    ]);
  });
});

describe("D-22 additivity: the minute sums never come from the interval view", () => {
  it("every numeric field is identical with and without Break rows on the rows", () => {
    const plain = [
      row(A, "08:00", "12:00", { id: "a1", breakMinutes: 20 }),
      row(A, "12:30", "17:00", { id: "a2", breakMinutes: 15 }),
      row(B, "17:20", "19:00", { id: "b1", breakMinutes: 0 }),
    ];
    const withBreaks = [
      { ...plain[0], breaks: [brk("10:00", "10:20")] },
      { ...plain[1], breaks: [brk("14:00", "14:05"), brk("15:00", "15:30")] },
      { ...plain[2], breaks: [brk("18:00", "18:10")] },
    ];
    const dayBreaks = [brk("17:00", "17:10")];
    const a = evaluate(plain, dayBreaks);
    const b = evaluate(withBreaks, dayBreaks);
    for (const k of [
      "netWorkedMin",
      "explicitBreakMin",
      "gapBreakMin",
      "dayBreakMin",
      "totalBreakMin",
      "requiredBreakMin",
      "breakShortfall",
      "acknowledged",
      "waived",
      "crossSalon",
    ] as const) {
      expect(b[k]).toBe(a[k]);
    }
    expect(b.snapshot).toEqual(a.snapshot);
    expect(b.salonIds).toEqual(a.salonIds);
    // The interval view does differ: the placed segments exist only with Break rows.
    expect(b.breakSegments).not.toEqual(a.breakSegments);
  });
});
