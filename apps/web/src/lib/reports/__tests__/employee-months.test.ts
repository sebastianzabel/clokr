// Issue #595 (D-02/D-03), Plan 595-02 - the employee's month table is built from the server
// answer only: calendar month names, a status from the closed state, open months up to now.
import { describe, it, expect } from "vitest";
import {
  buildEmployeeMonthRows,
  monthLabel,
  EMP_MONTH_NAMES,
  type SnapshotAnswerRow,
} from "../employee-months";

function monthly(year: number, month: number, balance = 60): SnapshotAnswerRow {
  return {
    periodType: "MONTHLY",
    year,
    month,
    workedMinutes: 9000 + month,
    expectedMinutes: 9000,
    balanceMinutes: balance,
  };
}

const keys = (rows: ReturnType<typeof buildEmployeeMonthRows>) =>
  rows.map((r) => `${r.year}-${r.month}:${r.status}`);

describe("buildEmployeeMonthRows", () => {
  it("lists the current open month above the closed months, newest first", () => {
    const rows = buildEmployeeMonthRows([monthly(2026, 8), monthly(2026, 9)], {
      year: 2026,
      month: 10,
    });
    expect(keys(rows)).toEqual(["2026-10:open", "2026-9:closed", "2026-8:closed"]);
  });

  it("closed rows carry the server minutes, open rows carry no figures", () => {
    const rows = buildEmployeeMonthRows([monthly(2026, 9, -30)], { year: 2026, month: 10 });
    const open = rows[0];
    const closed = rows[1];
    expect(open.status).toBe("open");
    expect("workedMinutes" in open).toBe(false);
    expect("balanceMinutes" in open).toBe(false);
    expect(closed.status).toBe("closed");
    if (closed.status === "closed") {
      expect(closed.workedMinutes).toBe(9009);
      expect(closed.expectedMinutes).toBe(9000);
      expect(closed.balanceMinutes).toBe(-30);
    }
  });

  it("lists every month after the newest closed month up to the current month, across a year change", () => {
    const rows = buildEmployeeMonthRows([monthly(2025, 11)], { year: 2026, month: 1 });
    expect(keys(rows)).toEqual(["2026-1:open", "2025-12:open", "2025-11:closed"]);
  });

  it("shows exactly the current month as open when no MONTHLY row exists", () => {
    expect(keys(buildEmployeeMonthRows([], { year: 2026, month: 10 }))).toEqual(["2026-10:open"]);
  });

  it("does not invent months older than the newest closed month", () => {
    const rows = buildEmployeeMonthRows([monthly(2026, 3), monthly(2026, 9)], {
      year: 2026,
      month: 9,
    });
    expect(keys(rows)).toEqual(["2026-9:closed", "2026-3:closed"]);
  });

  it("caps at the 12 newest rows", () => {
    const closed: SnapshotAnswerRow[] = [];
    for (let m = 1; m <= 12; m += 1) closed.push(monthly(2025, m));
    for (let m = 1; m <= 8; m += 1) closed.push(monthly(2026, m));
    const rows = buildEmployeeMonthRows(closed, { year: 2026, month: 10 });
    expect(rows).toHaveLength(12);
    expect(keys(rows)[0]).toBe("2026-10:open");
    expect(keys(rows)[1]).toBe("2026-9:open");
    expect(keys(rows)[2]).toBe("2026-8:closed");
    expect(keys(rows)[11]).toBe("2025-11:closed");
  });

  it("does not build a long list of open rows for a long-stale employee", () => {
    const rows = buildEmployeeMonthRows([monthly(2020, 1)], { year: 2026, month: 10 });
    expect(rows).toHaveLength(12);
    expect(keys(rows)[0]).toBe("2026-10:open");
  });

  it("never turns YEARLY rows or rows without a month into table rows", () => {
    const rows = buildEmployeeMonthRows(
      [
        { ...monthly(2025, 1), periodType: "YEARLY", month: null },
        { ...monthly(2026, 5), month: null },
        monthly(2026, 9),
      ],
      { year: 2026, month: 10 },
    );
    expect(keys(rows)).toEqual(["2026-10:open", "2026-9:closed"]);
  });

  it("keeps one row for a month the server listed twice", () => {
    const rows = buildEmployeeMonthRows([monthly(2026, 9, 10), monthly(2026, 9, 20)], {
      year: 2026,
      month: 9,
    });
    expect(keys(rows)).toEqual(["2026-9:closed"]);
  });

  it("lists no open row when the newest closed month is not before the current month", () => {
    expect(keys(buildEmployeeMonthRows([monthly(2026, 10)], { year: 2026, month: 10 }))).toEqual([
      "2026-10:closed",
    ]);
  });

  it("labels rows from the calendar pair with the German month name", () => {
    const rows = buildEmployeeMonthRows([monthly(2026, 9)], { year: 2026, month: 9 });
    expect(rows[0].label).toBe("September 2026");
    expect(monthLabel(2026, 3)).toBe("März 2026");
    expect(EMP_MONTH_NAMES).toHaveLength(12);
  });
});
