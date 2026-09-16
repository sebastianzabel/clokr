/**
 * Phase 98 Plan 01 — GT-98 golden tests for the saldo chain-integrity core.
 *
 * Pure-function, DB-free: synthetic in-memory fixtures only. No database, no
 * test-app bootstrap, no ORM client — imports only the exported pure helpers
 * from ../saldo-chain-integrity.
 */
import { describe, it, expect } from "vitest";
import {
  computeInjectedDelta,
  walkSaldoChain,
  selectChainViolations,
  selectDuplicateMonthLinks,
  isTrackOnlySchedule,
  monthLabelFromPeriodEnd,
} from "../saldo-chain-integrity";

type Row = import("../saldo-chain-integrity").ChainRow;

let seq = 0;

/** "2026-07-31" -> "2026-06-30" (last day of the PREVIOUS month). */
function tzConvertedStartFor(monthEnd: string): string {
  const [yearStr, monthStr] = monthEnd.slice(0, 7).split("-");
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-based
  // Day 0 of `month` (1-based, UTC) == last day of the previous month.
  const prevLastDay = new Date(Date.UTC(year, month - 1, 0));
  return prevLastDay.toISOString().slice(0, 10);
}

function mk(
  monthEnd: string, // "2026-07-31"
  balanceMinutes: number,
  carryOver: number,
  opts: { worked?: number; expected?: number; periodStart?: string; id?: string } = {},
): Row {
  const worked = opts.worked ?? 9600;
  const expected = opts.expected ?? worked - balanceMinutes;
  return {
    id: opts.id ?? `row-${++seq}`,
    // Default = TZ-converted convention (previous month's last day).
    periodStart: new Date((opts.periodStart ?? tzConvertedStartFor(monthEnd)) + "T00:00:00Z"),
    periodEnd: new Date(monthEnd + "T00:00:00Z"),
    workedMinutes: worked,
    expectedMinutes: expected,
    balanceMinutes,
    carryOver,
  };
}

