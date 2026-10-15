/**
 * The sixteen Bundesländer of a salon (Issue #563), one list for the tenant app.
 *
 * The values are the Prisma `FederalState` enum; `salon-form.test.ts` pins the two against each
 * other. Tenant-only module: the operator console keeps its own copy and is never imported here.
 */

export type FederalStateCode =
  | "BADEN_WUERTTEMBERG"
  | "BAYERN"
  | "BERLIN"
  | "BRANDENBURG"
  | "BREMEN"
  | "HAMBURG"
  | "HESSEN"
  | "MECKLENBURG_VORPOMMERN"
  | "NIEDERSACHSEN"
  | "NORDRHEIN_WESTFALEN"
  | "RHEINLAND_PFALZ"
  | "SAARLAND"
  | "SACHSEN"
  | "SACHSEN_ANHALT"
  | "SCHLESWIG_HOLSTEIN"
  | "THUERINGEN";

export interface FederalStateOption {
  value: FederalStateCode;
  label: string;
}

const LABELS: Record<FederalStateCode, string> = {
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

/** Every Bundesland, sorted by its German label. */
export const FEDERAL_STATE_OPTIONS: readonly FederalStateOption[] = (
  Object.entries(LABELS) as [FederalStateCode, string][]
)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label, "de"));

/** German label of a stored value; an unknown value is returned as it is, no value as a dash. */
export function federalStateLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return (LABELS as Record<string, string | undefined>)[code] ?? code;
}
