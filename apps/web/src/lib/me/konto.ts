// Issue #594 / #598 (Phase 851): the rows of „So setzt sich dein Stundenkonto zusammen“ and of
// „Monatsnachweise“ on Ich › Konto. Every figure is read from the Arbeitszeitkonto answers - a closed
// month from its stored snapshot (never recomputed), an open month from GET /overtime/month-saldo
// (the same computeMonthSaldo chain the live saldo runs). This module sorts and labels, it never
// computes a Soll or a saldo of its own (CLAUDE.md: the web sums nothing itself).

export interface KontoSnapshot {
  periodType: string;
  year: number | null;
  month: number | null;
  expectedMinutes: number;
  workedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
  closedAt?: string | null;
}

export interface OpenMonthSaldo {
  year: number;
  month: number;
  expectedMinutes: number;
  workedMinutes: number;
  balanceMinutes: number;
  closed: boolean;
  /** The last day's cumulative saldo (carry-in + month so far), when the answer carries days. */
  standMinutes: number | null;
}

export type MonthStatus = "CLOSED" | "OPEN" | "RUNNING";

export interface KontoMonthRow {
  key: string;
  year: number;
  month: number;
  label: string;
  sollMinutes: number;
  istMinutes: number;
  diffMinutes: number;
  /** The account after this month; null where the answer does not state it. */
  standMinutes: number | null;
  status: MonthStatus;
  closedAt: string | null;
}

const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

/** The one status wording of a month (#598: every month has the same name everywhere). */
export const MONTH_STATUS_LABEL: Record<MonthStatus, string> = {
  CLOSED: "Abgeschlossen",
  OPEN: "Offen",
  RUNNING: "Bis gestern",
};

/**
 * Closed months from the snapshots plus the open months after the last close, newest first. A month
 * that is both closed and fetched as open is taken from the snapshot (the stored figures win).
 */
export function kontoMonthRows(
  snapshots: readonly KontoSnapshot[],
  open: readonly OpenMonthSaldo[],
  today: { year: number; month: number },
): KontoMonthRow[] {
  const rows = new Map<string, KontoMonthRow>();
  for (const s of snapshots) {
    if (s.periodType !== "MONTHLY" || s.year == null || s.month == null) continue;
    const key = `${s.year}-${String(s.month).padStart(2, "0")}`;
    rows.set(key, {
      key,
      year: s.year,
      month: s.month,
      label: monthLabel(s.year, s.month),
      sollMinutes: s.expectedMinutes,
      istMinutes: s.workedMinutes,
      diffMinutes: s.balanceMinutes,
      standMinutes: s.carryOver,
      status: "CLOSED",
      closedAt: s.closedAt ?? null,
    });
  }
  for (const m of open) {
    const key = `${m.year}-${String(m.month).padStart(2, "0")}`;
    if (rows.has(key) || m.closed) continue;
    const running = m.year === today.year && m.month === today.month;
    rows.set(key, {
      key,
      year: m.year,
      month: m.month,
      label: monthLabel(m.year, m.month),
      sollMinutes: m.expectedMinutes,
      istMinutes: m.workedMinutes,
      diffMinutes: m.balanceMinutes,
      standMinutes: m.standMinutes,
      status: running ? "RUNNING" : "OPEN",
      closedAt: null,
    });
  }
  return [...rows.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/** The months after the newest closed one up to today (inclusive) - the ones to ask month-saldo for. */
export function openMonthsAfter(
  lastClosed: { year: number; month: number } | null,
  first: { year: number; month: number },
  today: { year: number; month: number },
  limit = 12,
): { year: number; month: number }[] {
  let y = lastClosed ? lastClosed.year : first.year;
  let m = lastClosed ? lastClosed.month + 1 : first.month;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  const out: { year: number; month: number }[] = [];
  while ((y < today.year || (y === today.year && m <= today.month)) && out.length < limit) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
