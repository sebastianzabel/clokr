// Phase 67.2 — Single source of truth for FederalState enum ↔ ISO-3166-2 mapping.
//
// Background: Clokr stores Bundesländer as a Prisma enum (BAYERN, NIEDERSACHSEN, …),
// but external APIs (OpenHolidays, schulferien-api) speak ISO-3166-2 codes (DE-BY,
// DE-NI, …). RESEARCH §198 calls out "ad-hoc 16-place hardcoding" as an anti-pattern;
// this module is the only place in the codebase that knows the translation.
//
// Contract:
//   - federalStateToIso(fs): always returns the 5-char DE-XX code (no nulls)
//   - isoToFederalState(iso): returns null for unknown codes (caller decides)
//   - ALL_FEDERAL_STATES: convenience export for iteration

import { FederalState } from "@clokr/db";

// Keep alphabetical by enum value for diff-stability.
const ENUM_TO_ISO: Record<FederalState, string> = {
  BADEN_WUERTTEMBERG: "DE-BW",
  BAYERN: "DE-BY",
  BERLIN: "DE-BE",
  BRANDENBURG: "DE-BB",
  BREMEN: "DE-HB",
  HAMBURG: "DE-HH",
  HESSEN: "DE-HE",
  MECKLENBURG_VORPOMMERN: "DE-MV",
  NIEDERSACHSEN: "DE-NI",
  NORDRHEIN_WESTFALEN: "DE-NW",
  RHEINLAND_PFALZ: "DE-RP",
  SAARLAND: "DE-SL",
  SACHSEN: "DE-SN",
  SACHSEN_ANHALT: "DE-ST",
  SCHLESWIG_HOLSTEIN: "DE-SH",
  THUERINGEN: "DE-TH",
};

const ISO_TO_ENUM: Record<string, FederalState> = Object.fromEntries(
  (Object.entries(ENUM_TO_ISO) as Array<[FederalState, string]>).map(([k, v]) => [v, k]),
);

export function federalStateToIso(fs: FederalState): string {
  return ENUM_TO_ISO[fs];
}

export function isoToFederalState(iso: string): FederalState | null {
  return ISO_TO_ENUM[iso] ?? null;
}

export const ALL_FEDERAL_STATES: FederalState[] = Object.keys(ENUM_TO_ISO) as FederalState[];
