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
}

const Z = (resourceAction: string) => `${resourceAction}:ZUGEWIESEN`;

export const ADMIN_ROUTE_PERMISSIONS: readonly AdminRoutePermission[] = [
  // GET /employees — employee:read
  { href: "/admin/employees", requires: [[Z("employee:read")]], inNav: true },
  // No read guard exists; the page's writes decide (PUT /settings/work, /settings/leave-types).
  {
    href: "/admin/vacation",
    requires: [[Z("tenant-settings:update")], [Z("leave-config:manage")]],
    inNav: true,
  },
  // Writes /company-shutdowns — company-shutdown:manage
  { href: "/admin/shutdowns", requires: [[Z("company-shutdown:manage")]], inNav: true },
  // Promise.all of templates/coverage (shift-config), week (shift:read), patterns (shift-pattern:read)
  {
    href: "/admin/shifts",
    requires: [[Z("shift-config:manage"), Z("shift:read"), Z("shift-pattern:read")]],
    inNav: true,
  },
  // GET /employees (employee:read) plus GET/PUT /employees/:id/availability
  {
    href: "/admin/availability",
    requires: [
      [Z("employee:read"), Z("availability:read")],
      [Z("employee:read"), Z("availability:update")],
    ],
    inNav: true,
  },
  // GET /overtime/close-month/status — month-close:read
  { href: "/admin/month-close", requires: [[Z("month-close:read")]], inNav: true },
  // GET /audit-logs — audit-log:read
  { href: "/admin/audit", requires: [[Z("audit-log:read")]], inNav: true },
  // POST /imports/employees — employee:import; POST /imports/time-entries — time-entry:import
  {
    href: "/admin/import",
    requires: [[Z("employee:import")], [Z("time-entry:import")]],
    inNav: true,
  },
  // GET /reports/datev — report:export
  { href: "/admin/export", requires: [[Z("report:export")]], inNav: true },
  // Tabs: settings (tenant-settings), terminals (terminal:manage), API keys (api-key:manage)
  {
    href: "/admin/system",
    requires: [
      [Z("tenant-settings:read")],
      [Z("tenant-settings:update")],
      [Z("terminal:manage")],
      [Z("api-key:manage")],
    ],
    inNav: true,
  },
  // No API guard (writes /me/preferences); grouped with the tenant settings it belongs to.
  {
    href: "/admin/themes",
    requires: [[Z("tenant-settings:read")], [Z("tenant-settings:update")]],
    inNav: true,
  },
  // /presence-sources — presence-source:manage
  { href: "/admin/integrations", requires: [[Z("presence-source:manage")]], inNav: true },
  // /integrations/phorest — integration:manage
  { href: "/admin/phorest", requires: [[Z("integration:manage")]], inNav: true },
  // GET /roles — role:read; GET /role-assignments — role-assignment:manage
  {
    href: "/admin/roles",
    requires: [[Z("role:read")], [Z("role-assignment:manage")]],
    inNav: true,
  },
  // Aliases that redirect to a route above.
  {
    href: "/admin/special-leave",
    requires: [[Z("tenant-settings:update")], [Z("leave-config:manage")]],
    inNav: false,
  },
  { href: "/admin/wifi-presence", requires: [[Z("presence-source:manage")]], inNav: false },
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
 * The five admin groups of docs/ADMIN_STRUCTURE.md §1 — moved verbatim from the Sidebar, plus
 * „Rollen & Rechte“ as the fifth SYSTEM entry (#83). Sidebar and the mobile Mehr sheet show the
 * same items; each is filtered by the route map above.
 */
export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = [
  {
    label: "PERSONAL",
    items: [
      { href: "/admin/employees", label: "Mitarbeitende", icon: "users" },
      { href: "/admin/vacation", label: "Urlaubsverwaltung", icon: "umbrella" },
      { href: "/admin/shutdowns", label: "Betriebsurlaub", icon: "calendar" },
    ],
  },
  {
    label: "PLANUNG",
    items: [
      { href: "/admin/shifts", label: "Schichtplan", icon: "grid" },
      { href: "/admin/availability", label: "Verfügbarkeit", icon: "calendar-check" },
    ],
  },
  {
    label: "COMPLIANCE",
    items: [
      { href: "/admin/month-close", label: "Monatsabschluss", icon: "lock" },
      { href: "/admin/audit", label: "Audit & Log", icon: "shield" },
    ],
  },
  {
    label: "DATEN",
    items: [
      { href: "/admin/import", label: "CSV Import", icon: "upload" },
      { href: "/admin/export", label: "DATEV Export", icon: "download" },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { href: "/admin/system", label: "Allgemein", icon: "settings" },
      { href: "/admin/themes", label: "Branding & Themes", icon: "palette" },
      { href: "/admin/integrations", label: "Integrationen", icon: "wifi" },
      { href: "/admin/phorest", label: "Phorest", icon: "calendar" },
      { href: "/admin/roles", label: "Rollen & Rechte", icon: "key" },
    ],
  },
];

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
