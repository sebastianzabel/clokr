// Issue #80 — unit matrix of the day-level break kernel (D-01, D-04, D-05, D-16, D-17, D-18).
// DB-free: every instant is a fixed UTC instant on 2026-03-10.

import { describe, it, expect } from "vitest";
import {
  evaluateDayBreaks,
  isAckSnapshotCurrent,
  findGapForInterval,
  intervalsOverlap,
  type DayBreakRow,
  type DayBreakInterval,
  type DaySnapshot,
} from "../day-break-rule";
import { dayLimitWarnings } from "../arbzg";

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
  opts: { breakMinutes?: number; breakStatus?: string; id?: string; endExtraMs?: number } = {},
): DayBreakRow {
  seq += 1;
  return {
    id: opts.id ?? `e${String(seq).padStart(3, "0")}`,
    startTime: t(start),
    endTime: t(end, opts.endExtraMs ?? 0),
    breakMinutes: opts.breakMinutes ?? 0,
    breakStatus: opts.breakStatus ?? "CONFIRMED",
    salonId,
  };
}

function brk(start: string, end: string): DayBreakInterval {
  return { startTime: t(start), endTime: t(end) };
}

function evaluate(
  rows: DayBreakRow[],
  dayBreaks: DayBreakInterval[] = [],
  acks: Array<{ snapshot: unknown }> = [],
) {
  return evaluateDayBreaks({ rows, dayBreaks, acks });
}

describe("D-01: a gap between salons is travel, a short same-salon gap stays a break", () => {
  it("cross-salon gap of 30 minutes counts nothing", () => {
    const ev = evaluate([row(A, "08:00", "12:00"), row(B, "12:30", "16:30")]);
    expect(ev.gapBreakMin).toBe(0);
    expect(ev.dayBreakMin).toBe(0);
    expect(ev.totalBreakMin).toBe(0);
  });

  it("same-salon gap of 30 minutes counts 30", () => {
    const ev = evaluate([row(A, "08:00", "12:00"), row(A, "12:30", "16:30")]);
    expect(ev.gapBreakMin).toBe(30);
  });

  it("same-salon gap of exactly 120 minutes counts 120", () => {
    const ev = evaluate([row(A, "08:00", "10:00"), row(A, "12:00", "14:00")]);
    expect(ev.gapBreakMin).toBe(120);
  });

  it("same-salon gap of 121 minutes counts nothing (a separate shift)", () => {
    const ev = evaluate([row(A, "08:00", "10:00"), row(A, "12:01", "14:00")]);
    expect(ev.gapBreakMin).toBe(0);
  });

  it("overlapping rows (negative gap) and adjacent rows (gap 0) count nothing", () => {
    expect(evaluate([row(A, "08:00", "12:00"), row(A, "11:30", "15:00")]).gapBreakMin).toBe(0);
    expect(evaluate([row(A, "08:00", "12:00"), row(A, "12:00", "15:00")]).gapBreakMin).toBe(0);
    expect(evaluate([row(A, "08:00", "12:00"), row(B, "11:30", "15:00")]).totalBreakMin).toBe(0);
  });

  it("crossSalon and the sorted distinct salon ids", () => {
    const ev = evaluate([
      row(B, "08:00", "10:00"),
      row(A, "10:30", "12:00"),
      row(B, "12:30", "14:00"),
    ]);
    expect(ev.crossSalon).toBe(true);
    expect(ev.salonIds).toEqual([A, B]);
    expect(evaluate([row(A, "08:00", "10:00"), row(A, "10:30", "12:00")]).crossSalon).toBe(false);
  });
});

describe("D-04/D-05: recorded day breaks count only inside a gap and never reduce working time", () => {
  it("clips a day break to the cross-salon gap", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(B, "12:30", "16:30")],
      [brk("12:05", "12:35")],
    );
    expect(ev.dayBreakMin).toBe(25);
  });

  it("merges overlapping day breaks in one gap (union, no double count)", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(B, "12:45", "16:30")],
      [brk("12:00", "12:20"), brk("12:10", "12:30")],
    );
    expect(ev.dayBreakMin).toBe(30);
  });

  it("counts two disjoint day breaks of one gap separately", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(B, "13:00", "16:30")],
      [brk("12:00", "12:10"), brk("12:30", "12:50")],
    );
    expect(ev.dayBreakMin).toBe(30);
  });

  it("adds nothing for a day break inside a same-salon gap of at most 120 minutes", () => {
    const rows = [row(A, "08:00", "12:00"), row(A, "12:30", "16:30")];
    const without = evaluate(rows);
    const withBreak = evaluate(rows, [brk("12:05", "12:25")]);
    expect(withBreak.dayBreakMin).toBe(0);
    expect(withBreak.totalBreakMin).toBe(without.totalBreakMin);
  });

  it("counts a day break inside a same-salon gap of 180 minutes in full", () => {
    const ev = evaluate(
      [row(A, "08:00", "10:00"), row(A, "13:00", "16:30")],
      [brk("11:00", "11:40")],
    );
    expect(ev.dayBreakMin).toBe(40);
  });

  it("counts a day break outside every gap as 0", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(B, "12:30", "16:30")],
      [brk("09:00", "09:30"), brk("17:00", "17:30")],
    );
    expect(ev.dayBreakMin).toBe(0);
  });

  it("netWorkedMin is identical with and without day breaks", () => {
    const rows = [row(A, "08:00", "12:00"), row(B, "12:30", "16:30")];
    const a = evaluate(rows);
    const b = evaluate(rows, [brk("12:00", "12:30")]);
    expect(b.netWorkedMin).toBe(a.netWorkedMin);
    expect(a.netWorkedMin).toBe(480);
  });

  it("80-AC3 via day break: a 30-minute day break between the salons clears the shortfall", () => {
    const rows = [row(A, "08:00", "12:00"), row(B, "12:30", "16:30")];
    expect(evaluate(rows).breakShortfall).toBe(true);
    expect(evaluate(rows, [brk("12:00", "12:30")]).breakShortfall).toBe(false);
  });
});

