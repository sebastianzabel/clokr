import type { LeaveTypeCode } from "@clokr/db";
import { fmtDecimalDe } from "./pdf-format";

/**
 * Issue #612 (P-11) - pure serialisation of the period report's "Zeiten & Konten" rows as a CSV.
 *
 * No Prisma, no clock, no rule: the rows arrive fully computed from the one period assembly
 * (`reports-period.ts`), so the file shows exactly the figures of the page. Hours are derived from
 * MINUTES through `fmtDecimalDe` (never from an hours figure rounded for the JSON, research
 * Pitfall 8), with a decimal comma, because the target is a German spreadsheet. A figure the caller
 * may not see arrives as `null` and becomes an empty cell - never a zero.
 *
 * Spreadsheet formula injection (T-612-13): Excel and LibreOffice evaluate a cell that starts with
 * `=`, `+`, `-`, `@`, TAB or CR as a formula, and names come from user input. Every TEXT cell that
 * starts with one of them gets a leading apostrophe, which a spreadsheet application does not
 * display. Numeric cells are exempt on purpose: a negative saldo ("-0,75") must stay a number, and
 * a number produced by `fmtDecimalDe` can never carry a formula.
 *
 * Format: UTF-8 with BOM (Excel opens it as UTF-8), `;` as separator, CRLF line ends, RFC 4180
 * quoting (a cell with `;`, `"`, CR or LF is quoted, a quote is doubled).
 *
 * Issue #713 (P-713-09) - the table "Abwesenheiten je Person": Kalendertage for Krank/Kinderkrank,
 * Berufsschultage, Arbeitstage for the requested kinds, exactly the numbers of `rows[].absence`;
 * every column always, so a spreadsheet gets a stable schema. Every header names its unit because
 * the columns mix calendar days and workdays (D-03).
 */

/** The nine column titles, in file order. */
export const PERIOD_CSV_HEADER = [
  "Personalnummer",
  "Name",
  "Soll (h)",
  "Ist (h)",
  "Saldo Beginn (h)",
  "Saldo Zeitraum (h)",
  "Saldo Ende (h)",
  "Status",
  "Monate bestätigt",
].join(";");

/** The subset of a period row the table reads. */
export type PeriodCsvRow = {
  employeeNumber: string;
  employeeName: string;
  expectedMinutes: number | null;
  workedMinutes: number;
  openingBalanceMinutes: number | null;
  balanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  monthCount: number;
  confirmedMonthCount: number;
  labelled: boolean;
  sollUnavailableReason?: "NO_PERMISSION";
};

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const FORMULA_STARTS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** `Zeiten-und-Konten_<from>_<to>.csv` for `YYYY-MM` bounds. */
export function periodCsvFilename(from: string, to: string): string {
  return `Zeiten-und-Konten_${from}_${to}.csv`;
}

/** RFC 4180 quoting of an already guarded cell. */
function quoted(text: string): string {
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A text cell: formula-injection guard first, then quoting. */
function cell(text: string): string {
  const guarded = text.length > 0 && FORMULA_STARTS.has(text[0]) ? `'${text}` : text;
  return quoted(guarded);
}

/** A numeric cell from minutes: hours with a decimal comma; withheld (`null`) is empty. */
function hoursCell(minutes: number | null): string {
  return minutes === null ? "" : fmtDecimalDe(minutes / 60, 2);
}

/**
 * Status text of a row (P-08, the Monatsexport vocabulary): "ohne Soll" when no listed month has a
 * Soll, "Bestätigt" when every listed month is closed, "Prognose" otherwise. Every row gets its real
 * status: under a salon filter a row is the whole person of the Stammsalon circle (owner decision
 * #714), so there is no salon exception.
 */
function statusText(row: PeriodCsvRow): string {
  if (!row.labelled) return "ohne Soll";
  return row.confirmedMonthCount === row.monthCount ? "Bestätigt" : "Prognose";
}

/** The CSV file (BOM + header + one line per row, CRLF) for the rows in the given order. */
export function periodTableCsv(rows: readonly PeriodCsvRow[]): Buffer {
  const lines = [PERIOD_CSV_HEADER];
  for (const row of rows) {
    const confirmed = `${row.confirmedMonthCount} von ${row.monthCount}`;
    lines.push(
      [
        cell(row.employeeNumber),
        cell(row.employeeName),
        hoursCell(row.expectedMinutes),
        hoursCell(row.workedMinutes),
        hoursCell(row.openingBalanceMinutes),
        hoursCell(row.balanceMinutes),
        hoursCell(row.closingBalanceMinutes),
        cell(statusText(row)),
        confirmed,
      ].join(";"),
    );
  }
  return Buffer.concat([BOM, Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8")]);
}

// ── Abwesenheiten je Person (Issue #713) ─────────────────────────────────────────────────────────

/** A kind column of the absences CSV: the code of `rows[].absence` and its header with the unit. */
export type PeriodAbsencesCsvCode = Exclude<LeaveTypeCode, "OTHER"> | "VOCATIONAL_SCHOOL";
export type PeriodAbsencesCsvColumn = {
  code: PeriodAbsencesCsvCode;
  header: string;
};

/** The ten kind columns, in file order (the order of the period answer's `absence` object). */
export const PERIOD_ABSENCES_CSV_COLUMNS: readonly PeriodAbsencesCsvColumn[] = [
  { code: "SICK", header: "Krank (Kalendertage)" },
  { code: "SICK_CHILD", header: "Kinderkrank (Kalendertage)" },
  { code: "VACATION", header: "Urlaub (Arbeitstage)" },
  { code: "OVERTIME_COMP", header: "Überstundenausgleich (Arbeitstage)" },
  { code: "SPECIAL", header: "Sonderurlaub (Arbeitstage)" },
  { code: "VOCATIONAL_SCHOOL", header: "Berufsschule (Tage)" },
  { code: "EDUCATION", header: "Bildungsurlaub (Arbeitstage)" },
  { code: "UNPAID", header: "Unbezahlt (Arbeitstage)" },
  { code: "MATERNITY", header: "Mutterschutz (Arbeitstage)" },
  { code: "PARENTAL", header: "Elternzeit (Arbeitstage)" },
];

/** The twelve column titles of the absences CSV. */
export const PERIOD_ABSENCES_CSV_HEADER = [
  "Personalnummer",
  "Name",
  ...PERIOD_ABSENCES_CSV_COLUMNS.map((c) => c.header),
].join(";");

/** The subset of a period row the absences table reads. */
export type PeriodAbsencesCsvRow = {
  employeeNumber: string;
  employeeName: string;
  absence: Readonly<Record<PeriodAbsencesCsvCode, number>>;
};

/** `Abwesenheiten-je-Person_<from>_<to>.csv` for `YYYY-MM` bounds. */
export function periodAbsencesCsvFilename(from: string, to: string): string {
  return `Abwesenheiten-je-Person_${from}_${to}.csv`;
}

/** The absences CSV (BOM + header + one line per row, CRLF) for the rows in the given order. */
export function periodAbsencesCsv(rows: readonly PeriodAbsencesCsvRow[]): Buffer {
  const lines = [PERIOD_ABSENCES_CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        cell(row.employeeNumber),
        cell(row.employeeName),
        ...PERIOD_ABSENCES_CSV_COLUMNS.map((c) => fmtDecimalDe(row.absence[c.code], 2)),
      ].join(";"),
    );
  }
  return Buffer.concat([BOM, Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8")]);
}
