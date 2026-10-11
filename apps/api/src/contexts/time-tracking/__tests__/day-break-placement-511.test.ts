// Issue #511 — § 4 ArbZG Satz 2 and Satz 3 (and § 11 JArbSchG for minors) on the D-22 interval view
// of the day kernel. Decisions D-01 .. D-09 (CONTEXT.md). DB-free: every instant is a fixed UTC
// instant on 2026-03-10, there is no clock and no randomness.

import { describe, it, expect } from "vitest";
import {
  evaluateDayBreaks,
  hasAckableFinding,
  isAckSnapshotCurrent,
  type DayBreakRow,
  type DayBreakInterval,
  type DayBreakEvaluation,
} from "../day-break-rule";
import { BREAK_REGIMES, type BreakRegime, type BreakRegimeRules } from "../break-regime";
import { evaluatePlacement, placementKey } from "../day-break-placement";

const A = "salon-a";
const B = "salon-b";

function t(hhmm: string, extraMs = 0, dayOffset = 0): Date {
  const base = new Date(`2026-03-10T${hhmm}:00.000Z`).getTime();
  return new Date(base + dayOffset * 86_400_000 + extraMs);
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
    endDayOffset?: number;
    breakStatus?: string;
  } = {},
): DayBreakRow {
  seq += 1;
  const r: DayBreakRow = {
    id: opts.id ?? `e${String(seq).padStart(3, "0")}`,
    startTime: t(start),
    endTime: t(end, opts.endExtraMs ?? 0, opts.endDayOffset ?? 0),
    breakMinutes: opts.breakMinutes ?? 0,
    breakStatus: opts.breakStatus ?? "CONFIRMED",
    salonId,
  };
  if (opts.breaks !== undefined) r.breaks = opts.breaks;
  return r;
}

function brk(start: string, end: string, endExtraMs = 0): DayBreakInterval {
  return { startTime: t(start), endTime: t(end, endExtraMs) };
}

function evaluate(
  rows: DayBreakRow[],
  dayBreaks: DayBreakInterval[] = [],
  regime?: BreakRegime,
): DayBreakEvaluation {
  return evaluateDayBreaks(
    regime === undefined ? { rows, dayBreaks, acks: [] } : { rows, dayBreaks, acks: [], regime },
  );
}

function codes(ev: DayBreakEvaluation): string[] {
  return ev.placement.findings.map((f) => f.code).sort();
}

describe("Satz 3 — no more than six hours in a row without a Ruhepause (D-03)", () => {
  it("a 361-minute block before a qualifying break is BREAK_TOO_LATE with the exact interval", () => {
    const e = row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("14:01", "14:31")] });
    const ev = evaluate([e]);
    const late = ev.placement.findings.filter((f) => f.code === "BREAK_TOO_LATE");
    expect(late).toHaveLength(1);
    expect(late[0].certainty).toBe("VIOLATION");
    expect(late[0].legalBasis).toBe("§ 4 S. 3 ArbZG");
    expect(late[0].intervals).toEqual([{ startTime: t("08:00"), endTime: t("14:01") }]);
  });

  it("a block of exactly 360 minutes is allowed", () => {
    const e = row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("14:00", "14:30")] });
    expect(codes(evaluate([e]))).not.toContain("BREAK_TOO_LATE");
  });

  it("3 h + a 10-minute interruption + 3 h is ONE 370-minute block", () => {
    const e = row(A, "08:00", "14:10", { breakMinutes: 10, breaks: [brk("11:00", "11:10")] });
    const ev = evaluate([e]);
    expect(ev.placement.blocks).toHaveLength(1);
    expect(ev.placement.blocks[0].minutes).toBe(370);
    expect(codes(ev)).toContain("BREAK_TOO_LATE");
  });

  it("a break touching the start of the day does not split the block (D-04)", () => {
    const e = row(A, "08:00", "15:30", { breakMinutes: 30, breaks: [brk("08:00", "08:30")] });
    const ev = evaluate([e]);
    expect(ev.placement.blocks).toHaveLength(1);
    expect(ev.placement.blocks[0].minutes).toBe(450);
    expect(codes(ev)).toContain("BREAK_TOO_LATE");
  });

  it("same-salon entries separated by more than 120 minutes are two blocks (D-16)", () => {
    const ev = evaluate([row(A, "08:00", "12:00"), row(A, "14:30", "18:00")]);
    expect(ev.placement.blocks.map((b) => b.minutes)).toEqual([240, 210]);
    expect(codes(ev)).not.toContain("BREAK_TOO_LATE");
  });
});

