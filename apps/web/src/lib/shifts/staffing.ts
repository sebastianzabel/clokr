// Issue #850 — how the shift planner shows a day's Besetzung (staffing).
//
// The API delivers the weighted sum of the counted persons (`effectiveStaff`, a person with
// shift weight 0.5 counts half) and the day's Mindestbesetzung (`minStaff`) from the rule. The
// page shows them as "2 / 3" in German number format: whole numbers without decimals; a real
// fraction (a half-weighted Azubi) keeps its digits with a comma ("1,5 / 2"), because rounding
// would hide why a day is short. Never "1.00 / 2.00".

export type StaffingStatus = "ok" | "under" | "supervision-missing";

export interface StaffingDay {
  effectiveStaff: number;
  minStaff: number;
  hasSupervisor: boolean;
  unsupervisedAzubis: number;
  coverageStatus: StaffingStatus;
}

/** A staffing number in German format: "2", "1,5", "0,75". */
export function formatStaff(n: number): string {
  const rounded = Math.round(Number(n) * 100) / 100;
  return rounded.toLocaleString("de-DE", { maximumFractionDigits: 2, useGrouping: false });
}

/** "2 / 3" — planned against the Mindestbesetzung. */
export function staffingFigure(day: StaffingDay): string {
  return `${formatStaff(day.effectiveStaff)} / ${formatStaff(day.minStaff)}`;
}

/** The short word under the figure. */
export function staffingStatusText(status: StaffingStatus): string {
  switch (status) {
    case "under":
      return "zu wenig";
    case "supervision-missing":
      return "Aufsicht fehlt";
    default:
      return "besetzt";
  }
}

/** The hover text of a day: "2 von 3 besetzt" plus the supervision note. */
export function staffingTooltip(day: StaffingDay | undefined): string {
  if (!day) return "";
  const lines = [
    `${formatStaff(day.effectiveStaff)} von ${formatStaff(day.minStaff)} besetzt (Mindestbesetzung ${formatStaff(day.minStaff)})`,
  ];
  if (day.unsupervisedAzubis > 0) {
    lines.push(
      day.hasSupervisor
        ? `${day.unsupervisedAzubis} aufsichtspflichtige Person(en), Aufsicht vorhanden`
        : `${day.unsupervisedAzubis} aufsichtspflichtige Person(en) ohne Aufsicht`,
    );
  }
  if (day.coverageStatus === "under") lines.push("Unterbesetzt");
  if (day.coverageStatus === "supervision-missing") lines.push("Aufsicht fehlt");
  return lines.join("\n");
}

/** The explanation behind (i) next to the row label — it replaces the old formula footnote. */
export const STAFFING_EXPLANATION =
  "Gezählt werden eingeplante Personen, die an dem Tag verfügbar sind. Wer in Ausbildung ist, kann " +
  "je nach Einstellung nur halb zählen. Die Mindestbesetzung kommt aus den Schichteinstellungen; " +
  "ohne eigene Regel gelten 2 Personen.";
