/**
 * Pure German labels and formatters of the bulk-apply preview dialog (Issue #568, D-07).
 * No date arithmetic: every date arrives from the server as an ISO calendar day.
 */
import type {
  BulkApplyCategory,
  BulkApplyPreview,
  BulkApplyReason,
  ContractValues,
} from "$lib/api/bulk-apply";

export const CATEGORY_LABELS: Record<BulkApplyCategory, string> = {
  MATCHES_DEFAULTS: "Entspricht bisherigen Vorgaben",
  INDIVIDUAL: "Individueller Vertrag",
  NO_CONTRACT: "Kein Vertrag hinterlegt",
};

export const REASON_LABELS: Record<BulkApplyReason, string> = {
  FUTURE_CONTRACT: "Späterer Vertrag bereits angelegt",
  SAME_MONTH_MODEL_SWITCH: "Anderes Arbeitszeitmodell zum Stichtag",
  CONTRACT_AT_DATE_EXISTS: "Vertrag zum Stichtag bereits vorhanden",
  OTHER_SCHEDULE_TYPE: "Anderes Arbeitszeitmodell (z. B. Minijob, Schichtbetrieb)",
  ALREADY_MATCHES_NEW: "Entspricht bereits den neuen Vorgaben",
};

// Monday-first display order of the stored weekday indices (0 = Sunday .. 6 = Saturday).
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT: Record<number, string> = {
  1: "Mo",
  2: "Di",
  3: "Mi",
  4: "Do",
  5: "Fr",
  6: "Sa",
  0: "So",
};

/** "Mo–Do" for a consecutive run of at least three days, otherwise a comma list; Sunday last. */
export function formatWorkDays(workDays: number[]): string {
  const active = new Set(workDays);
  const positions = DISPLAY_ORDER.map((d, i) => (active.has(d) ? i : -1)).filter((i) => i >= 0);
  if (positions.length === 0) return "keine Arbeitstage";

  const runs: number[][] = [];
  for (const pos of positions) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === pos - 1) last.push(pos);
    else runs.push([pos]);
  }
  return runs
    .map((run) => {
      const first = DAY_SHORT[DISPLAY_ORDER[run[0]]];
      const end = DAY_SHORT[DISPLAY_ORDER[run[run.length - 1]]];
      if (run.length === 1) return first;
      return `${first}–${end}`;
    })
    .join(", ");
}

/** "16 h · Mo–Do"; null renders the missing contract. */
export function formatContract(values: ContractValues | null): string {
  if (values === null) return "kein Vertrag hinterlegt";
  const hours =
    values.weeklyHours === null
      ? "Wochenstunden fehlen"
      : `${values.weeklyHours.toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`;
  return `${hours} · ${formatWorkDays(values.workDays)}`;
}

/** "2026-11-01" -> "01.11.2026" (string split, no timezone involved). */
export function formatDateDe(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export function summaryLine(count: number, effectiveFrom: string): string {
  if (count <= 0) return "Kein Vertrag ausgewählt";
  const date = formatDateDe(effectiveFrom);
  return count === 1
    ? `1 Vertrag wird ab ${date} geändert`
    : `${count} Verträge werden ab ${date} geändert`;
}

/** The selection a fresh preview starts with: exactly the server's `defaultSelected` rows. */
export function initialSelection(preview: Pick<BulkApplyPreview, "candidates">): Set<string> {
  return new Set(preview.candidates.filter((c) => c.defaultSelected).map((c) => c.employeeId));
}
