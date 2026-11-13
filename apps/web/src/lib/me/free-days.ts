// Issue #605: the saldo in free days and the way from the Stundenkonto to an Überstundenausgleich
// request. The figure is an answer of Arbeitszeitkonto (`freeDaysEquivalent` of GET /overtime/:id,
// already null for saldo <= 0, track-only contracts, no daily Soll and tenants without the leave
// type); this module only words it and builds the link. It computes no Soll and no conversion.

/** The query value of the request dialog's type, matched by the leave type CODE in the leave page. */
export const OVERTIME_COMP_ANTRAG = "ausgleich";

/** Where the button leads: the request dialog on Ich › Abwesenheiten, preset to Überstundenausgleich. */
export const OVERTIME_COMP_REQUEST_HREF = `/ich/abwesenheiten?antrag=${OVERTIME_COMP_ANTRAG}`;

/** The one answer fields the Konto page reads for the conversion. */
export interface FreeDaysAnswer {
  balanceHours: number;
  freeDaysEquivalent?: number | null;
}

/** The conversion and the button show only for a positive saldo with a served, positive figure. */
export function showFreeDays(overtime: FreeDaysAnswer | null | undefined): boolean {
  if (!overtime) return false;
  const days = overtime.freeDaysEquivalent;
  return overtime.balanceHours > 0 && typeof days === "number" && days > 0;
}

/** „etwa 1,5 freie Tage“: one decimal, decimal comma. */
export function freeDaysLabel(days: number): string {
  return `etwa ${days.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} freie Tage`;
}

/** The type a leave page `?antrag=` value presets, or null for an unknown value. */
export function antragTypeCode(value: string | null): "VACATION" | "SICK" | "OVERTIME_COMP" | null {
  if (value === "urlaub") return "VACATION";
  if (value === "krank") return "SICK";
  if (value === OVERTIME_COMP_ANTRAG) return "OVERTIME_COMP";
  return null;
}
