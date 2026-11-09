/**
 * Which page a user may open (Issue #83, D-10/D-12/D-16; since #844 D-06 for every page of the route table) —
 * the ONE place the web decides it. Sidebar, BottomTabBar, CommandPalette, the admin and Verwalten layout guards
 * and the Team guard read this module, which reads the permissions of the route table (`routes.ts`).
 *
 * Every entry's `requires` is a list of alternatives, each alternative a set of keys that must ALL be held,
 * because some pages load several reads at once (D-12); each table line names the API guard its page calls.
 * Fail-closed: an unmapped path or an empty alternative grants nothing. A UX gate only — the API's 403 stays the
 * authority. `routes-844.test.ts` pins that #844 kept every pre-#844 alternative unchanged.
 */
import type { PermissionHolder } from "$lib/permissions";
import { matchesRoute } from "$lib/nav/active-route";
import {
  APP_ROUTES,
  LEGACY_ALIASES,
  holdsAlternatives,
  mayOpenPath,
  visibleRoute,
  type PermissionAlternatives,
  type RouteOptions,
} from "$lib/nav/routes";

export { holdsAlternatives };
export type { PermissionAlternatives };

export interface AdminRoutePermission {
  href: string;
  /** The route file (pre-#844 URL); absent for a page created by #844. */
  file?: string;
  requires: PermissionAlternatives;
  /** False for sub-pages, alias routes and internal tool pages (not shown in the rail). */
  inNav: boolean;
  /** An internal tool page (#843): reachable by URL behind its guard, never listed in a navigation,
   *  the command palette or the start-page redirect. */
  internal?: true;
}

/** Every permission-gated page of the route table plus the redirect-only aliases, keyed by the new href. */
export const ADMIN_ROUTE_PERMISSIONS: readonly AdminRoutePermission[] = [
  ...APP_ROUTES.flatMap((route) =>
    Array.isArray(route.requires)
      ? [
          {
            href: route.href,
            file: route.file,
            requires: route.requires,
            inNav: route.inNav,
            ...(route.internal ? { internal: true as const } : {}),
          },
        ]
      : [],
  ),
  ...LEGACY_ALIASES.map((alias) => ({ href: alias.href, requires: alias.requires, inNav: false })),
];

/** A Verwalten page (new URL) or an old `/admin` URL. */
export function isAdminHref(href: string): boolean {
  return matchesRoute("/verwalten", href) || matchesRoute("/admin", href);
}

/** The first visible Verwalten entry the user may open, or null (the old `/admin` landing used it). */
export function firstAccessibleAdminHref(user: PermissionHolder | null | undefined): string | null {
  return (
    APP_ROUTES.find(
      (route) =>
        route.area === "verwalten" &&
        route.inNav &&
        route.href !== "/verwalten" &&
        visibleRoute(user, route, { availabilityEnabled: true }),
    )?.href ?? null
  );
}

/** May `user` open `pathname` (a new URL, a sub-path of one, or a redirect-only alias)? */
export function canAccessAdminPath(
  user: PermissionHolder | null | undefined,
  pathname: string,
): boolean {
  return mayOpenPath(user, pathname);
}

export type AdminGuardDecision = "wait" | "allow" | "deny";

/**
 * The guard's decision for `pathname`: "wait" while the permission list is not loaded yet (a stale session from
 * before Phase 378 has none — the layout loads it, never denies on a missing list), "allow" or "deny".
 */
export function adminGuardDecision(
  user: PermissionHolder | null | undefined,
  pathname: string,
): AdminGuardDecision {
  if (!user) return "deny";
  if (user.permissions === undefined) return "wait";
  return canAccessAdminPath(user, pathname) ? "allow" : "deny";
}

export interface AdminNavItem {
  href: string;
  label: string;
  icon: string;
}

/** The Verwalten rail entries the user may open (hubs only when a child is open). */
export function visibleAdminNavItems(
  user: PermissionHolder | null | undefined,
  options: RouteOptions,
): AdminNavItem[] {
  return APP_ROUTES.filter(
    (route) => route.area === "verwalten" && route.inNav && visibleRoute(user, route, options),
  ).map(({ href, label, icon }) => ({ href, label, icon }));
}
