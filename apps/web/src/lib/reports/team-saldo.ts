/**
 * Issue #588 - the ONE place for team saldo figures in the web. The dashboard card "Salden" and
 * `/reports` read this module; no second median, Top list or outlier rule exists anywhere.
 *
 * ── The outlier rule (D-588-2, P-03, P-04) ─────────────────────────────────────────────────────
 * A person COUNTS for the team median and the Top lists only if ALL of these hold:
 *   (a) they belong to the team employed today - a row of the exited section
 *       (`exitedWithOpenFinalSaldo`) is neither counted nor listed here (P-04, it has its own
 *       section);
 *   (b) the server delivered a live saldo (`openMonthMinutes` is not null). A row without one is
 *       exempt (§ 18 ArbZG) or its computation failed and shows a stored fallback number, which is
 *       not the person's live saldo (P-03);
 *   (c) the contract in force is not track-only (`trackOnly` is not true, #494): the saldo of such a
 *       contract is 0 by rule, so it says nothing about the team;
 *   (d) the person has recorded working time since hire (`hasRecordedTime` is not false): a person
 *       who never clocked in carries an unbroken negative Soll that would drag the team figure.
 * A fact the server did not send (an older cached answer) never excludes anyone.
 * A person who does not count is LISTED with exactly one reason, never silently dropped. The
 * precedence is the order above: SALDO_UNAVAILABLE, TIME_TRACKING_ONLY, NO_RECORDED_TIME (the display
 * wording lives in `TEAM_SALDO_EXCLUSION_LABEL`).
 *
 * ── The figure (P-01, P-07) ────────────────────────────────────────────────────────────────────
 * The value of a person is the TOTAL saldo (confirmed + the period since the last Monatsabschluss),
 * the account's headline number. The team figure is the MEDIAN of the counted totals: an odd count
 * gives the middle value, an even count the mean of the two middle values rounded to whole minutes
 * (`Math.round`, a negative zero becomes 0), nobody counted gives null. The Top 5 plus are the
 * strictly positive totals, largest first; the Top 5 minus the strictly negative totals, most
 * negative first; ties are broken by name (`localeCompare` "de") and then id; a zero total is in
 * neither list. The diverging order for a chart is the plus list followed by the minus list
 * reversed, so the most negative bar sits at the bottom.
 *
 * ── Format and labels (D-588-5, P-05) ──────────────────────────────────────────────────────────
 * Every saldo is `fmtBalance` (sign always shown, U+2212, "±0:00" at zero). The wording of the
 * forecast part comes from `$lib/saldo/forecast-label` (re-exported below); the PDF wording
 * constants of the API are a different, month-scoped rule and are not this one.
 *
 * Pure: no Svelte, no store, no fetch, no `Date`. Every comparator is explicit.
 */
import { fmtBalance } from "$lib/utils/format-minutes";
import { forecastCaption, forecastColumnLabel, forecastLabel } from "$lib/saldo/forecast-label";

export { forecastCaption, forecastColumnLabel, forecastLabel };

/** The fields of an overview row (`GET /dashboard/overtime-overview`) the team figures read. */
export interface TeamSaldoRow {
  id: string;
  name: string;
  /** Absent in an older cached answer: such a row belongs to the team. */
  exitedWithOpenFinalSaldo?: boolean;
  balanceHours: number;
  confirmedMinutes?: number;
  /** Null: no live saldo (exempt or failed computation). */
  openMonthMinutes?: number | null;
  hasClosedMonth?: boolean;
  /** Issue #588: absent in an older cached answer - an absent fact never excludes a person. */
  hasRecordedTime?: boolean;
  /** Issue #588: the #494 rule for today's contract; null when no live saldo exists. */
  trackOnly?: boolean | null;
  /** Issue #588: unclosed calendar months in the live window; null when no live saldo exists. */
  unconfirmedMonths?: number | null;
}

/** Why a person is listed instead of counted. */
export type TeamSaldoExclusionReason =
  "SALDO_UNAVAILABLE" | "TIME_TRACKING_ONLY" | "NO_RECORDED_TIME";

