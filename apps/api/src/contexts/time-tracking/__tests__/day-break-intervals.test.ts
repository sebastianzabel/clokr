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

describe("D-22: work blocks between the placed breaks", () => {
  it("one entry without breaks is one block with no unknown-position break", () => {
    const ev = evaluate([row(A, "08:00", "16:00", { id: "x1" })]);
    expect(ev.workBlocks).toEqual([
      {
        startTime: t("08:00"),
        endTime: t("16:00"),
        minutes: 480,
        entryIds: ["x1"],
        positionUnknownBreakMinutes: 0,
      },
    ]);
  });

  it("a Break row splits the entry into two blocks", () => {
    const ev = evaluate([
      row(A, "08:00", "16:00", { id: "x1", breakMinutes: 30, breaks: [brk("12:00", "12:30")] }),
    ]);
    expect(ev.workBlocks.map((b) => [b.startTime, b.endTime, b.minutes])).toEqual([
      [t("08:00"), t("12:00"), 240],
      [t("12:30"), t("16:00"), 210],
    ]);
    expect(ev.workBlocks.every((b) => b.positionUnknownBreakMinutes === 0)).toBe(true);
  });

  it("a cross-salon gap without a day break is travel: one block across both salons", () => {
    const ev = evaluate([
      row(A, "08:00", "12:00", { id: "a1" }),
      row(B, "12:30", "16:30", { id: "b1" }),
    ]);
    expect(ev.workBlocks).toHaveLength(1);
    expect(ev.workBlocks[0]).toMatchObject({
      startTime: t("08:00"),
      endTime: t("16:30"),
      minutes: 510,
      entryIds: ["a1", "b1"],
    });
  });

  it("a day break covering the whole cross-salon gap ends the block", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(B, "12:30", "16:30")],
      [brk("12:00", "12:30")],
    );
    expect(ev.workBlocks.map((b) => [b.startTime, b.endTime])).toEqual([
      [t("08:00"), t("12:00")],
      [t("12:30"), t("16:30")],
    ]);
  });

  it("a day break inside the cross-salon gap leaves the remaining travel to the blocks", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(B, "12:30", "16:30")],
      [brk("12:10", "12:20")],
    );
    expect(ev.workBlocks.map((b) => [b.startTime, b.endTime, b.minutes])).toEqual([
      [t("08:00"), t("12:10"), 250],
      [t("12:20"), t("16:30"), 250],
    ]);
  });

  it("a same-salon gap that counts as a break ends the block", () => {
    const ev = evaluate([row(A, "08:00", "12:00"), row(A, "12:30", "16:30")]);
    expect(ev.workBlocks.map((b) => b.minutes)).toEqual([240, 240]);
  });

  it("a same-salon gap above 120 minutes also ends the block", () => {
    const ev = evaluate([row(A, "08:00", "12:00"), row(A, "15:00", "18:00")]);
    expect(ev.workBlocks.map((b) => [b.startTime, b.endTime])).toEqual([
      [t("08:00"), t("12:00")],
      [t("15:00"), t("18:00")],
    ]);
  });

  it("adjacent and overlapping rows continue the block", () => {
    const adj = evaluate([
      row(A, "08:00", "12:00", { id: "a1" }),
      row(B, "12:00", "15:00", { id: "b1" }),
    ]);
    expect(adj.workBlocks).toHaveLength(1);
    expect(adj.workBlocks[0].entryIds).toEqual(["a1", "b1"]);
    const ov = evaluate([row(A, "08:00", "12:00"), row(B, "11:30", "15:00")]);
    expect(ov.workBlocks).toHaveLength(1);
    expect(ov.workBlocks[0].minutes).toBe(420);
  });

  it("legacy breakMinutes without position never split a block and are reported as unknown-position minutes", () => {
    const ev = evaluate([row(A, "08:00", "16:00", { id: "x1", breakMinutes: 30 })]);
    expect(ev.workBlocks).toHaveLength(1);
    expect(ev.workBlocks[0].minutes).toBe(480);
    expect(ev.workBlocks[0].positionUnknownBreakMinutes).toBe(30);
  });

  it("each block of an entry carries the entry's unknown-position minutes", () => {
    const ev = evaluate([
      row(A, "08:00", "16:00", { id: "x1", breakMinutes: 40, breaks: [brk("12:00", "12:20")] }),
    ]);
    expect(ev.workBlocks).toHaveLength(2);
    expect(ev.workBlocks.map((b) => b.positionUnknownBreakMinutes)).toEqual([20, 20]);
  });

  it("boundary: a block of exactly 6 h reads 360 minutes", () => {
    expect(evaluate([row(A, "08:00", "14:00")]).workBlocks[0].minutes).toBe(360);
  });

  it("boundary: a block of 6 h 1 min reads 361 minutes", () => {
    expect(evaluate([row(A, "08:00", "14:01")]).workBlocks[0].minutes).toBe(361);
  });

  it("boundary: a 15-minute Break row is a segment of exactly 15 minutes", () => {
    const ev = evaluate([
      row(A, "08:00", "16:00", { breakMinutes: 15, breaks: [brk("12:00", "12:15")] }),
    ]);
    expect(ev.breakSegments).toHaveLength(1);
    expect(ev.breakSegments[0].minutes).toBe(15);
  });
});