describe("regime input (D-05)", () => {
  it("evaluates as ARBZG_4 without a regime", () => {
    const ev = evaluate([row(A, "08:00", "14:31", { breakMinutes: 0 })]);
    expect(ev.placement.regime).toBe("ARBZG_4");
    expect(codes(ev)).toContain("BREAK_TOO_LATE");
  });

  it("JARBSCHG_11 flags a 4:31 block, ARBZG_4 does not", () => {
    const e = row(A, "08:00", "12:31", { breakMinutes: 0 });
    expect(codes(evaluate([e], [], "JARBSCHG_11"))).toContain("BREAK_TOO_LATE");
    expect(codes(evaluate([e], [], "ARBZG_4"))).not.toContain("BREAK_TOO_LATE");
    const late = evaluate([e], [], "JARBSCHG_11").placement.findings.find(
      (f) => f.code === "BREAK_TOO_LATE",
    );
    expect(late?.legalBasis).toBe("§ 11 Abs. 2 S. 2 JArbSchG");
  });

  it("requiredBreakMin for the default regime equals the legacy expression", () => {
    for (const hours of [0, 5, 6, 7, 9, 10]) {
      const end = `${String(8 + hours).padStart(2, "0")}:00`;
      const ev = evaluate([row(A, "08:00", end, { breakMinutes: 0 })]);
      const w = hours * 60;
      expect(ev.requiredBreakMin).toBe(w > 540 ? 45 : w > 360 ? 30 : 0);
    }
  });
});

type Finding = [string, string | null];

function findings(ev: DayBreakEvaluation): Finding[] {
  return ev.placement.findings.map((f) => [f.code, f.certainty] as Finding).sort(cmpFinding);
}

function cmpFinding(a: Finding, b: Finding): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

describe("D-01 — a Ruhepause lasts at least 15:00, compared in epoch milliseconds", () => {
  it("14 min 59.999 s is no Ruhepause and does not split the block", () => {
    const e = row(A, "08:00", "15:30", {
      breakMinutes: 15,
      breaks: [brk("12:00", "12:14", 59_999)],
    });
    const ev = evaluate([e]);
    expect(ev.placement.restPeriods.map((p) => p.status)).toEqual(["TOO_SHORT"]);
    expect(codes(ev)).toContain("BREAK_TOO_LATE");
  });

  it("exactly 15:00 is a Ruhepause and splits the block", () => {
    const e = row(A, "08:00", "15:30", { breakMinutes: 15, breaks: [brk("12:00", "12:15")] });
    const ev = evaluate([e]);
    expect(ev.placement.restPeriods.map((p) => p.status)).toEqual(["QUALIFYING"]);
    expect(codes(ev)).not.toContain("BREAK_TOO_LATE");
  });
});

