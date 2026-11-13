/**
 * The ONE spreadsheet-cell guard of the CSV exports (Issue #612 T-612-13, shared with the audit
 * protocol export of Issue #583).
 *
 * Excel and LibreOffice evaluate a cell that starts with `=`, `+`, `-`, `@`, TAB or CR as a formula,
 * and names and e-mail addresses come from user input. Every TEXT cell that starts with one of them
 * gets a leading apostrophe, which a spreadsheet application does not display. Numeric cells are
 * exempt on purpose and must not pass through here: a negative saldo ("-0,75") has to stay a number.
 *
 * Format of the files that use it: UTF-8 with BOM (Excel opens it as UTF-8), `;` as separator, CRLF
 * line ends, RFC 4180 quoting (a cell with `;`, `"`, CR or LF is quoted, a quote is doubled).
 */

/** UTF-8 byte order mark: the first bytes of every export file. */
export const CSV_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const FORMULA_STARTS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** RFC 4180 quoting of an already guarded cell. */
function quoted(text: string): string {
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A text cell: formula-injection guard first, then quoting. */
export function csvCell(text: string): string {
  const guarded = text.length > 0 && FORMULA_STARTS.has(text[0]) ? `'${text}` : text;
  return quoted(guarded);
}
