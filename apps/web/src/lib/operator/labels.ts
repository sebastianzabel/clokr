// German display labels of the operator console (Issue #89). Display only: control decisions
// branch on codes and enum values, never on these strings (D-13).
import { format } from "date-fns";
import { de } from "date-fns/locale";
import type { FederalState } from "@clokr/types";
import type { TenantModule } from "$lib/packages/tenant-modules";
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
 * `dd.MM.yyyy` of a `YYYY-MM-DD` calendar day (Issue #90). Pure string split on purpose: the API
 * sends a UTC day, and parsing it through a Date would shift it by the viewer's time zone.
 * Anything that is not that shape is shown as a dash.
 */
export function formatOperatorDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return "–";
  return `${match[3]}.${match[2]}.${match[1]}`;
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

/**
 * One neutral line per bookable module for the "Pakete" section. The module names come from
 * `TENANT_MODULE_LABELS` (`lib/packages/tenant-modules.ts`), the one web place that names them.
 */
export const TENANT_MODULE_DESCRIPTIONS: Readonly<Record<TenantModule, string>> = {
  CHAIN: "Mehrere aktive Salons bis zum Salon-Kontingent",
  INTEGRATIONS: "Phorest-Synchronisation und API-Schlüssel",
  HARDWARE_CLOCK: "NFC-Terminals und WLAN-Anwesenheit",
  ANALYTICS: "Auswertung nach Tätigkeitsarten",
};