describe("D-02 / AK-1 — short segments are working time for the compliance figure", () => {
  const sevenHours = (): DayBreakRow =>
    row(A, "08:00", "15:00", {
      breakMinutes: 30,
      breaks: [brk("10:00", "10:10"), brk("12:00", "12:10"), brk("14:00", "14:10")],
    });

  it("three 10-minute breaks at 7 h presence keep the legacy sum and fail Satz 2", () => {
    const ev = evaluate([sevenHours()]);
    expect(ev.breakShortfall).toBe(false);
    expect(ev.placement.compliance).toMatchObject({
      workMin: 420,
      qualifyingMin: 0,
      requiredMin: 30,
      shortfall: true,
    });
    const short = ev.placement.findings.find((f) => f.code === "BREAK_SEGMENT_TOO_SHORT");
    expect(short).toBeDefined();
    expect(short?.certainty).toBe("VIOLATION");
    expect(short?.legalBasis).toBe("§ 4 S. 2 ArbZG");
    expect(short?.nonCounted).toEqual({ tooShort: 3, edge: 0, outsideWindow: 0 });
    expect(short?.requiredMin).toBe(30);
    expect(short?.qualifyingMin).toBe(0);
    // The short breaks do not split the 420-minute block (D-03).
    expect(codes(ev)).toContain("BREAK_TOO_LATE");
  });

  it("exactly 360 minutes of compliance work needs no break, one millisecond more needs 30", () => {
    const exact = evaluate([row(A, "08:00", "14:00", { breakMinutes: 0 })]);
    expect(exact.placement.compliance.requiredMin).toBe(0);
    expect(codes(exact)).toEqual([]);
    const over = evaluate([row(A, "08:00", "14:00", { breakMinutes: 0, endExtraMs: 1 })]);
    expect(over.placement.compliance.requiredMin).toBe(30);
  });

  it("does not repeat the Satz-1 shortfall that BREAK_TOO_SHORT already reports", () => {
    const e = row(A, "08:00", "15:00", { breakMinutes: 10, breaks: [brk("12:00", "12:10")] });
    const ev = evaluate([e]);
    expect(ev.breakShortfall).toBe(true);
    expect(codes(ev)).not.toContain("BREAK_SEGMENT_TOO_SHORT");
  });

  it("a break touching the start of the day is reported as not counted (edge)", () => {
    const e = row(A, "08:00", "14:20", { breakMinutes: 20, breaks: [brk("08:00", "08:20")] });
    const short = evaluate([e]).placement.findings.find(
      (f) => f.code === "BREAK_SEGMENT_TOO_SHORT",
    );
    expect(short?.nonCounted).toEqual({ tooShort: 0, edge: 1, outsideWindow: 0 });
  });
});

describe("AK-2 — Satz 1 met never suppresses Satz 3", () => {
  it("08:00-15:30 with a 30-minute break at 14:30 meets Satz 1 and still has a 390-minute block", () => {
    const e = row(A, "08:00", "15:30", { breakMinutes: 30, breaks: [brk("14:30", "15:00")] });
    const ev = evaluate([e]);
    expect(ev.breakShortfall).toBe(false);
    expect(ev.placement.compliance.shortfall).toBe(false);
    const late = ev.placement.findings.find((f) => f.code === "BREAK_TOO_LATE");
    expect(late?.longestBlockMin).toBe(390);
    expect(late?.intervals).toEqual([{ startTime: t("08:00"), endTime: t("14:30") }]);
  });
});

describe("D-05 — minors (§ 11 JArbSchG)", () => {
  const minor = (rows: DayBreakRow[], dayBreaks: DayBreakInterval[] = []) =>
    evaluate(rows, dayBreaks, "JARBSCHG_11");

  it("a 270-minute block is allowed, 271 minutes is BREAK_TOO_LATE", () => {
    expect(codes(minor([row(A, "08:00", "12:30")]))).toEqual([]);
    expect(codes(minor([row(A, "08:00", "12:31")]))).toEqual(["BREAK_TOO_LATE"]);
  });

  it("more than 360 minutes of work require 60 minutes", () => {
    const e = row(A, "08:00", "14:30", {
      breakMinutes: 30,
      breaks: [brk("11:00", "11:30")],
    });
    const ev = minor([e]);
    expect(ev.requiredBreakMin).toBe(30);
    // 390 min presence - 30 = 360 working minutes: the 60-minute duty starts only above 360.
    const longer = minor([
      row(A, "08:00", "14:31", { breakMinutes: 30, breaks: [brk("11:00", "11:30")] }),
    ]);
    expect(longer.requiredBreakMin).toBe(60);
    expect(longer.placement.compliance).toMatchObject({ requiredMin: 60, shortfall: true });
  });

  it("a break starting 59 minutes after the start is outside the window and not counted", () => {
    const inside = row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("09:00", "09:30")] });
    const outside = row(A, "08:00", "15:00", {
      breakMinutes: 30,
      breaks: [brk("08:59", "09:29")],
    });
    expect(minor([inside]).placement.restPeriods.map((p) => p.status)).toEqual(["QUALIFYING"]);
    const ev = minor([outside]);
    expect(ev.placement.restPeriods.map((p) => p.status)).toEqual(["OUTSIDE_WINDOW"]);
    const w = ev.placement.findings.find((f) => f.code === "BREAK_OUTSIDE_WINDOW");
    expect(w?.legalBasis).toBe("§ 11 Abs. 2 S. 1 JArbSchG");
  });

  it("a break ending 59 minutes before the end is outside the window", () => {
    const e = row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("13:31", "14:01")] });
    expect(minor([e]).placement.restPeriods.map((p) => p.status)).toEqual(["OUTSIDE_WINDOW"]);
    const ok = row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("13:30", "14:00")] });
    expect(minor([ok]).placement.restPeriods.map((p) => p.status)).toEqual(["QUALIFYING"]);
  });

  it("a same-salon gap above two hours is never OUTSIDE_WINDOW (split shift)", () => {
    const ev = minor([row(A, "08:00", "10:00"), row(A, "13:00", "15:00")]);
    expect(ev.placement.restPeriods.map((p) => [p.separator, p.status])).toEqual([
      [true, "QUALIFYING"],
    ]);
    expect(codes(ev)).toEqual([]);
  });
});

