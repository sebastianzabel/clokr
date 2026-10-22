/**
 * Issue #558 D-03/D-04 — the one module every salon-filtered page imports.
 *
 * It adds no decision of its own. Whether a page filters stays `teamSalonFilter()` /
 * `showSalonOptions()` (a single-salon tenant or a one-salon caller never sends a `salonId`, because
 * the store preselects the sole reachable salon and that preselection must not become a filter);
 * this module only gives pages a name that does not point into the dashboard, and the German
 * wording of the label that tells the reader what the shown people and rows refer to.
 *
 * Presentation only (#82 D-05): the API validates every `salonId` independently and answers one 404
 * for every rejection cause. Pure, no `$app/*` import, so it is directly testable.
 */
import {
  isTeamSalonRejected,
  teamSalonFilter,
  teamViewLabel,
  TEAM_SOLL_NOT_ATTRIBUTABLE_NOTE,
  withSalonId,
} from "../dashboard/team-view";

/** The store state the filter decision needs; derived so this module never names its inputs. */
type PageScopeState = Parameters<typeof teamSalonFilter>[0];

/** The salon a page sends as `salonId`, or null — the SAME function as `teamSalonFilter`. */
export const salonPageFilter = teamSalonFilter;

/** Appends `salonId` to a request path; null leaves the path untouched. */
export { withSalonId };

/** True for the one 404 every inadmissible salon answers (foreign, unknown, inactive, out of reach). */
export const isSalonFilterRejected = isTeamSalonRejected;

/** Shown instead of the filtered data when the server rejects the chosen salon (404). */
export const SALON_VIEW_UNAVAILABLE_TEXT =
  "Für diesen Salon liegen hier keine Daten vor. Wählen Sie in der Kopfleiste „Alle Salons“ oder einen anderen Salon.";

/** Why a Soll figure is missing under a salon filter (re-exported so pages share one wording). */
export const SALON_SOLL_NOT_ATTRIBUTABLE_NOTE = TEAM_SOLL_NOT_ATTRIBUTABLE_NOTE;

/** The label for one named salon. The name is display only and never compared. */
export function salonNameLabel(name: string): string {
  return `Salon: ${name}`;
}

/**
 * What a filtered page says its content refers to: nothing while no salon options are shown,
 * „Alle Salons“ without a chosen salon, otherwise „Salon: <Name>“.
 */
export function salonScopeLabel(state: PageScopeState): string | null {
  const name = teamViewLabel(state);
  if (name === null) return null;
  if (salonPageFilter(state) === null) return "Alle Salons";
  return salonNameLabel(name);
}

/**
 * Issue #542 (OD-1, 16.10.2026) — what the Überstunden-Übersicht says under a salon filter: the
 * list holds the persons whose Stammsalon is the chosen salon, each with the whole personal saldo.
 */
export const SALON_HOME_PERSONS_NOTE = "Personen nach Stammsalon";

/**
 * Issue #542 (OD-2, 17.10.2026) — the Monatsexport counterpart. Mirrors
 * `EXPORT_SALON_PERSONS_LABEL` of `apps/api/src/composition/pdf.ts` (pinned equal by a text test).
 */
export const SALON_EXPORT_PERSONS_NOTE = "Personen nach Stammsalon am Monatsende";

/**
 * Issue #542 (OD-1/OD-2) — a saldo is a person's, never a salon's share. Mirrors
 * `PERSON_SALDO_NOT_SPLIT_LABEL` of `apps/api/src/composition/pdf.ts` (pinned equal by a text test).
 */
export const PERSON_SALDO_NOT_SPLIT_LABEL = "Personensaldo, nicht nach Salon aufgeteilt";

/**
 * Issue #542 (P-08) — shown on a block that deliberately ignores the header salon (the vacation
 * overview and the carry-over warnings), so a chosen salon is never read as their filter.
 */
export const ALL_SALONS_BLOCK_NOTE = "Gilt für alle Salons Ihrer Reichweite";

/** Issue #542 (OD-2, P-08) — the DATEV card under a salon filter: the payroll file stays complete. */
export const DATEV_ALL_SALONS_NOTE = "DATEV gilt für alle Salons Ihrer Reichweite";

