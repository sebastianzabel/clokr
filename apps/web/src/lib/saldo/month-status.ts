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

/**
 * Issue #854 (owner review): the API reports a month that has not ended yet as `future`. The web words it
 * „Läuft noch“ for the current month and „Zukunft“ for a later one; the API value stays unchanged.
 */
export const NOT_ENDED_MONTH_LABEL = {
  RUNNING: "Läuft noch",
  LATER: "Zukunft",
} as const;

/** `today` is a `YYYY-MM-DD` calendar day; the month counts as running when it is today's month. */
export function notEndedMonthLabel(year: number, month: number, today: string): string {
  const [y, m] = today.split("-").map(Number);
  return year === y && month === m ? NOT_ENDED_MONTH_LABEL.RUNNING : NOT_ENDED_MONTH_LABEL.LATER;
}
