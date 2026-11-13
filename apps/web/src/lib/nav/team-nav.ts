/**
 * Phase 378 (Issue #378) — the Team area's nav entries and their permissions; since #844 a view of the route
 * table (`routes.ts`, area `team`), which carries the permissions unchanged:
 *   - Salonmanager (Salon-Scope) sees Aufgaben, Zeiten, Abwesenheiten, Dienstplan (and Heute im Salon).
 *   - Ausbilder (Personen-Scope) sees only Zeiten, Abwesenheiten — no Aufgaben (no approve permission), no
 *     Dienstplan (only `shift:read`, the page has no read-only mode).
 *   - Berichte moved to Verwalten (Z-03).
 */
import type { PermissionHolder } from "$lib/permissions";
import {
  APP_ROUTES,
  mayOpenRoute,
  routeByKey,
  visibleRoute,
  type RouteOptions,
} from "$lib/nav/routes";

export interface TeamNavItem {
  href: string;
  label: string;
  icon: string;
}

/** The Team nav items `user` may open, in table order. Empty for a plain Mitarbeiter — callers hide the whole
 *  "Team" area then. `options` defaults to the availability feature off (its entry hidden). */
export function visibleTeamNavItems(
  user: PermissionHolder | null | undefined,
  options: RouteOptions = { availabilityEnabled: false },
): TeamNavItem[] {
  return APP_ROUTES.filter(
    (route) => route.area === "team" && route.inNav && visibleRoute(user, route, options),
  ).map(({ href, label, icon }) => ({ href, label, icon }));
}

/**
 * Issue #86 (AC-86-3) - may `user` open the team page `href` (new URL or route file, e.g. "/team/leave")?
 * Answers from the same table entry as the nav, so a page that guards itself by this function and the nav entry
 * that links to it can never disagree. UX only - the API refuses a caller without the permission anyway. An href
 * that is not a Team entry is refused (fail-closed).
 */
export function mayOpenTeamPage(href: string, user: PermissionHolder | null | undefined): boolean {
  const route = routeByKey(href);
  return route !== null && route.area === "team" && mayOpenRoute(user, route);
}
