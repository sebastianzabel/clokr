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
