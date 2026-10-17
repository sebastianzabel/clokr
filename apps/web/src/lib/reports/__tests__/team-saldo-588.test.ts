// Issue #588 - the pure team saldo figures (median, exclusions) behind the dashboard card and /reports.
import { describe, it, expect } from "vitest";
import { teamSaldoFigures, type TeamSaldoRow } from "../team-saldo";

/** A row shaped like the overview answer; total = confirmed + open. */
function row(id: string, confirmed: number, open: number, extra: Partial<TeamSaldoRow> = {}) {
  return {
    id,
    name: `Person ${id}`,
    balanceHours: (confirmed + open) / 60,
    confirmedMinutes: confirmed,
    openMonthMinutes: open,
    hasClosedMonth: true,
    hasRecordedTime: true,
    ...extra,
  } satisfies TeamSaldoRow;
}

describe("tracer", () => {
  it("leaves a person without recorded time out of the median and lists them as „ohne Erfassung“", () => {
    const figures = teamSaldoFigures([
      row("A", 60, 60),
      row("B", -60, 0),
      row("C", -2400, 0, { hasRecordedTime: false }),
    ]);
    expect(figures.counted).toBe(2);
    // A = +2:00 (120), B = −1:00 (−60): the mean of the two middle values, +0:30.
    expect(figures.medianMinutes).toBe(30);
    expect(figures.excluded).toEqual([
      { id: "C", name: "Person C", reason: "NO_RECORDED_TIME", reasonLabel: "ohne Erfassung" },
    ]);
  });
});