describe("D-06 / AK-3 — sum-only breaks have no position", () => {
  it("a single 8 h entry with 30 stored minutes and no Break rows yields only the hint", () => {
    const ev = evaluate([row(A, "08:00", "16:00", { breakMinutes: 30 })]);
    expect(findings(ev)).toEqual([["BREAK_POSITION_UNKNOWN", null]]);
    expect(ev.placement.positionUnknown).toBe(true);
  });

  it("an insufficient sum reports the unchanged legacy shortfall and no placement finding", () => {
    const ev = evaluate([row(A, "08:00", "16:00", { breakMinutes: 20 })]);
    expect(ev.breakShortfall).toBe(true);
    expect(ev.placement.findings).toEqual([]);
    expect(ev.placement.positionUnknown).toBe(false);
  });

  it("a short entry with a stored break has nothing to report", () => {
    const ev = evaluate([row(A, "08:00", "13:00", { breakMinutes: 30 })]);
    expect(ev.placement.findings).toEqual([]);
    expect(ev.placement.positionUnknown).toBe(false);
  });

  it("D-06a: no break at all on an 8 h entry is a certain Satz-3 violation", () => {
    const ev = evaluate([row(A, "08:00", "16:00", { breakMinutes: 0 })]);
    expect(findings(ev)).toEqual([["BREAK_TOO_LATE", "VIOLATION"]]);
  });

  it("second-precision Break rows with a rounded stored total are not unplaced minutes", () => {
    // stored minutes are the rounded total of the Break rows (consolidate.ts): 14.5 min -> 15
    const e = row(A, "08:00", "15:30", {
      breakMinutes: 15,
      breaks: [brk("12:00", "12:14", 30_000)],
    });
    const ev = evaluate([e]);
    expect(ev.placement.positionUnknown).toBe(false);
    expect(codes(ev)).toContain("BREAK_TOO_LATE");
  });
});

describe("D-07 — a gap between salons: worst and best bound", () => {
  it("08-12 in A and 15-19 in B is UNCLEAR", () => {
    const ev = evaluate([row(A, "08:00", "12:00"), row(B, "15:00", "19:00")]);
    expect(findings(ev)).toEqual([["BREAK_TOO_LATE", "UNCLEAR"]]);
  });

  it("a recorded day break of 12:30-14:30 resolves it", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(B, "15:00", "19:00")],
      [brk("12:30", "14:30")],
    );
    expect(ev.placement.findings).toEqual([]);
  });

  it("a gap of 10 minutes can never be a Ruhepause: VIOLATION", () => {
    const ev = evaluate([row(A, "08:00", "12:00"), row(B, "12:10", "16:10")]);
    expect(findings(ev)).toEqual([["BREAK_TOO_LATE", "VIOLATION"]]);
  });
});

