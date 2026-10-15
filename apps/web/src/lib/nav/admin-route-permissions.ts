/**
 * Which `/admin` route a user may open (Issue #83, D-10/D-12/D-16) — the ONE place the web decides
 * it. Sidebar, BottomTabBar, CommandPalette and the admin layout guard read this module.
 *
 * Every entry is derived from the API guards its page calls (the comment names the guard). An
 * entry's `requires` is a list of alternatives, each alternative a set of keys that must ALL be
 * held, because some pages load several reads at once (D-12). Fail-closed: an unmapped path or an
 * empty alternative grants nothing. A UX gate only — the API's 403 stays the authority.
 */
import { hasPermission, type PermissionHolder } from "$lib/permissions";
import { activeNavHref, matchesRoute } from "$lib/nav/active-route";

export type PermissionAlternatives = readonly (readonly string[])[];

export interface AdminRoutePermission {
  href: string;
  requires: PermissionAlternatives;
  /** False for alias routes that only redirect (not shown in any navigation). */
  inNav: boolean;
  /** Group, label and icon of a navigable route (docs/ADMIN_STRUCTURE.md §1). */
  nav?: { group: string; label: string; icon: string };
}

const Z = (resourceAction: string) => `${resourceAction}:ZUGEWIESEN`;

/** One navigable route: group, label, icon and the alternatives (each an all-of key set). */
function navRoute(
  href: string,
  group: string,
  label: string,
  icon: string,
  ...requires: string[][]
): AdminRoutePermission {
  return { href, requires, inNav: true, nav: { group, label, icon } };
}

/** An alias route that only redirects; never shown in a navigation. */
function aliasRoute(href: string, ...requires: string[][]): AdminRoutePermission {
  return { href, requires, inNav: false };
}

// Each line names the API guard(s) its page calls.
export const ADMIN_ROUTE_PERMISSIONS: readonly AdminRoutePermission[] = [
  // GET /employees
  navRoute("/admin/employees", "PERSONAL", "Mitarbeitende", "users", [Z("employee:read")]),
  // no read guard; the page's writes decide (PUT /settings/work, /settings/leave-types)
  navRoute(
    "/admin/vacation",
    "PERSONAL",
    "Urlaubsverwaltung",
    "umbrella",
    [Z("tenant-settings:update")],
    [Z("leave-config:manage")],
  ),
  // writes /company-shutdowns
  navRoute("/admin/shutdowns", "PERSONAL", "Betriebsurlaub", "calendar", [
    Z("company-shutdown:manage"),
  ]),
  // Promise.all of templates/coverage, week, patterns
  navRoute("/admin/shifts", "PLANUNG", "Schichtplan", "grid", [
    Z("shift-config:manage"),
    Z("shift:read"),
    Z("shift-pattern:read"),
  ]),
  // GET /employees plus GET/PUT /employees/:id/availability
  navRoute(
    "/admin/availability",
    "PLANUNG",
    "Verfügbarkeit",
    "calendar-check",
    [Z("employee:read"), Z("availability:read")],
    [Z("employee:read"), Z("availability:update")],
  ),
  // GET /overtime/close-month/status
  navRoute("/admin/month-close", "COMPLIANCE", "Monatsabschluss", "lock", [Z("month-close:read")]),
  // GET /audit-logs
  navRoute("/admin/audit", "COMPLIANCE", "Audit & Log", "shield", [Z("audit-log:read")]),
  // GET /support-accesses (the end action's extra permission is checked in the page; the API decides)
  navRoute("/admin/support-access", "COMPLIANCE", "Support-Zugriffe", "shield", [
    Z("audit-log:read"),
  ]),
  // POST /imports/employees, POST /imports/time-entries
  navRoute(
    "/admin/import",
    "DATEN",
    "CSV Import",
    "upload",
    [Z("employee:import")],
    [Z("time-entry:import")],
  ),
  // GET /reports/datev
  navRoute("/admin/export", "DATEN", "DATEV Export", "download", [Z("report:export")]),
  // tabs: settings, terminals, API keys
  navRoute(
    "/admin/system",
    "SYSTEM",
    "Allgemein",
    "settings",
    [Z("tenant-settings:read")],
    [Z("tenant-settings:update")],
    [Z("terminal:manage")],
    [Z("api-key:manage")],
  ),
  // no API guard (writes /me/preferences); grouped with the tenant settings
  navRoute(
    "/admin/themes",
    "SYSTEM",
    "Branding & Themes",
    "palette",
    [Z("tenant-settings:read")],
    [Z("tenant-settings:update")],
  ),
  // /presence-sources
  navRoute("/admin/integrations", "SYSTEM", "Integrationen", "wifi", [Z("presence-source:manage")]),
  // /integrations/phorest
  navRoute("/admin/phorest", "SYSTEM", "Phorest", "calendar", [Z("integration:manage")]),
  // GET /roles, GET /role-assignments
  navRoute(
    "/admin/roles",
    "SYSTEM",
    "Rollen & Rechte",
    "key",
    [Z("role:read")],
    [Z("role-assignment:manage")],
  ),
  // aliases that redirect to a route above
  aliasRoute("/admin/special-leave", [Z("tenant-settings:update")], [Z("leave-config:manage")]),
  aliasRoute("/admin/wifi-presence", [Z("presence-source:manage")]),
];

