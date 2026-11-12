// Issue #854 (plan 854-24, D-854-13/-22): the pure rules of Daten > Export - the open-month hint, the
// history rows read from EXPORT audit rows and the URL preselection.
import { describe, expect, it } from "vitest";

import {
  csvPeriodProblem,
  exportHistoryRows,
  exportPreselection,
  monthName,
  openMonthHint,
  wholeNumberProblem,
} from "../export-centre";

describe("monthName", () => {
  it("writes the month in German", () => {
    expect(monthName({ year: 2026, month: 10 })).toBe("Oktober 2026");
    expect(monthName({ year: 2027, month: 1 })).toBe("Januar 2027");
  });
});

describe("openMonthHint", () => {
  it("warns for every month that is not closed", () => {
    for (const status of ["open", "ready", "blocked", "no_data"]) {
      const hint = openMonthHint(status, 2026, 10);
      expect(hint, status).toContain("Oktober 2026 ist noch nicht abgeschlossen.");
      expect(hint, status).toContain("Monatsabschluss");
    }
  });

  it("says so when only part of the people are closed", () => {
    expect(openMonthHint("partial", 2026, 10)).toContain("Oktober 2026");
    expect(openMonthHint("partial", 2026, 10)).not.toBe(openMonthHint("open", 2026, 10));
  });

  it("has no hint for a closed month", () => {
    expect(openMonthHint("closed", 2026, 10)).toBeNull();
  });

  it("has no hint without a status (no right or a failed read) - and never an error", () => {
    expect(openMonthHint(undefined, 2026, 10)).toBeNull();
  });
});

describe("exportHistoryRows", () => {
  const at = (day: number) => new Date(2026, 10, day, 14, 5).toISOString();
  const row = (over: Record<string, unknown>) => ({
    id: "a",
    createdAt: at(3),
    user: { email: "chef@example.test" },
    newValue: { type: "DATEV", year: 2026, month: 10 },
    affectedEmployee: null,
    ...over,
  });

  it("describes a tenant DATEV export by month and kind", () => {
    const [r] = exportHistoryRows([row({})]);
    expect(r).toEqual({
      id: "a",
      when: "03.11.2026 14:05",
      who: "chef@example.test",
      kind: "DATEV-Export",
      scope: "Oktober 2026",
    });
  });

  it("names the person of a single-person export", () => {
    const [r] = exportHistoryRows([
      row({
        newValue: { type: "DATEV_EMPLOYEE", year: 2026, month: 9, employeeId: "x" },
        affectedEmployee: { firstName: "Anna", lastName: "Muster", employeeNumber: "7" },
      }),
    ]);
    expect(r.kind).toBe("DATEV-Export einer Person");
    expect(r.scope).toBe("Muster, Anna · September 2026");
  });

  it("writes a month range and a day range of the period exports", () => {
    const rows = exportHistoryRows([
      row({ id: "m", newValue: { type: "PERIOD_CSV", from: "2026-07", to: "2026-09" } }),
      row({ id: "o", newValue: { type: "PERIOD_CSV", from: "2026-09", to: "2026-09" } }),
      row({ id: "d", newValue: { type: "AUDIT_LOG_CSV", from: "2026-09-01", to: "2026-09-30" } }),
    ]);
    expect(rows.map((r) => r.scope)).toEqual([
      "Juli 2026 bis September 2026",
      "September 2026",
      "01.09.–30.09.2026",
    ]);
    expect(rows[2].kind).toBe("Protokoll (CSV)");
  });

  it("never shows a raw code: an unknown type reads the neutral words, no scope reads a dash", () => {
    const [r] = exportHistoryRows([row({ newValue: { type: "SOME_NEW_EXPORT" } })]);
    expect(r.kind).toBe("Sonstige Änderung");
    expect(r.scope).toBe("—");
    const [none] = exportHistoryRows([row({ newValue: null })]);
    expect(none.kind).toBe("Sonstige Änderung");
  });

  it("shows the operator and the system by their words, not as an empty name", () => {
    const [r] = exportHistoryRows([
      row({
        user: null,
        newValue: { type: "DATEV", year: 2026, month: 10, actor: { type: "OPERATOR" } },
      }),
    ]);
    expect(r.who).toBe("Betreiber");
  });

  it("lists the newest first", () => {
    const rows = exportHistoryRows([
      row({ id: "old", createdAt: at(1) }),
      row({ id: "new", createdAt: at(9) }),
      row({ id: "mid", createdAt: at(5) }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("exportPreselection", () => {
  const PERSON = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
  const url = (qs: string) => new URL(`http://localhost/verwalten/daten/export${qs}`);

  it("reads person, year and month", () => {
    expect(exportPreselection(url(`?person=${PERSON}&year=2026&month=10`))).toEqual({
      personId: PERSON,
      year: 2026,
      month: 10,
    });
  });

  it("drops every malformed value", () => {
    expect(exportPreselection(url("?person=not-a-uuid&year=abc&month=13"))).toEqual({
      personId: null,
      year: null,
      month: null,
    });
    expect(exportPreselection(url("?year=1999&month=0"))).toEqual({
      personId: null,
      year: null,
      month: null,
    });
    expect(exportPreselection(url("?year=2026.5&month=1e1"))).toEqual({
      personId: null,
      year: null,
      month: null,
    });
  });

  it("is empty without parameters", () => {
    expect(exportPreselection(url(""))).toEqual({ personId: null, year: null, month: null });
  });
});

describe("csvPeriodProblem", () => {
  const today = { year: 2026, month: 11 };
  it("accepts a plain period", () => {
    expect(csvPeriodProblem({ year: 2026, month: 1 }, { year: 2026, month: 10 }, today)).toBeNull();
  });
  it("names the three problems in German", () => {
    expect(csvPeriodProblem({ year: 2026, month: 5 }, { year: 2026, month: 4 }, today)).toContain(
      "Bis",
    );
    expect(csvPeriodProblem({ year: 2026, month: 5 }, { year: 2027, month: 1 }, today)).toContain(
      "Zukunft",
    );
    expect(csvPeriodProblem({ year: 2025, month: 1 }, { year: 2026, month: 1 }, today)).toContain(
      "12 Monate",
    );
  });
});

describe("wholeNumberProblem", () => {
  const range = { min: 1, max: 9999 };
  it("accepts a whole number inside the range", () => {
    expect(wholeNumberProblem("Urlaub", 300, range)).toBeNull();
    expect(wholeNumberProblem("Urlaub", 1, range)).toBeNull();
    expect(wholeNumberProblem("Urlaub", 9999, range)).toBeNull();
  });
  it("refuses a decimal, zero and a number above the range", () => {
    for (const value of [1.5, 0, 10000, -3]) {
      expect(wholeNumberProblem("Urlaub", value, range), String(value)).toBe(
        "Urlaub ist eine ganze Zahl von 1 bis 9999.",
      );
    }
  });
  it("an empty required field is a Pflichtangabe, an empty optional one is fine", () => {
    expect(wholeNumberProblem("Urlaub", null, range)).toBe("Urlaub ist eine Pflichtangabe.");
    expect(wholeNumberProblem("Urlaub", undefined, range)).toBe("Urlaub ist eine Pflichtangabe.");
    expect(wholeNumberProblem("Urlaub", null, { ...range, optional: true })).toBeNull();
  });
});
