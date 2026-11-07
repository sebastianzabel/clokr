// Issue #835 — German display wording of the leave planner (du-form). Display only: a label is
// never compared or used as a control value; states and kinds are decided by their codes.
import { LEAVE_TYPES, NEUTRAL_CHIP_LABEL } from "$lib/leave/team-calendar-visibility";
import type { PlannerRow, TakeoverPendingReason } from "./types";

export const PLAN_STATUS_LABELS = {
  OPEN: "Offen",
  TAKEN_OVER: "Übernommen",
  PARTIALLY_TAKEN_OVER: "Teilweise übernommen",
} as const;

export function planStatusLabel(plan: {
  status: "OPEN" | "TAKEN_OVER";
  partiallyTakenOver: boolean;
}): string {
  if (plan.status === "TAKEN_OVER") return PLAN_STATUS_LABELS.TAKEN_OVER;
  return plan.partiallyTakenOver
    ? PLAN_STATUS_LABELS.PARTIALLY_TAKEN_OVER
    : PLAN_STATUS_LABELS.OPEN;
}

export const ROW_STATE_LABELS = {
  GESETZT: "gesetzt",
  BEANTRAGT: "beantragt",
  WISH: "Wunsch",
} as const;

export const ROW_KIND_LABELS: Record<PlannerRow["kind"], string> = {
  LEAVE: "Urlaub",
  ABSENCE: "Abwesenheit",
  COMPANY_SHUTDOWN: "Betriebsurlaub",
};

export const HOLIDAY_LABEL = "Feiertag";

/** The label of a row's type: the leave-type display helper, neutral when the type is masked. */
export function rowTypeLabel(row: Pick<PlannerRow, "kind" | "typeCode">): string {
  if (row.kind === "COMPANY_SHUTDOWN") return ROW_KIND_LABELS.COMPANY_SHUTDOWN;
  if (row.typeCode === null) return NEUTRAL_CHIP_LABEL;
  return LEAVE_TYPES.find((t) => t.code === row.typeCode)?.label ?? ROW_KIND_LABELS[row.kind];
}

export const DAY_LOAD_LABEL = "Urlaub";
export const DAY_LOAD_HINT =
  "Genehmigt, beantragt und gewünscht – ohne Krankheit, Berufsschule und Betriebsurlaub";

export const PENDING_REASON_LABELS: Record<TakeoverPendingReason, string> = {
  OWN_WISH: "Eigener Wunsch – wartet auf eine zweite Genehmigung",
  OUTSIDE_APPROVE_REACH: "Wartet auf Genehmigung durch eine berechtigte Person",
  APPROVAL_REFUSED: "Genehmigung gescheitert – erneut übernehmen",
};

export const FORECAST_WARNING = "Der Plan übersteigt den Anspruch";

/** „Noch 12,5 Tage nach Plan“ — the remaining days if the plan were filed as it stands. */
export function forecastLabel(forecastDays: number): string {
  const text = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(forecastDays);
  return `Noch ${text} Tage nach Plan`;
}

export const WISH_CONFLICT_HINT = "Überschneidet sich mit einem Antrag";
export const WISH_TAKEN_OVER_HINT = "Übernommen – nicht mehr änderbar";
export const WISH_FOREIGN_PLAN_HINT = "Wunsch aus einer anderen Planung";
export const WISH_READ_ONLY_HINT = "Du kannst diesen Wunsch nicht ändern.";
export const NO_WISHES_LABEL = "Noch keine Wünsche";
export const ADD_WISH_LABEL = "Wunsch hinzufügen";