describe("§ 4 thresholds are strict", () => {
  const net = (extraMs: number, minutes: number) => {
    const end = new Date(t("08:00").getTime() + minutes * 60000 + extraMs);
    return evaluate([{ ...row(A, "08:00", "08:01"), endTime: end }]);
  };

  it("360 minutes needs no break", () => {
    expect(net(0, 360).requiredBreakMin).toBe(0);
  });
  it("360 minutes + 1 ms needs 30", () => {
    expect(net(1, 360).requiredBreakMin).toBe(30);
  });
  it("540 minutes needs 30", () => {
    expect(net(0, 540).requiredBreakMin).toBe(30);
  });
  it("540 minutes + 1 ms needs 45", () => {
    expect(net(1, 540).requiredBreakMin).toBe(45);
  });
});

describe("D-16: entry-level WAIVED", () => {
  it("does not waive a cross-salon day", () => {
    const ev = evaluate([
      row(A, "08:00", "12:00", { breakStatus: "WAIVED" }),
      row(B, "12:30", "16:30"),
    ]);
    expect(ev.waived).toBe(false);
  });

  it("still waives a single-salon day with several entries", () => {
    const ev = evaluate([
      row(A, "08:00", "12:00", { breakStatus: "WAIVED" }),
      row(A, "12:30", "16:30"),
    ]);
    expect(ev.waived).toBe(true);
  });

  it("waives a single entry", () => {
    expect(evaluate([row(A, "08:00", "16:00", { breakStatus: "WAIVED" })]).waived).toBe(true);
    expect(evaluate([row(A, "08:00", "16:00")]).waived).toBe(false);
  });
});

describe("D-17: an acknowledgement is bound to the current day state", () => {
  const rows = [row(A, "08:00", "12:00", { id: "e-1" }), row(B, "12:30", "16:30", { id: "e-2" })];
  const current = evaluate(rows).snapshot;

  it("a matching snapshot acknowledges and waives a cross-salon day", () => {
    const ev = evaluate(rows, [], [{ snapshot: { ...current } }]);
    expect(ev.acknowledged).toBe(true);
    expect(ev.waived).toBe(true);
  });

  it("a snapshot differing in one field no longer matches", () => {
    const variants: unknown[] = [
      { ...current, entryIds: ["e-1", "e-3"] },
      { ...current, salonIds: [A, "salon-c"] },
      { ...current, netWorkedMin: current.netWorkedMin + 1 },
      { ...current, totalBreakMin: current.totalBreakMin + 1 },
    ];
    for (const snapshot of variants) {
      const ev = evaluate(rows, [], [{ snapshot }]);
      expect(ev.acknowledged).toBe(false);
      expect(ev.waived).toBe(false);
    }
  });

  it("a malformed snapshot is never current", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      "snapshot",
      42,
      [],
      {},
      { entryIds: ["e-1", "e-2"], salonIds: [A, B], netWorkedMin: 480 },
      { ...current, netWorkedMin: "480" },
      { ...current, entryIds: "e-1,e-2" },
    ];
    for (const snapshot of malformed) {
      expect(isAckSnapshotCurrent(snapshot, current)).toBe(false);
    }
  });

  it("an acknowledgement on a single-salon day does nothing", () => {
    const single = [
      row(A, "08:00", "12:00", { id: "s-1" }),
      row(A, "12:30", "16:30", { id: "s-2" }),
    ];
    const snap = evaluate(single).snapshot;
    const ev = evaluate(single, [], [{ snapshot: snap }]);
    expect(ev.acknowledged).toBe(false);
  });

  it("the snapshot has sorted entry and salon ids", () => {
    const ev = evaluate([
      row(B, "08:00", "10:00", { id: "z-9" }),
      row(A, "10:30", "12:00", { id: "a-1" }),
      row(B, "12:30", "14:00", { id: "m-5" }),
    ]);
    expect(ev.snapshot.entryIds).toEqual(["a-1", "m-5", "z-9"]);
    expect(ev.snapshot.salonIds).toEqual([A, B]);
  });

  it("the snapshot reflects a recorded day break (totalBreakMin changes)", () => {
    const withBreak = evaluate(rows, [brk("12:00", "12:30")]).snapshot;
    expect(withBreak.totalBreakMin).toBe(current.totalBreakMin + 30);
    const stale: DaySnapshot = current;
    expect(isAckSnapshotCurrent(stale, withBreak)).toBe(false);
  });
});

