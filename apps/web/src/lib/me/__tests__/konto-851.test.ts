// Issue #594 / #598 (Phase 851) - the Konto rows sort and label, they never recompute.
import { describe, expect, it } from "vitest";
import { kontoMonthRows, monthLabel, openMonthsAfter, MONTH_STATUS_LABEL } from "../konto";

const today = { year: 2026, month: 11 };

describe("kontoMonthRows", () => {
  it("takes a closed month verbatim from its snapshot, an open month from month-saldo, newest first", () => {
    const rows = kontoMonthRows(
      [
        {
          periodType: "MONTHLY",
          year: 2026,
          month: 10,
          expectedMinutes: 3840,
          workedMinutes: 3840,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: "2026-11-02T08:00:00Z",
        },
        {
          periodType: "YEARLY",
          year: 2025,
          month: null,
          expectedMinutes: 1,
          workedMinutes: 1,
          balanceMinutes: 1,
          carryOver: 1,
        },
      ],
      [
        {
          year: 2026,
          month: 11,
          expectedMinutes: 1920,
          workedMinutes: 2035,
          balanceMinutes: 115,
          closed: false,
          standMinutes: 115,
        },
      ],
      today,
    );
    expect(rows.map((r) => r.key)).toEqual(["2026-11", "2026-10"]);
    expect(rows[0]).toMatchObject({ status: "RUNNING", diffMinutes: 115, standMinutes: 115 });
    expect(rows[1]).toMatchObject({ status: "CLOSED", sollMinutes: 3840, standMinutes: 0 });
  });

  it("never lets an open answer replace a stored closed month", () => {
    const rows = kontoMonthRows(
      [
        {
          periodType: "MONTHLY",
          year: 2026,
          month: 10,
          expectedMinutes: 10,
          workedMinutes: 10,
          balanceMinutes: 0,
          carryOver: 5,
        },
      ],
      [
        {
          year: 2026,
          month: 10,
          expectedMinutes: 99,
          workedMinutes: 99,
          balanceMinutes: 99,
          closed: false,
          standMinutes: 99,
        },
      ],
      today,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].standMinutes).toBe(5);
  });

  it("names a month and its status in one wording", () => {
    expect(monthLabel(2026, 3)).toBe("März 2026");
    expect(MONTH_STATUS_LABEL).toEqual({
      CLOSED: "Abgeschlossen",
      OPEN: "Offen",
      RUNNING: "Bis gestern",
    });
  });
});

describe("openMonthsAfter", () => {
  it("lists the months after the last close up to today", () => {
    expect(openMonthsAfter({ year: 2026, month: 9 }, { year: 2026, month: 1 }, today)).toEqual([
      { year: 2026, month: 10 },
      { year: 2026, month: 11 },
    ]);
  });
  it("starts at the first month without any close and crosses the year", () => {
    expect(openMonthsAfter(null, { year: 2025, month: 12 }, { year: 2026, month: 1 })).toEqual([
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
    ]);
  });
  it("is empty when the last close is the current month", () => {
    expect(openMonthsAfter({ year: 2026, month: 11 }, { year: 2026, month: 1 }, today)).toEqual([]);
  });
});
