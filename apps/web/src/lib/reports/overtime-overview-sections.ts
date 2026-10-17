/**
 * Issue #613 (AC-613-5): the Überstunden-Übersicht answer carries two kinds of rows - the team
 * employed today and the persons who have left whose final saldo is still open (their exit month is
 * not closed). The server decides which row belongs to which section, in which order and how many
 * are listed; the web only partitions by the server's flag, formats the exit date and states how
 * many rows are not shown. It compares no dates and computes no saldo.
 */

/** The fields of an overview row that decide its section. */
export interface SectionedOverviewRow {
  /** Absent in an older cached answer: such a row belongs to the team. */
  exitedWithOpenFinalSaldo?: boolean;
}

/** An overview row as the exited section shows it. */
export interface ExitedOverviewRow extends SectionedOverviewRow {
  id: string;
  name: string;
  employeeNumber: string;
  /** Tenant-local `YYYY-MM-DD`, or null. */
  exitDate?: string | null;
  balanceHours: number;
  confirmedMinutes?: number;
  openMonthMinutes?: number | null;
  hasClosedMonth?: boolean;
  rosterIncomplete?: boolean;
  // Issue #588 - additive facts of the overview row; the exited section hands the row to the
  // team saldo module, which reads them for its cells and the forecast label.
  hasRecordedTime?: boolean;
  trackOnly?: boolean | null;
  unconfirmedMonths?: number | null;
}

/** Splits the answer's rows into the team table and the exited section; each keeps the input order. */
export function partitionOvertimeOverview<T extends SectionedOverviewRow>(
  rows: readonly T[],
): { active: T[]; exitedOpen: T[] } {
  const active: T[] = [];
  const exitedOpen: T[] = [];
  for (const row of rows) {
    if (row.exitedWithOpenFinalSaldo === true) exitedOpen.push(row);
    else active.push(row);
  }
  return { active, exitedOpen };
}

/** How many exited persons the server counted but did not list. */
export function exitedMoreCount(total: number, shown: number): number {
  return Math.max(0, total - shown);
}

/** `2026-10-15` -> `15.10.2026`; null or malformed -> en dash. */
export function exitDateLabel(iso: string | null | undefined): string {
  const match = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (match === null) return "–";
  return `${match[3]}.${match[2]}.${match[1]}`;
}
