/**
 * Issue #713 (D-11, D-03, P-713-09) - the pure serialiser of the absences-per-person CSV: header with
 * the unit of every column, fixed column order, decimal comma, CRLF/BOM and the formula-injection
 * guard of the existing table CSV.
 */
import { describe, it, expect } from "vitest";
import {
  PERIOD_ABSENCES_CSV_COLUMNS,
  PERIOD_ABSENCES_CSV_HEADER,
  periodAbsencesCsv,
  periodAbsencesCsvFilename,
  type PeriodAbsencesCsvRow,
} from "../period-csv";
import { PERIOD_PERSON_ABSENCE_CODES } from "../reports-period";

const ZERO = {
  SICK: 0,
  SICK_CHILD: 0,
  VACATION: 0,
  OVERTIME_COMP: 0,
  SPECIAL: 0,
  VOCATIONAL_SCHOOL: 0,
  EDUCATION: 0,
  UNPAID: 0,
  MATERNITY: 0,
  PARENTAL: 0,
} as const;

function row(over: Partial<PeriodAbsencesCsvRow> = {}): PeriodAbsencesCsvRow {
  return {
    employeeNumber: "1001",
    employeeName: "Anna Muster",
    absence: { ...ZERO },
    ...over,
  };
}

const text = (rows: PeriodAbsencesCsvRow[]): string =>
  periodAbsencesCsv(rows).subarray(3).toString("utf8");
const lines = (rows: PeriodAbsencesCsvRow[]): string[] => text(rows).split("\r\n");

describe("Issue #713 - absences per person CSV serialiser", () => {
  it("starts with the UTF-8 byte order mark and the twelve column titles, each naming its unit", () => {
    const buf = periodAbsencesCsv([row()]);
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(lines([row()])[0]).toBe(
      "Personalnummer;Name;Krank (Kalendertage);Kinderkrank (Kalendertage);Urlaub (Arbeitstage);Überstundenausgleich (Arbeitstage);Sonderurlaub (Arbeitstage);Berufsschule (Tage);Bildungsurlaub (Arbeitstage);Unbezahlt (Arbeitstage);Mutterschutz (Arbeitstage);Elternzeit (Arbeitstage)",
    );
    expect(PERIOD_ABSENCES_CSV_HEADER).toBe(lines([])[0]);
    expect(PERIOD_ABSENCES_CSV_HEADER.split(";")).toHaveLength(12);
  });

  it("every kind column names its unit in parentheses", () => {
    for (const column of PERIOD_ABSENCES_CSV_COLUMNS) {
      expect(column.header).toMatch(/ \((Kalendertage|Arbeitstage|Tage)\)$/);
    }
  });

  it("has the codes of the period answer's per-person absence object in the same order", () => {
    expect(PERIOD_ABSENCES_CSV_COLUMNS.map((c) => c.code)).toEqual([
      ...PERIOD_PERSON_ABSENCE_CODES,
    ]);
  });

  it("writes the header only for zero rows and ends every line with CRLF", () => {
    expect(text([])).toBe(`${PERIOD_ABSENCES_CSV_HEADER}\r\n`);
    const out = text([row(), row({ employeeNumber: "1002" })]);
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(out.split("\r\n")).toHaveLength(4);
  });

  it("writes day figures with a decimal comma in column order, zero as 0, never an apostrophe", () => {
    const cells = lines([
      row({ absence: { ...ZERO, SICK: 2, SICK_CHILD: 0.5, VACATION: 1.5 } }),
    ])[1].split(";");
    expect(cells).toEqual([
      "1001",
      "Anna Muster",
      "2",
      "0,5",
      "1,5",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    for (const c of cells.slice(2)) expect(c.startsWith("'")).toBe(false);
  });

  it("writes every column always, whatever the values", () => {
    const cells = lines([row()])[1].split(";");
    expect(cells).toHaveLength(12);
    expect(cells.slice(2).every((c) => c === "0")).toBe(true);
  });

  it("keeps the rows in the given order", () => {
    const out = lines([
      row({ employeeNumber: "3" }),
      row({ employeeNumber: "1" }),
      row({ employeeNumber: "2" }),
    ]);
    expect(out.slice(1, 4).map((l) => l.split(";")[0])).toEqual(["3", "1", "2"]);
  });

  it.each(["=", "+", "-", "@", "\t", "\r"])(
    "guards a name starting with %j against formula evaluation",
    (first) => {
      const out = text([row({ employeeName: `${first}SUM(A1)` })]);
      // A CR makes the cell quoted too; the apostrophe is in front of the character either way.
      expect(out).toContain(first === "\r" ? `"'\rSUM(A1)"` : `'${first}SUM(A1)`);
    },
  );

  it("guards a personnel number like any text cell", () => {
    expect(lines([row({ employeeNumber: "=1+1" })])[1].split(";")[0]).toBe("'=1+1");
  });

  it("quotes a name with the separator or a quote (RFC 4180)", () => {
    expect(lines([row({ employeeName: 'Muster; "Anna"' })])[1]).toContain('"Muster; ""Anna"""');
  });

  it("names the file after the period", () => {
    expect(periodAbsencesCsvFilename("2026-08", "2026-10")).toBe(
      "Abwesenheiten-je-Person_2026-08_2026-10.csv",
    );
  });
});
