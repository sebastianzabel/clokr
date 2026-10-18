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
  sollUnavailableReason?: "NO_PERMISSION" | "SALON_FILTER";
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
 * Soll, "Bestätigt" when every listed month is closed, "Prognose" otherwise. Under a salon filter
 * no month is evaluated against a contract at all, so the status is empty rather than a misleading
 * "ohne Soll".
 */
function statusText(row: PeriodCsvRow): string {
  if (row.sollUnavailableReason === "SALON_FILTER") return "";
  if (!row.labelled) return "ohne Soll";
  return row.confirmedMonthCount === row.monthCount ? "Bestätigt" : "Prognose";
}

/** The CSV file (BOM + header + one line per row, CRLF) for the rows in the given order. */
export function periodTableCsv(rows: readonly PeriodCsvRow[]): Buffer {
  const lines = [PERIOD_CSV_HEADER];
  for (const row of rows) {
    const confirmed =
      row.sollUnavailableReason === "SALON_FILTER"
        ? ""
        : `${row.confirmedMonthCount} von ${row.monthCount}`;
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
