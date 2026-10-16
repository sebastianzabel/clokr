/**
 * Issue #86, D-01 - the employment history on today's model, as display rows. One WorkSchedule row
 * is one contract version (a change always starts on a month-first, `validFrom`); there is no
 * `validTo` column, so a row ends the calendar day before the next newer row starts (a Beschäftigung
 * entity with its own period, #66, would slot in here later). Read-only display: the page loads the
 * rows through `GET /settings/work/:id/history`, nothing here writes or decides access.
 *
 * Dates follow the page's existing convention for `validFrom`: a UTC-midnight instant read by its
 * UTC calendar day (`snapToMonthFirstUtc` on the server).
 */
import type { ContractHistoryRow } from "$lib/utils/work-schedule";

/** A history row with the figures the extent column needs; Decimal columns arrive as strings. */
export interface ContractHistoryInput extends ContractHistoryRow {
  weeklyHours?: string | number | null;
  monthlyHours?: string | number | null;
}

export interface ContractHistoryDisplayRow {
  id: string;
  /** „seit 01.10.2026“ for the newest row, „01.06.2026 – 30.09.2026“ otherwise. */
  period: string;
  /** German model label, e.g. „Gleitzeit“. */
  model: string;
  /** „38,5 Std./Woche“, „60 Std./Monat“ or „5 Tage/Woche“; „–“ when the row carries no figure. */
  extent: string;
}

const MODEL_LABELS: Record<string, string> = {
  FIXED_SCHEDULE: "Fester Stundenplan",
  FLEXTIME: "Gleitzeit",
  MONTHLY_HOURS: "Monatsstunden",
  SHIFT_BASED: "Schichtplan",
};

function formatNumber(n: number): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
}

function positiveNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatDay(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

function extentOf(row: ContractHistoryInput): string {
  switch (row.type) {
    case "FIXED_SCHEDULE":
    case "FLEXTIME": {
      const h = positiveNumber(row.weeklyHours);
      return h === null ? "–" : `${formatNumber(h)} Std./Woche`;
    }
    case "MONTHLY_HOURS": {
      const h = positiveNumber(row.monthlyHours);
      return h === null ? "–" : `${formatNumber(h)} Std./Monat`;
    }
    case "SHIFT_BASED": {
      const d = row.contractWorkDaysPerWeek;
      return typeof d === "number" && d > 0 ? `${d} Tage/Woche` : "–";
    }
    default:
      return "–";
  }
}

/** Newest first; the input array is not mutated. */
export function contractHistoryRows(
  rows: readonly ContractHistoryInput[],
): ContractHistoryDisplayRow[] {
  const sorted = [...rows].sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom));
  return sorted.map((row, i) => {
    const start = new Date(row.validFrom);
    let period = `seit ${formatDay(start)}`;
    if (i > 0) {
      const end = new Date(Date.parse(sorted[i - 1].validFrom) - 24 * 60 * 60 * 1000);
      period =
        end.getTime() >= start.getTime()
          ? `${formatDay(start)} – ${formatDay(end)}`
          : formatDay(start);
    }
    return {
      id: row.id,
      period,
      model: MODEL_LABELS[row.type] ?? row.type,
      extent: extentOf(row),
    };
  });
}
