// Issue #598: the ONE wording of a month's status. A month is either closed (Monatsabschluss, its
// figures are stored and final) or open (its figures still change until the close) - every page names
// it the same way: Ich › Zeiten, Ich › Konto and the person view of /reports. "Bis gestern" is a
// cut-off, not a status, and "Prognose"/"Bestätigt" word a saldo figure (forecast-label.ts), not a
// month. `month-status-one-place-598.test.ts` fails on a second spelling of these labels.

export type MonthStatus = "CLOSED" | "OPEN";

export const MONTH_STATUS_LABEL: Readonly<Record<MonthStatus, string>> = {
  CLOSED: "Abgeschlossen",
  OPEN: "Offen",
};

/** The status of a month from whether it is closed. */
export function monthStatusOf(closed: boolean): MonthStatus {
  return closed ? "CLOSED" : "OPEN";
}

/** The label of a month from whether it is closed. */
export function monthStatusLabel(closed: boolean): string {
  return MONTH_STATUS_LABEL[monthStatusOf(closed)];
}
