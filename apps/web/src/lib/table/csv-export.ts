// Issue #854 (D-854-09, T-854-43) - the client-side CSV export of a table selection. The web twin of
// the API's `utils/csv-cell.ts`: UTF-8 with BOM (Excel opens it as UTF-8), `;` as separator, CRLF
// line ends, RFC 4180 quoting, and a leading apostrophe on a text cell that a spreadsheet would
// evaluate as a formula (`=`, `+`, `-`, `@`, TAB, CR). Names and e-mail addresses come from user
// input, so every cell here is a TEXT cell; a numeric column must not be exported through this helper.

export interface CsvColumn {
  key: string;
  label: string;
}

const FORMULA_STARTS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** UTF-8 byte order mark as the first character of the file. */
export const CSV_BOM = "﻿";

/** RFC 4180 quoting of an already guarded cell. */
function quoted(text: string): string {
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One text cell: formula-injection guard first, then quoting. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = text.length > 0 && FORMULA_STARTS.has(text[0]) ? `'${text}` : text;
  return quoted(guarded);
}

/** The file content: BOM, the head row of the labels, one row per record, CRLF after every line. */
export function rowsToCsv(columns: readonly CsvColumn[], rows: readonly Record<string, unknown>[]) {
  const lines = [
    columns.map((column) => csvCell(column.label)).join(";"),
    ...rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(";")),
  ];
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/** Hands the text to the browser as a file download. */
export function downloadCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
