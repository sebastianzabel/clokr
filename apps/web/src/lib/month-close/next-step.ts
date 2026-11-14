/**
 * Issue #947 - what the month-close page offers when the gaps of a month lie in days the reader may
 * not see (`dayDetailsWithheld`, Issue #86: a reader without `time-entry:read` reach, e.g. the
 * Personalabteilung).
 *
 * Decision (documented in the PR): the server lets a holder of `month-close:close` close such a month
 * with `confirmGaps` (the days then count as 0 h and the saldo drops), so closing is NOT forbidden.
 * But closing blind must never look like the normal, safe path. A month or person with withheld gaps
 * therefore shows the next step in words (ask the salon manager to check the times) and offers the
 * close only as the secondary "close anyway" button, which opens the existing dialog with the gap
 * count and the acknowledgement. UX only - what a caller may do is decided by the API.
 */
import { DAY_DETAILS_WITHHELD_HINT, gapCountOf, type DayListRow } from "$lib/month-close/day-lists";

/** One person whose gap days the reader cannot see. */
export interface WithheldGapPerson {
  name: string;
  count: number;
}

/** The short rights line next to the affected row (replaces the page-wide hint). */
export const WITHHELD_RIGHTS_LINE = DAY_DETAILS_WITHHELD_HINT;

/** "Berta Probe" -> "Berta P." */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
  return name;
}

/** Rows with a gap the reader may not see: withheld AND a server count above zero. */
export function withheldGapPersons(
  rows: ReadonlyArray<DayListRow & { employeeName: string }>,
): WithheldGapPerson[] {
  return rows
    .filter((r) => r.dayDetailsWithheld === true && gapCountOf(r) > 0)
    .map((r) => ({ name: shortName(r.employeeName), count: gapCountOf(r) }));
}

function dayCountText(count: number): string {
  return count === 1 ? "1 Tag ohne Eintrag" : `${count} Tage ohne Eintrag`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} und ${names[names.length - 1]}`;
}

/** The next-step sentence for the salon manager: the person(s) and the count of gap days. */
export function nextStepText(persons: readonly WithheldGapPerson[]): string {
  if (persons.length === 0) return "";
  const total = persons.reduce((sum, p) => sum + p.count, 0);
  const names = joinNames(persons.map((p) => p.name));
  const detail = persons.length === 1 ? dayCountText(total) : `zusammen ${dayCountText(total)}`;
  return `Bitte die Salonleitung, die Zeiten von ${names} zu prüfen (${detail}).`;
}

/** True when closing would take days the reader cannot see: the close needs the extra confirmation. */
export function closesBlind(rows: ReadonlyArray<DayListRow>): boolean {
  return rows.some((r) => r.dayDetailsWithheld === true && gapCountOf(r) > 0);
}

export const CLOSE_LABEL = "Abschließen";
export const CLOSE_BLIND_LABEL = "Trotzdem abschließen";

/** The label of the close button of a row: the normal one, or the secondary blind variant. */
export function closeLabelFor(rows: ReadonlyArray<DayListRow>): string {
  return closesBlind(rows) ? CLOSE_BLIND_LABEL : CLOSE_LABEL;
}

/** Last day of the month on which the automatic close still tries. */
export const AUTO_CLOSE_LAST_DAY = 10;

/** The note above the months while something is open; null when nothing is. */
export function autoCloseHintText(dayOfMonth: number, hasOpenMonths: boolean): string | null {
  if (!hasOpenMonths) return null;
  if (dayOfMonth <= AUTO_CLOSE_LAST_DAY) {
    return `Der automatische Abschluss versucht es noch bis zum ${AUTO_CLOSE_LAST_DAY}. des Monats.`;
  }
  return (
    `Der automatische Abschluss läuft nur bis zum ${AUTO_CLOSE_LAST_DAY}. des Monats und ist für diesen Monat vorbei. ` +
    "Schließe die offenen Monate selbst ab, sobald die Zeiten geprüft sind."
  );
}

/** KPI "Bereit": label and explanation read as label and caption, not as a statement. */
export const READY_KPI = {
  label: "Bereit",
  explanation: "Monate, in denen alle Personen bereit sind",
};