describe("D-09 — cross-midnight", () => {
  it("22:00 to 06:00 the next day is one continuous 480-minute block", () => {
    const ev = evaluate([row(A, "22:00", "06:00", { endDayOffset: 1 })]);
    expect(ev.placement.blocks.map((b) => b.minutes)).toEqual([480]);
    expect(codes(ev)).toEqual(["BREAK_TOO_LATE"]);
  });
});

describe("D-11 — the break status changes no finding", () => {
  it("AUTO, CONFIRMED and WAIVED produce identical findings", () => {
    const mk = (breakStatus: string) =>
      evaluate([
        row(A, "08:00", "15:00", {
          breakMinutes: 30,
          breakStatus,
          breaks: [brk("10:00", "10:10"), brk("12:00", "12:10"), brk("14:00", "14:10")],
        }),
      ]).placement.findings;
    expect(mk("AUTO")).toEqual(mk("CONFIRMED"));
    expect(mk("WAIVED")).toEqual(mk("CONFIRMED"));
  });
});

describe("placementKey", () => {
  it("is empty without a certain finding and stable for the same finding", () => {
    expect(placementKey(evaluate([row(A, "08:00", "13:00", { breakMinutes: 30 })]).placement)).toBe(
      "",
    );
    const hint = evaluate([row(A, "08:00", "16:00", { breakMinutes: 30 })]);
    expect(placementKey(hint.placement)).toBe("");
    const mk = () => evaluate([row(A, "08:00", "16:00", { breakMinutes: 0, id: "k1" })]);
    expect(placementKey(mk().placement)).not.toBe("");
    expect(placementKey(mk().placement)).toBe(placementKey(mk().placement));
  });
});

// ── Acknowledgement and the ackable predicate (D-12, A8) ──────────────────────────────────────

describe("D-12 / A8 — the snapshot sees the placement", () => {
  const tooLateDay = (breakStart: string, breakEnd: string, id = "k1"): DayBreakRow =>
    row(A, "08:00", "15:00", { id, breakMinutes: 30, breaks: [brk(breakStart, breakEnd)] });

  it("stores a placement key only when the day has a finding with a certainty", () => {
    const withFinding = evaluate([tooLateDay("14:01", "14:31")]).snapshot;
    expect(typeof withFinding.placementKey).toBe("string");
    expect(withFinding.placementKey).not.toBe("");
    const clean = evaluate([row(A, "08:00", "12:00", { id: "c1" })]).snapshot;
    expect("placementKey" in clean).toBe(false);
    expect(Object.keys(clean).sort()).toEqual([
      "entryIds",
      "netWorkedMin",
      "salonIds",
      "totalBreakMin",
    ]);
    const hint = evaluate([row(A, "08:00", "16:00", { id: "h1", breakMinutes: 30 })]).snapshot;
    expect("placementKey" in hint).toBe(false);
  });

  it("a current acknowledgement acknowledges and waives a single-salon day with a finding", () => {
    const rows = [tooLateDay("14:01", "14:31")];
    const snapshot = evaluate(rows).snapshot;
    const ev = evaluateDayBreaks({ rows, dayBreaks: [], acks: [{ snapshot }] });
    expect(ev.acknowledged).toBe(true);
    expect(ev.waived).toBe(true);
    // The findings themselves stay (a waiver documents, it does not make the day compliant).
    expect(codes(ev)).toContain("BREAK_TOO_LATE");
  });

  it("moving a break by ten minutes with identical totals makes the acknowledgement stale", () => {
    const snapshot = evaluate([tooLateDay("14:01", "14:31")]).snapshot;
    const moved = [tooLateDay("14:11", "14:41")];
    expect(evaluate(moved).snapshot.netWorkedMin).toBe(snapshot.netWorkedMin);
    expect(evaluate(moved).snapshot.totalBreakMin).toBe(snapshot.totalBreakMin);
    const ev = evaluateDayBreaks({ rows: moved, dayBreaks: [], acks: [{ snapshot }] });
    expect(ev.acknowledged).toBe(false);
    expect(ev.waived).toBe(false);
  });

  it("an acknowledgement stored without a key stays current on a day without findings", () => {
    const rows = [row(A, "08:00", "12:00", { id: "x1" }), row(B, "15:00", "19:00", { id: "x2" })];
    const dayBreaks = [brk("12:30", "14:30")];
    const current = evaluate(rows, dayBreaks).snapshot;
    expect("placementKey" in current).toBe(false);
    const ev = evaluateDayBreaks({ rows, dayBreaks, acks: [{ snapshot: { ...current } }] });
    expect(ev.acknowledged).toBe(true);
  });

  it("an acknowledgement stored without a key is stale once the day has a finding", () => {
    const rows = [tooLateDay("14:01", "14:31")];
    const legacyShape: Record<string, unknown> = { ...evaluate(rows).snapshot };
    delete legacyShape.placementKey;
    const ev = evaluateDayBreaks({ rows, dayBreaks: [], acks: [{ snapshot: legacyShape }] });
    expect(ev.acknowledged).toBe(false);
  });

  it("a placement key that is not a string is never current", () => {
    const current = evaluate([tooLateDay("14:01", "14:31")]).snapshot;
    for (const bad of [42, null, ["a"], {}, true]) {
      expect(isAckSnapshotCurrent({ ...current, placementKey: bad }, current)).toBe(false);
    }
    expect(isAckSnapshotCurrent({ ...current }, current)).toBe(true);
  });

  it("an acknowledgement does nothing on a single-salon day without findings", () => {
    const rows = [row(A, "08:00", "12:00", { id: "n1" })];
    const snapshot = evaluate(rows).snapshot;
    expect(evaluateDayBreaks({ rows, dayBreaks: [], acks: [{ snapshot }] }).acknowledged).toBe(
      false,
    );
  });
});