/** mulberry32 — a seeded PRNG so every run sees the same matrix. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
const DAY0 = Date.parse("2026-03-10T00:00:00.000Z");

interface MatrixCase {
  rows: DayBreakRow[];
  dayBreaks: DayBreakInterval[];
}

function generateCases(count: number, seed: number): MatrixCase[] {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const salons = [A, B, "salon-c"];
  const cases: MatrixCase[] = [];
  for (let c = 0; c < count; c++) {
    const n = int(1, 4);
    const rows: DayBreakRow[] = [];
    let cursor = int(5 * 60, 9 * 60);
    for (let i = 0; i < n; i++) {
      const dur = int(1, 300);
      const start = cursor;
      const end = start + dur;
      // Gaps from 0 to 200 minutes, with a heavy share inside the 120-minute band.
      cursor = end + (rnd() < 0.2 ? 0 : int(1, 200));
      rows.push({
        id: `m${c}-${i}`,
        startTime: new Date(DAY0 + start * MIN),
        endTime: new Date(DAY0 + end * MIN),
        breakMinutes: rnd() < 0.5 ? 0 : int(0, Math.min(60, dur)),
        breakStatus: "CONFIRMED",
        salonId: salons[int(0, salons.length - 1)],
      });
    }
    const dayBreaks: DayBreakInterval[] = [];
    const nb = int(0, 3);
    for (let i = 0; i < nb; i++) {
      const s = int(5 * 60, cursor);
      const e = s + int(1, 90);
      dayBreaks.push({ startTime: new Date(DAY0 + s * MIN), endTime: new Date(DAY0 + e * MIN) });
    }
    cases.push({ rows, dayBreaks });
  }
  return cases;
}

describe("D-22: the interval view is consistent with the minute sums", () => {
  const cases = generateCases(3000, 800081);

  it("segments sum to the stored minutes per entry, to gapBreakMin and to dayBreakMin", () => {
    let checked = 0;
    let withTravel = 0;
    for (const { rows, dayBreaks } of cases) {
      const ev = evaluateDayBreaks({ rows, dayBreaks, acks: [] });
      for (const r of rows) {
        const sum = ev.breakSegments
          .filter((s) => s.entryId === r.id)
          .reduce((acc, s) => acc + s.minutes, 0);
        expect(sum).toBe(Number(r.breakMinutes));
      }
      const sumOf = (source: string): number =>
        ev.breakSegments.filter((s) => s.source === source).reduce((acc, s) => acc + s.minutes, 0);
      expect(sumOf("same-salon-gap")).toBe(ev.gapBreakMin);
      expect(sumOf("day-break")).toBe(ev.dayBreakMin);
      // Block order and disjointness.
      for (let i = 0; i < ev.workBlocks.length; i++) {
        const b = ev.workBlocks[i];
        expect(b.minutes).toBeGreaterThan(0);
        if (i > 0) {
          expect(b.startTime.getTime()).toBeGreaterThan(ev.workBlocks[i - 1].endTime.getTime());
        }
      }
      if (ev.gaps.some((g) => g.crossSalon)) withTravel += 1;
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2000);
    expect(withTravel).toBeGreaterThan(200);
  });

  it("sensitivity: treating a cross-salon gap as a block boundary changes the blocks", () => {
    let differing = 0;
    for (const { rows, dayBreaks } of cases) {
      const ev = evaluateDayBreaks({ rows, dayBreaks, acks: [] });
      // Test-local variant: every positive gap ends a block (day breaks irrelevant, no Break rows).
      const variantCount = 1 + ev.gaps.length;
      if (variantCount !== ev.workBlocks.length) differing += 1;
    }
    expect(differing).toBeGreaterThan(100);
  });
});