/** The display wording of an exclusion reason (the code is the control value, this is display only). */
export const TEAM_SALDO_EXCLUSION_LABEL: Record<TeamSaldoExclusionReason, string> = {
  SALDO_UNAVAILABLE: "Saldo nicht verfügbar",
  TIME_TRACKING_ONLY: "nur Zeiterfassung",
  NO_RECORDED_TIME: "ohne Erfassung",
};

export interface TeamSaldoExcluded {
  id: string;
  name: string;
  reason: TeamSaldoExclusionReason;
  reasonLabel: string;
}

/** One bar of the Top lists. */
export interface TeamSaldoBar {
  id: string;
  name: string;
  totalMinutes: number;
  /** `fmtBalance(totalMinutes)`. */
  label: string;
}

/** The total saldo of a row in minutes: confirmed + running period, else the rounded headline hours. */
export function totalMinutesOf(row: TeamSaldoRow): number {
  if (typeof row.confirmedMinutes === "number" && typeof row.openMonthMinutes === "number") {
    return row.confirmedMinutes + row.openMonthMinutes;
  }
  return Math.round(row.balanceHours * 60);
}

/** The reason a person does not count for the team figures, or null when they count. */
export function teamSaldoExclusion(row: TeamSaldoRow): TeamSaldoExclusionReason | null {
  if (row.openMonthMinutes === null) return "SALDO_UNAVAILABLE";
  if (row.trackOnly === true) return "TIME_TRACKING_ONLY";
  if (row.hasRecordedTime === false) return "NO_RECORDED_TIME";
  return null;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "de");
}

/** `direction` 1: largest total first; -1: most negative total first. Ties: name, then id. */
function compareBars(direction: 1 | -1) {
  return (x: TeamSaldoBar, y: TeamSaldoBar): number => {
    if (x.totalMinutes !== y.totalMinutes) return direction * (y.totalMinutes - x.totalMinutes);
    const byName = compareText(x.name, y.name);
    return byName !== 0 ? byName : compareText(x.id, y.id);
  };
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  const mean = Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return mean === 0 ? 0 : mean; // normalise a negative zero
}

export interface TeamSaldoFigures {
  /** Persons that count for the median and the Top lists. */
  counted: number;
  /** The team figure in minutes, or null when nobody counts. */
  medianMinutes: number | null;
  /** Strictly positive totals, largest first, at most `topN`. */
  plus: TeamSaldoBar[];
  /** Strictly negative totals, most negative first, at most `topN`. */
  minus: TeamSaldoBar[];
  /** `plus` followed by `minus` reversed: the order of a diverging chart, most negative last. */
  diverging: TeamSaldoBar[];
  /** Persons who do not count, each with one reason, ordered by name then id. */
  excluded: TeamSaldoExcluded[];
}

/** The team figures of an overview answer (exited rows are ignored: they have their own section). */
export function teamSaldoFigures(rows: readonly TeamSaldoRow[], topN = 5): TeamSaldoFigures {
  const bars: TeamSaldoBar[] = [];
  const excluded: TeamSaldoExcluded[] = [];
  for (const row of rows) {
    if (row.exitedWithOpenFinalSaldo === true) continue;
    const reason = teamSaldoExclusion(row);
    if (reason === null) {
      const totalMinutes = totalMinutesOf(row);
      bars.push({ id: row.id, name: row.name, totalMinutes, label: fmtBalance(totalMinutes) });
    } else {
      excluded.push({
        id: row.id,
        name: row.name,
        reason,
        reasonLabel: TEAM_SALDO_EXCLUSION_LABEL[reason],
      });
    }
  }
  excluded.sort((x, y) => compareText(x.name, y.name) || compareText(x.id, y.id));
  const plus = bars
    .filter((b) => b.totalMinutes > 0)
    .sort(compareBars(1))
    .slice(0, topN);
  const minus = bars
    .filter((b) => b.totalMinutes < 0)
    .sort(compareBars(-1))
    .slice(0, topN);
  return {
    counted: bars.length,
    medianMinutes: medianOf(bars.map((b) => b.totalMinutes)),
    plus,
    minus,
    diverging: [...plus, ...[...minus].reverse()],
    excluded,
  };
}