describe("D-12 — hasAckableFinding is the one predicate", () => {
  it("is true for any placement finding with a certainty", () => {
    expect(hasAckableFinding(evaluate([row(A, "08:00", "16:00")]))).toBe(true);
    const unclear = evaluate([row(A, "08:00", "12:00"), row(B, "15:00", "19:00")]);
    expect(findings(unclear)).toEqual([["BREAK_TOO_LATE", "UNCLEAR"]]);
    expect(hasAckableFinding(unclear)).toBe(true);
  });

  it("is true for a cross-salon Satz-1 shortfall even without a placement finding", () => {
    const ev = evaluate(
      [row(A, "08:00", "12:00"), row(B, "12:20", "18:20")],
      [brk("12:00", "12:20")],
    );
    expect(ev.placement.findings).toEqual([]);
    expect(ev.crossSalon && ev.breakShortfall).toBe(true);
    expect(hasAckableFinding(ev)).toBe(true);
  });

  it("is false for a hint-only day, a finding-free day and a single-salon Satz-1 shortfall", () => {
    expect(hasAckableFinding(evaluate([row(A, "08:00", "16:00", { breakMinutes: 30 })]))).toBe(
      false,
    );
    expect(hasAckableFinding(evaluate([row(A, "08:00", "12:00")]))).toBe(false);
    const shortfallOnly = evaluate([
      row(A, "08:00", "15:00", { breakMinutes: 20, breaks: [brk("12:00", "12:20")] }),
    ]);
    expect(shortfallOnly.breakShortfall).toBe(true);
    expect(shortfallOnly.placement.findings).toEqual([]);
    expect(hasAckableFinding(shortfallOnly)).toBe(false);
  });

  it("an acknowledged day stays ackable so the acknowledgement can be revoked", () => {
    const rows = [row(A, "08:00", "16:00", { id: "r1" })];
    const snapshot = evaluate(rows).snapshot;
    const ev = evaluateDayBreaks({ rows, dayBreaks: [], acks: [{ snapshot }] });
    expect(ev.acknowledged).toBe(true);
    expect(hasAckableFinding(ev)).toBe(true);
  });
});

// ── Boundary matrix and control run (AK-7) ────────────────────────────────────────────────────

