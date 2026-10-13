// German display labels of the operator console (Issue #89). Display only: control decisions
// branch on codes and enum values, never on these strings (D-13).
import { format } from "date-fns";
import { de } from "date-fns/locale";
import type { FederalState } from "@clokr/types";
import { CONNECTION_TEXT, RATE_LIMIT_TEXT, SERVER_FAULT_TEXT } from "./reasons";

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

/**
 * The sentence a failed load shows. Distinguishes the three causes the operator can act on
 * (no connection, server fault, rate limit) and falls back to the caller's page-specific text for
 * everything else. It reads the numeric `status` only - never a message text (D-13).
 */
export function describeLoadError(error: unknown, fallback: string): string {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== "number") {
    return error instanceof TypeError ? CONNECTION_TEXT : fallback;
  }
  if (status === 429) return RATE_LIMIT_TEXT;
  if (status >= 500) return SERVER_FAULT_TEXT;
  return fallback;
}