describe("GT-98 saldo chain-integrity core (pure, DB-free)", () => {
  it("GT-98a formula: computeInjectedDelta matches the fixed reference values", () => {
    expect(computeInjectedDelta({ carryOver: 100, balanceMinutes: 40 }, 60)).toBe(0);
    expect(computeInjectedDelta({ carryOver: 100, balanceMinutes: 40 }, 0)).toBe(60);
    expect(computeInjectedDelta({ carryOver: 4200, balanceMinutes: 0 }, 5216)).toBe(-1016);
  });

  it("GT-98b quiet chain: 3 well-behaved links all delta === 0, no violations", () => {
    const rows = [mk("2026-05-31", 100, 100), mk("2026-06-30", -50, 50), mk("2026-07-31", 30, 80)];
    const links = walkSaldoChain(rows);
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.delta === 0)).toBe(true);
    expect(selectChainViolations(links)).toEqual([]);
  });

  it("GT-98c injected jump: link 2 stores 5216 where the chain implies 4200 -> +1016 violation", () => {
    const rows = [
      mk("2026-05-31", 100, 100),
      mk("2026-06-30", -50, 50),
      mk("2026-07-31", 30, 80 + 1016),
    ];
    const links = walkSaldoChain(rows);
    const violations = selectChainViolations(links);
    expect(violations).toHaveLength(1);
    expect(violations[0].delta).toBe(1016);
    expect(violations[0].kind).toBe("normal");
  });

  it("GT-98d loss (negative delta): link 2 stores 4200 where the chain implies 5216 -> -1016 violation", () => {
    const rows = [
      mk("2026-05-31", 100, 100),
      mk("2026-06-30", -50, 50),
      mk("2026-07-31", 30, 80 - 1016),
    ];
    const links = walkSaldoChain(rows);
    const violations = selectChainViolations(links);
    expect(violations).toHaveLength(1);
    expect(violations[0].delta).toBe(-1016);
  });

  it("GT-98e first link: carryOverIn === 0, isFirstLink === true, delta === 0 when carryOver === balanceMinutes", () => {
    const rows = [mk("2026-07-31", 200, 200)];
    const links = walkSaldoChain(rows);
    expect(links).toHaveLength(1);
    expect(links[0].carryOverIn).toBe(0);
    expect(links[0].isFirstLink).toBe(true);
    expect(links[0].delta).toBe(0);
  });

  it("GT-98f bridge at chain start: worked/expected/balance=0, carryOver=6120 -> bridge, first link, delta=6120, is a violation", () => {
    const rows = [
      mk("2026-04-30", 0, 6120, { worked: 0, expected: 0 }),
      mk("2026-05-31", 100, 6120 + 100),
      mk("2026-06-30", 50, 6220 + 50),
    ];
    const links = walkSaldoChain(rows);
    expect(links[0].kind).toBe("bridge");
    expect(links[0].isFirstLink).toBe(true);
    expect(links[0].delta).toBe(6120);
    const violations = selectChainViolations(links);
    expect(violations).toHaveLength(1);
    expect(violations[0].rowId).toBe(links[0].rowId);
  });

  it("GT-98g bridge mid-chain: same zero-activity shape at index 2 -> bridge, isFirstLink === false", () => {
    const rows = [
      mk("2026-04-30", 100, 100),
      mk("2026-05-31", 50, 150),
      mk("2026-06-30", 0, 9999, { worked: 0, expected: 0 }),
    ];
    const links = walkSaldoChain(rows);
    expect(links[2].kind).toBe("bridge");
    expect(links[2].isFirstLink).toBe(false);
  });

  it("GT-98h month attribution: TZ-converted and legacy-naive periodStart both yield monthLabel '2026-07'", () => {
    expect(monthLabelFromPeriodEnd(new Date("2026-07-31T00:00:00Z"))).toBe("2026-07");
    const tzRow = mk("2026-07-31", 0, 0, { periodStart: "2026-06-30" });
    const legacyRow = mk("2026-07-31", 0, 0, { periodStart: "2026-07-01", id: "legacy-row" });
    expect(monthLabelFromPeriodEnd(tzRow.periodEnd)).toBe("2026-07");
    expect(monthLabelFromPeriodEnd(legacyRow.periodEnd)).toBe("2026-07");
  });

  it("GT-98i duplicate month: two active rows for the same periodEnd both kind=duplicate_month, excluded from violations", () => {
    const rows = [
      mk("2026-07-31", 100, 100, { periodStart: "2026-06-30", id: "dup-a" }),
      mk("2026-07-31", 999, 999, { periodStart: "2026-07-01", id: "dup-b" }),
    ];
    const links = walkSaldoChain(rows);
    expect(links.every((l) => l.kind === "duplicate_month")).toBe(true);
    expect(selectChainViolations(links)).toEqual([]);
    expect(selectDuplicateMonthLinks(links)).toHaveLength(2);
  });

  it("GT-98j empty chain: walkSaldoChain([]) -> [], selectChainViolations([]) -> [], no throw", () => {
    expect(walkSaldoChain([])).toEqual([]);
    expect(selectChainViolations([])).toEqual([]);
  });

  it("GT-98k TRACK_ONLY shape: carryOver=0, balanceMinutes=320, first link -> delta=-320 (DB-side filter is provably necessary)", () => {
    const rows = [mk("2026-07-31", 320, 0)];
    const links = walkSaldoChain(rows);
    expect(links[0].delta).toBe(-320);
  });

  it("GT-98l isTrackOnlySchedule: only MONTHLY_HOURS + TRACK_ONLY returns true", () => {
    expect(isTrackOnlySchedule({ type: "MONTHLY_HOURS", overtimeMode: "TRACK_ONLY" })).toBe(true);
    expect(isTrackOnlySchedule({ type: "MONTHLY_HOURS", overtimeMode: "CARRY_FORWARD" })).toBe(
      false,
    );
    expect(isTrackOnlySchedule({ type: "FIXED_SCHEDULE", overtimeMode: "TRACK_ONLY" })).toBe(false);
    expect(isTrackOnlySchedule(null)).toBe(false);
  });

  it("GT-98m mixed-convention ordering: rows using both periodStart conventions still sort into calendar order, all delta === 0", () => {
    const rows = [
      mk("2026-07-31", 30, 180, { periodStart: "2026-06-30", id: "july" }), // TZ-converted
      mk("2026-05-31", 100, 100, { periodStart: "2026-05-01", id: "may" }), // legacy-naive
      mk("2026-06-30", 50, 150, { periodStart: "2026-06-01", id: "june" }), // legacy-naive
    ];
    const links = walkSaldoChain(rows);
    expect(links.map((l) => l.rowId)).toEqual(["may", "june", "july"]);
    expect(links.every((l) => l.delta === 0)).toBe(true);
  });
});
