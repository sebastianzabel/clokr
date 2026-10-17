/**
 * Issue #588 - the ONE place for team saldo figures in the web. The dashboard card and `/reports`
 * read this module; no second median or Top list exists anywhere (the full rule text follows with
 * the complete module).
 *
 * Pure: no Svelte, no store, no fetch, no `Date`.
 */

/** The fields of an overview row (`GET /dashboard/overtime-overview`) the team figures read. */
export interface TeamSaldoRow {
  id: string;
  name: string;
  /** Absent in an older cached answer: such a row belongs to the team. */
  exitedWithOpenFinalSaldo?: boolean;
  balanceHours: number;
  confirmedMinutes?: number;
  openMonthMinutes?: number | null;
  hasClosedMonth?: boolean;
  /** Issue #588: absent in an older cached answer - an absent fact never excludes a person. */
  hasRecordedTime?: boolean;
}

/** Why a person is listed instead of counted. */
export type TeamSaldoExclusionReason = "NO_RECORDED_TIME";

/** The display wording of an exclusion reason (the code is the control value, this is display only). */
export const TEAM_SALDO_EXCLUSION_LABEL: Record<TeamSaldoExclusionReason, string> = {
  NO_RECORDED_TIME: "ohne Erfassung",
};

export interface TeamSaldoExcluded {
  id: string;
  name: string;
  reason: TeamSaldoExclusionReason;
  reasonLabel: string;
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
  if (row.hasRecordedTime === false) return "NO_RECORDED_TIME";
  return null;
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
  /** Persons that count for the median. */
  counted: number;
  /** The team figure in minutes, or null when nobody counts. */
  medianMinutes: number | null;
  excluded: TeamSaldoExcluded[];
}

/** The team figures of an overview answer (exited rows are ignored: they have their own section). */
export function teamSaldoFigures(rows: readonly TeamSaldoRow[]): TeamSaldoFigures {
  const totals: number[] = [];
  const excluded: TeamSaldoExcluded[] = [];
  for (const row of rows) {
    if (row.exitedWithOpenFinalSaldo === true) continue;
    const reason = teamSaldoExclusion(row);
    if (reason === null) totals.push(totalMinutesOf(row));
    else {
      excluded.push({
        id: row.id,
        name: row.name,
        reason,
        reasonLabel: TEAM_SALDO_EXCLUSION_LABEL[reason],
      });
    }
  }
  return { counted: totals.length, medianMinutes: medianOf(totals), excluded };
}
