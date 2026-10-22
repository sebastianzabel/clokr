/**
 * Issue #612 (P-11, T-612-13) - the pure serialiser of the period table CSV: byte order mark,
 * separators, German decimals from minutes, withheld cells, quoting and the formula-injection guard.
 */
import { describe, it, expect } from "vitest";
import {
  PERIOD_CSV_HEADER,
  periodCsvFilename,
  periodTableCsv,
  type PeriodCsvRow,
} from "../period-csv";

function row(over: Partial<PeriodCsvRow> = {}): PeriodCsvRow {
  return {
    employeeNumber: "1001",
    employeeName: "Anna Muster",
    expectedMinutes: 9630,
    workedMinutes: 600,
    openingBalanceMinutes: -45,
    balanceMinutes: 0,
    closingBalanceMinutes: 90,
    monthCount: 3,
    confirmedMonthCount: 3,
    labelled: true,
    ...over,
  };
}

const text = (rows: PeriodCsvRow[]): string => periodTableCsv(rows).subarray(3).toString("utf8");
const lines = (rows: PeriodCsvRow[]): string[] => text(rows).split("\r\n");
/** Data cells of the first (only) row, split on the separator (no quoted separators in these cases). */
const cellsOf = (over: Partial<PeriodCsvRow>): string[] => lines([row(over)])[1].split(";");

describe("Issue #612 - period table CSV serialiser", () => {
  it("starts with the UTF-8 byte order mark and the nine column titles", () => {
    const buf = periodTableCsv([row()]);
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(lines([row()])[0]).toBe(
      "Personalnummer;Name;Soll (h);Ist (h);Saldo Beginn (h);Saldo Zeitraum (h);Saldo Ende (h);Status;Monate bestätigt",
    );
    expect(PERIOD_CSV_HEADER).toBe(lines([])[0]);
  });

  it("ends every line with CRLF and writes the header only for zero rows", () => {
    expect(text([])).toBe(`${PERIOD_CSV_HEADER}\r\n`);
    const out = text([row(), row({ employeeNumber: "1002" })]);
    expect(out.endsWith("\r\n")).toBe(true);
    // No bare LF: every LF belongs to a CRLF.
    expect(out.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(out.split("\r\n")).toHaveLength(4);
  });

  it("writes hours as decimals with a comma, derived from minutes", () => {
    const cells = cellsOf({
      expectedMinutes: 9630,
      workedMinutes: 600,
      openingBalanceMinutes: -45,
      balanceMinutes: 0,
      closingBalanceMinutes: 1,
    });
    expect(cells.slice(2, 7)).toEqual(["160,5", "10", "-0,75", "0", "0,02"]);
  });

  it("writes a withheld (null) figure as an empty cell, never as zero", () => {
    const cells = cellsOf({
      expectedMinutes: null,
      openingBalanceMinutes: null,
      balanceMinutes: null,
      closingBalanceMinutes: null,
      sollUnavailableReason: "NO_PERMISSION",
    });
    expect(cells.slice(2, 7)).toEqual(["", "10", "", "", ""]);
  });

  it("quotes a cell with a separator or a quote and doubles the quote", () => {
    expect(lines([row({ employeeName: 'Muster; "Anna"' })])[1]).toContain(`;"Muster; ""Anna""";`);
  });

  describe("formula injection guard", () => {
    for (const start of ["=", "+", "-", "@"]) {
      it(`prefixes a name starting with "${start}" with an apostrophe`, () => {
        expect(cellsOf({ employeeName: `${start}SUM(A1)` })[1]).toBe(`'${start}SUM(A1)`);
      });
    }

    it("prefixes a name starting with TAB and with CR (the latter is also quoted)", () => {
      expect(cellsOf({ employeeName: "\tTab" })[1]).toBe("'\tTab");
      expect(lines([row({ employeeName: "\rCr" })]).join("|")).toContain(`;"'\rCr";`);
    });

    it("guards the personnel number as a text cell too", () => {
      expect(cellsOf({ employeeNumber: "=1+1" })[0]).toBe("'=1+1");
    });

    it("keeps a negative NUMBER as it is, without an apostrophe", () => {
      const cells = cellsOf({ openingBalanceMinutes: -90, balanceMinutes: -45 });
      expect(cells[4]).toBe("-1,5");
      expect(cells[5]).toBe("-0,75");
    });

    it("does not touch a harmless name", () => {
      expect(cellsOf({ employeeName: "Anna-Lena O'Brien" })[1]).toBe("Anna-Lena O'Brien");
    });
  });

  describe("status and confirmed months", () => {
    it("is Bestätigt when every listed month is closed", () => {
      const cells = cellsOf({ monthCount: 3, confirmedMonthCount: 3 });
      expect(cells[7]).toBe("Bestätigt");
      expect(cells[8]).toBe("3 von 3");
    });

    it("is Prognose when a listed month is still open", () => {
      const cells = cellsOf({ monthCount: 3, confirmedMonthCount: 2 });
      expect(cells[7]).toBe("Prognose");
      expect(cells[8]).toBe("2 von 3");
      expect(cellsOf({ monthCount: 1, confirmedMonthCount: 0 })[7]).toBe("Prognose");
    });

    it("is ohne Soll when no listed month has a Soll", () => {
      const cells = cellsOf({ labelled: false, monthCount: 2, confirmedMonthCount: 2 });
      expect(cells[7]).toBe("ohne Soll");
      expect(cells[8]).toBe("2 von 2");
    });

    // Old rule (#612): a row of a salon-filtered answer carried the reason SALON_FILTER and got an
    // empty status and an empty "k von m". Owner decision #714: a filtered row is the whole person,
    // so it gets its real status and count like every other row; the reason no longer exists.
    it("gives every row its real status and confirmed count, also a row of a filtered answer", () => {
      const cells = cellsOf({ labelled: true, monthCount: 2, confirmedMonthCount: 0 });
      expect(cells[7]).toBe("Prognose");
      expect(cells[8]).toBe("0 von 2");
    });

    it("keeps status and count on a row whose Soll is withheld for lack of permission", () => {
      const cells = cellsOf({
        expectedMinutes: null,
        labelled: true,
        monthCount: 2,
        confirmedMonthCount: 1,
        sollUnavailableReason: "NO_PERMISSION",
      });
      expect(cells[2]).toBe("");
      expect(cells[7]).toBe("Prognose");
      expect(cells[8]).toBe("1 von 2");
    });

    it("no longer knows a salon reason on a row (owner decision #714)", () => {
      // @ts-expect-error SALON_FILTER was removed from the row type with the rule it served
      const stale: PeriodCsvRow = row({ sollUnavailableReason: "SALON_FILTER" });
      expect(stale.employeeNumber).toBe("1001");
    });
  });

  it("names the file after the period", () => {
    expect(periodCsvFilename("2026-07", "2026-10")).toBe("Zeiten-und-Konten_2026-07_2026-10.csv");
  });
});