/**
 * Issue #542 (orchestrator amendment 5) — a person without a Stammsalon on their Stichtag belongs
 * to no salon's Monatsexport; there is no second membership rule, so the unfiltered export is the
 * only one that lists them.
 */
export const EXPORT_NO_STAMMSALON_NOTE =
  "Personen ohne Stammsalon am Stichtag erscheinen nur im Export ohne Salonauswahl.";

/**
 * Issue #612 (P-06) - the vacation table of the period report under a salon filter: the persons
 * whose Stammsalon is the chosen salon on the LAST day of the period (the Monatsexport rule), each
 * with the whole personal values. Shown next to `PERSON_VALUES_NOT_SPLIT_LABEL`.
 */
export const SALON_PERIOD_END_PERSONS_NOTE = "Personen nach Stammsalon am Ende des Zeitraums";

/** Issue #612 (P-06) - a vacation figure is a person's, never a salon's share. */
export const PERSON_VALUES_NOT_SPLIT_LABEL = "Personenwerte, nicht nach Salon aufgeteilt";

/**
 * Issue #612 (P-07) - the absence statistics under a salon filter keep only the sick row; priced
 * leave days belong to a person, not to the salon they happened to work in.
 */
export const SALON_LEAVE_DAYS_NOT_ATTRIBUTABLE_NOTE =
  "Urlaubs- und andere Abwesenheitstage werden je Salon nicht ausgewiesen.";

/**
 * Issue #612 (orchestrator amendment 16) - who the "Zeiten & Konten" table lists under a salon
 * filter: the #542 salon-view membership rule (`salonViewMemberIds`, the API's one rule), spelled
 * as the reader needs it.
 */
export const SALON_PERIOD_ROWS_NOTE =
  "Personen mit Eintrag in diesem Salon oder Stammsalon an mindestens einem Tag des Zeitraums";

/**
 * Issue #714 (D-04) - the period report under a salon filter: every figure of a listed person is
 * the whole personal value, and the persons are those whose Stammsalon is the chosen salon at the
 * end of the period. Replaces `PERSON_SALDO_NOT_SPLIT_LABEL` on the KPI card and the table.
 */
export const PERSON_SALDO_BY_HOME_SALON_LABEL =
  "Personensaldo nach Stammsalon, nicht nach Salon aufgeteilt";

/**
 * Issue #714 (D-05) - how many persons of the reader's reach have no Stammsalon in an active salon
 * and therefore appear only without a salon choice. The count is the server's; this only words it.
 */
export function withoutHomeSalonNote(count: number): string {
  const persons = count === 1 ? "1 Person" : `${count} Personen`;
  return `${persons} ohne Stammsalon in einem aktiven Salon – nur unter „Alle Salons“ enthalten`;
}

/**
 * Issue #714 (D-03) - where a person who changed the Stammsalon inside the period counts: whole for
 * the Stammsalon at the end, with the hours in the former salon under the salon hours.
 */
export const HOME_SALON_CHANGE_NOTE =
  "Wer im Zeitraum den Stammsalon gewechselt hat, zählt ganz zum Stammsalon am Ende des Zeitraums; die Stunden im früheren Salon stehen dort unter „Im Salon gearbeitet“.";

/** Issue #714 (D-06) - the label of the separate salon-hours figure (KPI tile, column, row value). */
export const SALON_WORKED_LABEL = "Im Salon gearbeitet";

/** Issue #714 (D-06) - the delta text of the salon-hours tile: it names no saldo, only who is in it. */
export const SALON_WORKED_DELTA_NOTE = "inkl. Aushilfen aus anderen Salons";

/** Issue #714 (D-07) - heading of the section listing persons of other salons who worked here. */
export const SALON_HELPERS_HEADING = "Aushilfen aus anderen Salons";

/**
 * Issue #714 (G7, D-07) - a scoped reader sees helpers only from salons inside their reach; the
 * hint keeps a short list from reading as "nobody helped".
 */
export const SALON_HELPERS_REACH_NOTE =
  "Aushilfen aus Salons außerhalb deiner Reichweite erscheinen hier nicht.";

/** Issue #714 (D-09) - what the period CSV lists under a salon filter. */
export const SALON_CSV_PERSONS_NOTE =
  "Die Datei listet die Personen nach Stammsalon am Ende des Zeitraums, ohne Aushilfen aus anderen Salons.";
