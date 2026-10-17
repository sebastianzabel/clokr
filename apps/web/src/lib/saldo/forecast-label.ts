/**
 * Issue #588 (P-05, P-14, orchestrator amendment 17.10.2026) - the ONE place the wording of the
 * forecast part of a saldo is chosen. Every surface that labels the figure "since the last
 * Monatsabschluss" - the team saldo overview, the dashboard card, the personal saldo views - reads
 * this module, so the wording follows the data and never the surface.
 *
 * The inputs are two facts the server already reports per person (`GET /dashboard/overtime-overview`
 * and the personal saldo endpoints), computed by `computeOvertimeBalanceBreakdown`:
 *   - `unconfirmedMonths`  tenant-local calendar months from the first open day of the live saldo
 *                          window through the current month, inclusive,
 *   - `hasClosedMonth`     whether any month has been closed at all.
 *
 * Three cases, decided in this order:
 *   1. exactly one unconfirmed month            -> "Laufender Monat (Prognose)": the forecast really
 *      is the running month, whether or not an earlier month was closed;
 *   2. otherwise, a closed month exists         -> "Seit Monatsabschluss (Prognose)";
 *   3. otherwise (no closed month yet, or it is unknown) -> "Prognose (seit Eintritt)": the window
 *      starts at the hire day, and "since Monatsabschluss" would name a closing that never happened.
 * A missing or non-positive month count is "unknown" and falls through to case 2 or 3 by
 * `hasClosedMonth` alone, which is true for any count.
 *
 * The PDF wording constants of `composition/pdf.ts` are a different, month-scoped rule and stay.
 *
 * Pure and import-free.
 */

export const FORECAST_LABEL_CURRENT_MONTH = "Laufender Monat (Prognose)";
export const FORECAST_LABEL_SINCE_CLOSE = "Seit Monatsabschluss (Prognose)";
export const FORECAST_LABEL_SINCE_HIRE = "Prognose (seit Eintritt)";
/** A column whose rows disagree and cannot all be named by one of the three labels above. */
export const FORECAST_LABEL_MIXED = "Prognose (offener Zeitraum)";

export const FORECAST_CAPTION_CURRENT_MONTH = "inkl. laufendem Monat";
export const FORECAST_CAPTION_SINCE_CLOSE = "inkl. Zeitraum seit Monatsabschluss";
export const FORECAST_CAPTION_SINCE_HIRE = "inkl. Zeitraum seit Eintritt";

/** What a surface knows about one person's forecast window. Both facts may be absent (unknown). */
export interface ForecastWindow {
  unconfirmedMonths?: number | null;
  hasClosedMonth?: boolean | null;
}

type ForecastKind = "CURRENT_MONTH" | "SINCE_CLOSE" | "SINCE_HIRE";

function forecastKind(
  unconfirmedMonths: number | null | undefined,
  hasClosedMonth: boolean | null | undefined,
): ForecastKind {
  if (unconfirmedMonths === 1) return "CURRENT_MONTH";
  return hasClosedMonth === true ? "SINCE_CLOSE" : "SINCE_HIRE";
}

const LABEL: Record<ForecastKind, string> = {
  CURRENT_MONTH: FORECAST_LABEL_CURRENT_MONTH,
  SINCE_CLOSE: FORECAST_LABEL_SINCE_CLOSE,
  SINCE_HIRE: FORECAST_LABEL_SINCE_HIRE,
};

const CAPTION: Record<ForecastKind, string> = {
  CURRENT_MONTH: FORECAST_CAPTION_CURRENT_MONTH,
  SINCE_CLOSE: FORECAST_CAPTION_SINCE_CLOSE,
  SINCE_HIRE: FORECAST_CAPTION_SINCE_HIRE,
};

/** The label of one person's forecast figure. */
export function forecastLabel(
  unconfirmedMonths: number | null | undefined,
  hasClosedMonth?: boolean | null,
): string {
  return LABEL[forecastKind(unconfirmedMonths, hasClosedMonth)];
}

/** The caption under a total ("inkl. ...") for one person. */
export function forecastCaption(
  unconfirmedMonths: number | null | undefined,
  hasClosedMonth?: boolean | null,
): string {
  return CAPTION[forecastKind(unconfirmedMonths, hasClosedMonth)];
}

/**
 * The header of a table column that shows the forecast of many persons: the label every row
 * shares; "Seit Monatsabschluss (Prognose)" when rows differ but every row has a closed month
 * (a one-month row is "since the last closing" as well); otherwise the neutral
 * "Prognose (offener Zeitraum)". An empty table claims nothing and gets the neutral label.
 */
export function forecastColumnLabel(rows: readonly ForecastWindow[]): string {
  if (rows.length === 0) return FORECAST_LABEL_MIXED;
  const kinds = new Set(rows.map((r) => forecastKind(r.unconfirmedMonths, r.hasClosedMonth)));
  if (kinds.size === 1) return LABEL[[...kinds][0]];
  if (rows.every((r) => r.hasClosedMonth === true)) return FORECAST_LABEL_SINCE_CLOSE;
  return FORECAST_LABEL_MIXED;
}
