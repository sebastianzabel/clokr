// Issue #612 - the pure decisions of the period table: search, sort, status, withheld reasons.
import { describe, it, expect } from "vitest";
import { forecastLabel } from "$lib/saldo/forecast-label";
import type { PeriodRow } from "../period-report";
import {
  filterPeriodRows,
  firstDirection,
  hasSaldoFigures,
  initialsOf,
  nextSort,
  rowStatus,
  sortPeriodRows,
  withheldReason,
} from "../period-table";

function row(id: string, extra: Partial<PeriodRow> = {}): PeriodRow {
  return {
    employeeId: id,
    employeeName: `Person ${id}`,
    employeeNumber: `N-${id}`,
    hasRecordedTime: true,
    exitDay: null,
    workedMinutes: 100,
    expectedMinutes: 100,
    balanceMinutes: 0,
    openingBalanceMinutes: 0,
    closingBalanceMinutes: 0,
    closingConfirmedMinutes: null,
    closingOpenMinutes: null,
    unconfirmedMonths: null,
    monthCount: 1,
    confirmedMonthCount: 1,
    labelled: true,
    sickDays: 0,
    months: [],
    ...extra,
  };
}

describe("sort", () => {
  it("a person starts ascending, a figure descending; the same column flips", () => {
    expect(firstDirection("name")).toBe("asc");
    for (const key of ["soll", "ist", "opening", "balance", "closing", "status"] as const) {
      expect(firstDirection(key)).toBe("desc");
    }
    let s = nextSort({ key: "name", dir: "asc" }, "closing");
    expect(s).toEqual({ key: "closing", dir: "desc" });
    s = nextSort(s, "closing");
    expect(s).toEqual({ key: "closing", dir: "asc" });
    expect(nextSort(s, "name")).toEqual({ key: "name", dir: "asc" });
  });

  it("withheld figures sort last in both directions, ties break by name then id", () => {
    const rows = [
      row("1", { employeeName: "B", closingBalanceMinutes: null }),
      row("2", { employeeName: "A", closingBalanceMinutes: 5 }),
      row("3", { employeeName: "C", closingBalanceMinutes: 5 }),
      row("4", { employeeName: "D", closingBalanceMinutes: -5 }),
    ];
    const ids = (dir: "asc" | "desc") =>
      sortPeriodRows(rows, "closing", dir).map((r) => r.employeeId);
    expect(ids("desc")).toEqual(["2", "3", "4", "1"]);
    expect(ids("asc")).toEqual(["4", "2", "3", "1"]);
  });

  it("two persons with the same name keep a stable, total order by id", () => {
    const rows = [row("b", { employeeName: "Same" }), row("a", { employeeName: "Same" })];
    expect(sortPeriodRows(rows, "name", "asc").map((r) => r.employeeId)).toEqual(["a", "b"]);
  });

  it("returns a copy and leaves the input alone", () => {
    const rows = [row("2"), row("1")];
    const sorted = sortPeriodRows(rows, "name", "asc");
    expect(sorted).not.toBe(rows);
    expect(rows.map((r) => r.employeeId)).toEqual(["2", "1"]);
  });
});

describe("filter", () => {
  it("matches name or personnel number, case-insensitive and trimmed; an empty query keeps all", () => {
    const rows = [
      row("1", { employeeName: "Anna Ärger", employeeNumber: "A-100" }),
      row("2", { employeeName: "Bert", employeeNumber: "B-200" }),
    ];
    expect(filterPeriodRows(rows, "  ÄRGER ").map((r) => r.employeeId)).toEqual(["1"]);
    expect(filterPeriodRows(rows, "b-2").map((r) => r.employeeId)).toEqual(["2"]);
    expect(filterPeriodRows(rows, "   ")).toHaveLength(2);
    expect(filterPeriodRows(rows, "nobody")).toHaveLength(0);
  });
});

describe("rowStatus", () => {
  it("all months confirmed", () => {
    expect(rowStatus(row("1", { monthCount: 3, confirmedMonthCount: 3 }))).toEqual({
      kind: "confirmed",
      label: "Bestätigt",
      detail: null,
    });
  });

  it("an unlabelled person is „ohne Soll“ whatever the months say", () => {
    expect(rowStatus(row("1", { labelled: false, monthCount: 2, confirmedMonthCount: 2 }))).toEqual(
      {
        kind: "unlabelled",
        label: "ohne Soll",
        detail: null,
      },
    );
  });

  it("a forecast is worded by the one rule from the months that are not confirmed", () => {
    expect(rowStatus(row("1", { monthCount: 3, confirmedMonthCount: 2 }))).toEqual({
      kind: "forecast",
      label: forecastLabel(1, true),
      detail: "2 von 3 Monaten bestätigt",
    });
    expect(rowStatus(row("1", { monthCount: 2, confirmedMonthCount: 0 }))).toEqual({
      kind: "forecast",
      label: forecastLabel(2, false),
      detail: null,
    });
    // The split closing saldo after a closed month BEFORE the period is a closed month, too.
    expect(
      rowStatus(
        row("1", {
          monthCount: 1,
          confirmedMonthCount: 0,
          closingConfirmedMinutes: 60,
          unconfirmedMonths: 1,
        }),
      ).label,
    ).toBe(forecastLabel(1, true));
  });

  it("an empty period (no month) is not „Bestätigt“", () => {
    expect(rowStatus(row("1", { monthCount: 0, confirmedMonthCount: 0 })).kind).toBe("forecast");
  });
});

describe("helpers", () => {
  it("hasSaldoFigures is true as soon as one row carries any saldo figure", () => {
    const none = { openingBalanceMinutes: null, balanceMinutes: null, closingBalanceMinutes: null };
    expect(hasSaldoFigures([row("1", none), row("2", none)])).toBe(false);
    expect(hasSaldoFigures([row("1", none), row("2", { ...none, balanceMinutes: 0 })])).toBe(true);
    expect(hasSaldoFigures([])).toBe(false);
  });

  it("withheldReason names the server's reason and has a neutral fallback", () => {
    expect(withheldReason(row("1", { sollUnavailableReason: "NO_PERMISSION" }))).toBe(
      "Keine Berechtigung",
    );
    expect(withheldReason(row("1", { sollUnavailableReason: "SALON_FILTER" }))).toBe(
      "Nicht je Salon",
    );
    expect(withheldReason(row("1"))).toBe("Kein Wert vorhanden");
  });

  it("initialsOf takes the first letters of the first and last word", () => {
    expect(initialsOf("Anna Maria Berg")).toBe("AB");
    expect(initialsOf("ärger")).toBe("Ä");
    expect(initialsOf("  ")).toBe("?");
  });
});