/** A table cell as text; the title explains a dash or an aggregated window. */
export interface TeamSaldoCell {
  text: string;
  title?: string;
}

export interface TeamSaldoCells {
  /** The closed part (Bestätigt). */
  confirmed: TeamSaldoCell;
  /** The running part since the last Monatsabschluss. */
  open: TeamSaldoCell;
  total: TeamSaldoCell;
}

const DASH = "—";

/** The three saldo cells of a row, every number as ±H:MM. */
export function teamSaldoCells(row: TeamSaldoRow): TeamSaldoCells {
  const confirmed: TeamSaldoCell =
    row.hasClosedMonth === false
      ? { text: DASH, title: "noch kein Monatsabschluss" }
      : typeof row.confirmedMinutes === "number"
        ? { text: fmtBalance(row.confirmedMinutes) }
        : { text: DASH };
  const open: TeamSaldoCell =
    typeof row.openMonthMinutes === "number"
      ? { text: fmtBalance(row.openMonthMinutes) }
      : { text: DASH };
  if (typeof row.unconfirmedMonths === "number" && row.unconfirmedMonths > 1) {
    open.title = `${row.unconfirmedMonths} Monate ohne Monatsabschluss`;
  }
  return { confirmed, open, total: { text: fmtBalance(totalMinutesOf(row)) } };
}

// ── The period table (Issue #612) ────────────────────────────────────────────────────────────

/**
 * Issue #612 - the table "Zeiten & Konten" reads the SAME rule for a period: the fields of a
 * `GET /reports/period` row the median needs. Not the overview row: a period row has no live
 * `openMonthMinutes`, so the facts map as follows (P-12).
 */
export interface PeriodSaldoRow {
  employeeId: string;
  employeeName: string;
  /** The Gesamtsaldo of the person's last listed month; null where it is withheld or has none. */
  closingBalanceMinutes: number | null;
  /** False when no listed month has a Soll (exempt, no contract, MONTHLY_HOURS without hours). */
  labelled: boolean;
  /** Absent in an older cached answer: an absent fact never excludes a person. */
  hasRecordedTime?: boolean;
}

export interface PeriodSaldoExcluded {
  employeeId: string;
  name: string;
  reason: TeamSaldoExclusionReason;
  reasonLabel: string;
}

export interface PeriodSaldoFigures {
  /** Persons that count for the median. */
  counted: number;
  /** The median of the counted closing saldi in minutes, or null when nobody counts. */
  medianMinutes: number | null;
  /** Persons who do not count, each with one reason, ordered by name then id. */
  excluded: PeriodSaldoExcluded[];
}

/**
 * The reason a period row does not count. A person without a Soll in the period is track-only
 * (TIME_TRACKING_ONLY: the saldo of such a contract says nothing about the team, rule (c) of the
 * module header); a withheld or missing closing saldo with a Soll is SALDO_UNAVAILABLE; a person
 * who never recorded time is NO_RECORDED_TIME. The display wording stays in the label table above.
 */
export function periodSaldoExclusion(row: PeriodSaldoRow): TeamSaldoExclusionReason | null {
  if (!row.labelled) return "TIME_TRACKING_ONLY";
  if (row.closingBalanceMinutes === null) return "SALDO_UNAVAILABLE";
  if (row.hasRecordedTime === false) return "NO_RECORDED_TIME";
  return null;
}

/** The team figure of a period answer: the median of the closing saldi of the persons who count. */
export function periodSaldoFigures(rows: readonly PeriodSaldoRow[]): PeriodSaldoFigures {
  const counted: number[] = [];
  const excluded: PeriodSaldoExcluded[] = [];
  for (const row of rows) {
    const reason = periodSaldoExclusion(row);
    if (reason === null) {
      counted.push(row.closingBalanceMinutes as number);
    } else {
      excluded.push({
        employeeId: row.employeeId,
        name: row.employeeName,
        reason,
        reasonLabel: TEAM_SALDO_EXCLUSION_LABEL[reason],
      });
    }
  }
  excluded.sort((x, y) => compareText(x.name, y.name) || compareText(x.employeeId, y.employeeId));
  return { counted: counted.length, medianMinutes: medianOf(counted), excluded };
}