const HREFS = ADMIN_ROUTE_PERMISSIONS.map((entry) => entry.href);

/** True iff some non-empty alternative is held completely. */
export function holdsAlternatives(
  user: PermissionHolder | null | undefined,
  requires: PermissionAlternatives,
): boolean {
  return requires.some(
    (alternative) => alternative.length > 0 && alternative.every((key) => hasPermission(user, key)),
  );
}

/** The map entry a pathname belongs to (longest matching href), or null. */
export function adminRouteFor(pathname: string): AdminRoutePermission | null {
  const href = activeNavHref(HREFS, pathname);
  return ADMIN_ROUTE_PERMISSIONS.find((entry) => entry.href === href) ?? null;
}

export function isAdminHref(href: string): boolean {
  return matchesRoute("/admin", href);
}

/** The first navigable admin route the user may open, or null. */
export function firstAccessibleAdminHref(user: PermissionHolder | null | undefined): string | null {
  return (
    ADMIN_ROUTE_PERMISSIONS.find((entry) => entry.inNav && holdsAlternatives(user, entry.requires))
      ?.href ?? null
  );
}

export function canAccessAdminPath(
  user: PermissionHolder | null | undefined,
  pathname: string,
): boolean {
  if (pathname === "/admin" || pathname === "/admin/") {
    return firstAccessibleAdminHref(user) !== null;
  }
  const entry = adminRouteFor(pathname);
  return entry !== null && holdsAlternatives(user, entry.requires);
}

export type AdminGuardDecision = "wait" | "allow" | "deny";

/**
 * D-16: a session cached before the permission list existed (#378) waits for the refresh instead
 * of being denied; no user is denied.
 */
export function adminGuardDecision(
  user: PermissionHolder | null | undefined,
  pathname: string,
): AdminGuardDecision {
  if (!user) return "deny";
  if (user.permissions === undefined) return "wait";
  return canAccessAdminPath(user, pathname) ? "allow" : "deny";
}

// ── Admin navigation (Phase 83, #83) ──────────────────────────────────────────

export interface AdminNavItem {
  href: string;
  label: string;
  icon: string;
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

/**
 * The five admin groups of docs/ADMIN_STRUCTURE.md §1, derived from the route map above (one list,
 * so a route and its nav item cannot drift apart). Sidebar and the mobile Mehr sheet show the same
 * items; each is filtered by the route map.
 */
export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = ADMIN_ROUTE_PERMISSIONS.reduce<
  AdminNavGroup[]
>((groups, entry) => {
  if (!entry.inNav || !entry.nav) return groups;
  const item = { href: entry.href, label: entry.nav.label, icon: entry.nav.icon };
  const last = groups[groups.length - 1];
  if (last && last.label === entry.nav.group) last.items.push(item);
  else groups.push({ label: entry.nav.group, items: [item] });
  return groups;
}, []);

/** The admin groups the user may open; a group whose items are all hidden is dropped. */
export function visibleAdminNavGroups(
  user: PermissionHolder | null | undefined,
  options: { availabilityEnabled: boolean },
): AdminNavGroup[] {
  return ADMIN_NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter(
      (item) =>
        (options.availabilityEnabled || item.href !== "/admin/availability") &&
        canAccessAdminPath(user, item.href),
    ),
  })).filter((group) => group.items.length > 0);
}

export function visibleAdminNavItems(
  user: PermissionHolder | null | undefined,
  options: { availabilityEnabled: boolean },
): AdminNavItem[] {
  return visibleAdminNavGroups(user, options).flatMap((group) => group.items);
}
