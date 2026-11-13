// Issue #835 (WR-07) — the `?salonId=` of a planner deep link (the LEAVE_PLAN_OPENED notification
// links to `/leave/planung?salonId=…&year=…`). Presentation only, like the salon context itself
// (#82): the link may only PRESELECT a salon the caller already reaches; the API validates the salon
// of every planner read against the caller's reach regardless.
import type { SalonContextState } from "$stores/salon-context";

/**
 * The salon a deep link names, when it is one of the caller's reachable salons (the salon context's
 * list); `null` for no parameter and for a foreign, unknown, inactive or manipulated id.
 */
export function deepLinkSalon(
  param: string | null,
  state: Pick<SalonContextState, "salons">,
): string | null {
  if (param === null || param === "") return null;
  return state.salons.some((salon) => salon.id === param) ? param : null;
}