describe("D-18: the § 3 day sum is never downgraded by an acknowledgement", () => {
  it("an acknowledged cross-salon 11 h day keeps MAX_DAILY_EXCEEDED as an error and waives § 4 only", () => {
    const rows = [row(A, "06:00", "12:00", { id: "x-1" }), row(B, "12:30", "17:30", { id: "x-2" })];
    const snapshot = evaluate(rows).snapshot;
    const ev = evaluate(rows, [], [{ snapshot }]);
    const warnings = dayLimitWarnings(ev, 0);
    const max = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
    const short = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
    expect(max).toBeDefined();
    expect(max!.severity).toBe("error");
    expect(max!.crossSalon).toBe(true);
    expect(short).toBeDefined();
    expect(short!.waived).toBe(true);
    expect(short!.severity).toBe("warning");
  });

  it("the Berufsschule minutes of the day count toward the § 3 sum", () => {
    const ev = evaluate([row(A, "08:00", "12:00"), row(B, "12:30", "14:00")]);
    expect(dayLimitWarnings(ev, 0).some((w) => w.code === "MAX_DAILY_EXCEEDED")).toBe(false);
    expect(dayLimitWarnings(ev, 570).some((w) => w.code === "MAX_DAILY_EXCEEDED")).toBe(true);
  });
});

describe("D-05: findGapForInterval locates the gap a day break lies in", () => {
  const rows = [
    row(A, "08:00", "12:00", { id: "g-1" }),
    row(B, "12:30", "16:00", { id: "g-2" }),
    row(B, "17:00", "18:00", { id: "g-3" }),
  ];

  it("an interval inside a gap yields the neighbouring entries and the salon crossing", () => {
    expect(findGapForInterval(rows, brk("12:05", "12:25"))).toEqual({
      previousEntryId: "g-1",
      nextEntryId: "g-2",
      crossSalon: true,
    });
    expect(findGapForInterval(rows, brk("16:10", "16:50"))).toEqual({
      previousEntryId: "g-2",
      nextEntryId: "g-3",
      crossSalon: false,
    });
  });

  it("touching the gap boundaries is allowed", () => {
    expect(findGapForInterval(rows, brk("12:00", "12:30"))).not.toBeNull();
  });

  it("an interval overlapping an entry is rejected", () => {
    expect(findGapForInterval(rows, brk("11:50", "12:20"))).toBeNull();
    expect(findGapForInterval(rows, brk("12:20", "12:40"))).toBeNull();
  });

  it("an interval spanning across an entry is rejected", () => {
    expect(findGapForInterval(rows, brk("12:10", "16:30"))).toBeNull();
  });

  it("an interval before the first or after the last entry is rejected", () => {
    expect(findGapForInterval(rows, brk("06:00", "07:00"))).toBeNull();
    expect(findGapForInterval(rows, brk("19:00", "19:30"))).toBeNull();
  });

  it("a single entry has no gap", () => {
    expect(findGapForInterval([rows[0]], brk("12:00", "12:30"))).toBeNull();
  });

  it("a zero-length or reversed interval is rejected", () => {
    expect(findGapForInterval(rows, brk("12:10", "12:10"))).toBeNull();
    expect(findGapForInterval(rows, brk("12:20", "12:10"))).toBeNull();
  });

  it("a gap that is not positive (adjacent entries) holds no interval", () => {
    const adjacent = [
      row(A, "08:00", "12:00", { id: "h-1" }),
      row(B, "12:00", "16:00", { id: "h-2" }),
    ];
    expect(findGapForInterval(adjacent, brk("12:00", "12:10"))).toBeNull();
  });
});

describe("D-05: intervalsOverlap is half-open", () => {
  it("adjacent intervals do not overlap", () => {
    expect(intervalsOverlap(brk("12:00", "12:30"), brk("12:30", "13:00"))).toBe(false);
    expect(intervalsOverlap(brk("12:30", "13:00"), brk("12:00", "12:30"))).toBe(false);
  });

  it("nested and partially overlapping intervals do", () => {
    expect(intervalsOverlap(brk("12:00", "13:00"), brk("12:10", "12:20"))).toBe(true);
    expect(intervalsOverlap(brk("12:10", "12:20"), brk("12:00", "13:00"))).toBe(true);
    expect(intervalsOverlap(brk("12:00", "12:40"), brk("12:30", "13:00"))).toBe(true);
  });

  it("disjoint intervals do not", () => {
    expect(intervalsOverlap(brk("08:00", "09:00"), brk("10:00", "11:00"))).toBe(false);
  });
});
