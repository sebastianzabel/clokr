// Issue #511 — § 4 ArbZG Satz 2 and Satz 3 (and § 11 JArbSchG for minors) on the D-22 interval view
// of the day kernel. Decisions D-01 .. D-09 (CONTEXT.md). DB-free: every instant is a fixed UTC
// instant on 2026-03-10, there is no clock and no randomness.

import { describe, it, expect } from "vitest";
import {
  evaluateDayBreaks,
  type DayBreakRow,
  type DayBreakInterval,
  type DayBreakEvaluation,
} from "../day-break-rule";
import type { BreakRegime } from "../break-regime";

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
