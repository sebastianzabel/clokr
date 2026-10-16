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