interface MatrixCase {
  name: string;
  regime: BreakRegime;
  rows: DayBreakRow[];
  dayBreaks?: DayBreakInterval[];
  expected: Finding[];
}

function matrix(): MatrixCase[] {
  const L = "BREAK_TOO_LATE";
  const S = "BREAK_SEGMENT_TOO_SHORT";
  const W = "BREAK_OUTSIDE_WINDOW";
  const H = "BREAK_POSITION_UNKNOWN";
  const V = "VIOLATION";
  const U = "UNCLEAR";
  const adult = (
    name: string,
    rows: DayBreakRow[],
    expected: Finding[],
    dayBreaks?: DayBreakInterval[],
  ) => ({ name, regime: "ARBZG_4" as const, rows, dayBreaks, expected }) satisfies MatrixCase;
  const minor = (name: string, rows: DayBreakRow[], expected: Finding[]) =>
    ({ name, regime: "JARBSCHG_11" as const, rows, expected }) satisfies MatrixCase;
  return [
    adult(
      "block 360 exactly",
      [row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("14:00", "14:30")] })],
      [],
    ),
    adult(
      "block 361",
      [row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("14:01", "14:31")] })],
      [[L, V]],
    ),
    adult(
      "segment 15:00 exactly",
      [row(A, "08:00", "15:30", { breakMinutes: 15, breaks: [brk("12:00", "12:15")] })],
      [],
    ),
    adult(
      "segment 14:59.999",
      [row(A, "08:00", "15:30", { breakMinutes: 15, breaks: [brk("12:00", "12:14", 59_999)] })],
      [[L, V]],
    ),
    adult(
      "break touching the start",
      [row(A, "08:00", "14:20", { breakMinutes: 20, breaks: [brk("08:00", "08:20")] })],
      [
        [L, V],
        [S, V],
      ],
    ),
    adult(
      "break touching the end",
      [row(A, "08:00", "14:20", { breakMinutes: 20, breaks: [brk("14:00", "14:20")] })],
      [
        [L, V],
        [S, V],
      ],
    ),
    adult(
      "3 h + 10 min + 3 h",
      [row(A, "08:00", "14:10", { breakMinutes: 10, breaks: [brk("11:00", "11:10")] })],
      [
        [L, V],
        [S, V],
      ],
    ),
    adult(
      "three 10-minute breaks at 7 h",
      [
        row(A, "08:00", "15:00", {
          breakMinutes: 30,
          breaks: [brk("10:00", "10:10"), brk("12:00", "12:10"), brk("14:00", "14:10")],
        }),
      ],
      [
        [L, V],
        [S, V],
      ],
    ),
    adult(
      "Satz 1 met, Satz 3 violated",
      [row(A, "08:00", "15:30", { breakMinutes: 30, breaks: [brk("14:30", "15:00")] })],
      [[L, V]],
    ),
    adult("work exactly 360, no break", [row(A, "08:00", "14:00")], []),
    adult("work 360 + 1 ms, no break", [row(A, "08:00", "14:00", { endExtraMs: 1 })], [[L, V]]),
    adult(
      "same-salon gap above 120 minutes separates",
      [row(A, "08:00", "12:00"), row(A, "14:30", "18:00")],
      [],
    ),
    adult(
      "same-salon gap of 120 minutes is a rest period",
      [row(A, "08:00", "12:00"), row(A, "14:00", "18:00")],
      [],
    ),
    adult(
      "an entry break and the adjacent same-salon gap coalesce",
      [
        row(A, "08:00", "12:00", { breakMinutes: 10, breaks: [brk("11:50", "12:00")] }),
        row(A, "12:10", "17:00"),
      ],
      [],
    ),
    adult(
      "cross-salon 08-12 / 15-19",
      [row(A, "08:00", "12:00"), row(B, "15:00", "19:00")],
      [[L, U]],
    ),
    adult(
      "cross-salon with a recorded day break",
      [row(A, "08:00", "12:00"), row(B, "15:00", "19:00")],
      [],
      [brk("12:30", "14:30")],
    ),
    adult(
      "cross-salon gap of 10 minutes",
      [row(A, "08:00", "12:00"), row(B, "12:10", "16:10")],
      [[L, V]],
    ),
    adult(
      "sum-only 8 h with 30 minutes",
      [row(A, "08:00", "16:00", { breakMinutes: 30 })],
      [[H, null]],
    ),
    adult("sum-only 8 h with 20 minutes", [row(A, "08:00", "16:00", { breakMinutes: 20 })], []),
    adult("no break at all, 8 h", [row(A, "08:00", "16:00")], [[L, V]]),
    adult("cross-midnight", [row(A, "22:00", "06:00", { endDayOffset: 1 })], [[L, V]]),
    minor("minor block 270", [row(A, "08:00", "12:30")], []),
    minor("minor block 271", [row(A, "08:00", "12:31")], [[L, V]]),
    minor(
      "minor break 60 minutes after the start",
      [row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("09:00", "09:30")] })],
      [[L, V]],
    ),
    minor(
      "minor break 59 minutes after the start",
      [row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("08:59", "09:29")] })],
      [
        [L, V],
        [W, V],
      ],
    ),
    minor(
      "minor break ending 60 minutes before the end",
      [row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("13:30", "14:00")] })],
      [[L, V]],
    ),
    minor(
      "minor break ending 59 minutes before the end",
      [row(A, "08:00", "15:00", { breakMinutes: 30, breaks: [brk("13:31", "14:01")] })],
      [
        [L, V],
        [W, V],
      ],
    ),
  ];
}

