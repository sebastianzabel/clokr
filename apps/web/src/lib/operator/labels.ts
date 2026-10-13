// German display labels of the operator console (Issue #89). Display only: control decisions
// branch on codes and enum values, never on these strings (D-13).
import { format } from "date-fns";
import { de } from "date-fns/locale";
import type { FederalState } from "@clokr/types";

const LABELS: Record<FederalState, string> = {
  BADEN_WUERTTEMBERG: "Baden-Württemberg",
  BAYERN: "Bayern",
  BERLIN: "Berlin",
  BRANDENBURG: "Brandenburg",
  BREMEN: "Bremen",
  HAMBURG: "Hamburg",
  HESSEN: "Hessen",
  MECKLENBURG_VORPOMMERN: "Mecklenburg-Vorpommern",
  NIEDERSACHSEN: "Niedersachsen",
  NORDRHEIN_WESTFALEN: "Nordrhein-Westfalen",
  RHEINLAND_PFALZ: "Rheinland-Pfalz",
  SAARLAND: "Saarland",
  SACHSEN: "Sachsen",
  SACHSEN_ANHALT: "Sachsen-Anhalt",
  SCHLESWIG_HOLSTEIN: "Schleswig-Holstein",
  THUERINGEN: "Thüringen",
};

export const FEDERAL_STATE_OPTIONS: ReadonlyArray<{ value: FederalState; label: string }> = (
  Object.entries(LABELS) as Array<[FederalState, string]>
)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label, "de"));

export function federalStateLabel(value: FederalState): string {
  return LABELS[value];
}

/** `dd.MM.yyyy` in the German format; an unparsable value is shown as a dash. */
export function formatOperatorDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return format(date, "dd.MM.yyyy", { locale: de });
}