/** How many matrix cases differ from their expectation when evaluated with `rules`. */
function boundaryMismatches(rules: Record<BreakRegime, BreakRegimeRules>): number {
  let mismatches = 0;
  for (const c of matrix()) {
    const base = evaluateDayBreaks({
      rows: c.rows,
      dayBreaks: c.dayBreaks ?? [],
      acks: [],
      regime: c.regime,
    });
    const placement = evaluatePlacement(
      {
        rows: c.rows,
        breakSegments: base.breakSegments,
        gaps: base.gaps,
        netWorkedMin: base.netWorkedMin,
        legacyBreakShortfall: base.breakShortfall,
      },
      rules[c.regime],
    );
    const actual = placement.findings.map((f) => [f.code, f.certainty] as Finding).sort(cmpFinding);
    const expected = [...c.expected].sort(cmpFinding);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches += 1;
  }
  return mismatches;
}

describe("AK-7 — boundary matrix and control run", () => {
  it("has a case-count floor (anti-vacuity)", () => {
    expect(matrix().length).toBeGreaterThanOrEqual(20);
  });

  it("the real rules produce no mismatch", () => {
    expect(boundaryMismatches(BREAK_REGIMES)).toBe(0);
  });

  it("a 14-minute minimum segment is noticed", () => {
    const mutated = {
      ...BREAK_REGIMES,
      ARBZG_4: { ...BREAK_REGIMES.ARBZG_4, minSegmentMs: 14 * 60_000 },
    };
    expect(boundaryMismatches(mutated)).toBeGreaterThan(0);
  });

  it("a 361-minute block limit is noticed", () => {
    const mutated = {
      ...BREAK_REGIMES,
      ARBZG_4: { ...BREAK_REGIMES.ARBZG_4, maxBlockMin: 361 },
    };
    expect(boundaryMismatches(mutated)).toBeGreaterThan(0);
  });

  it("switching the edge rule off is noticed", () => {
    const mutated = {
      ...BREAK_REGIMES,
      ARBZG_4: { ...BREAK_REGIMES.ARBZG_4, excludeEdgeTouching: false },
    };
    expect(boundaryMismatches(mutated)).toBeGreaterThan(0);
  });

  it("dropping the minors' window is noticed", () => {
    const mutated = {
      ...BREAK_REGIMES,
      JARBSCHG_11: { ...BREAK_REGIMES.JARBSCHG_11, windowMin: 0 },
    };
    expect(boundaryMismatches(mutated)).toBeGreaterThan(0);
  });
});
