/**
 * Issue #844 — the ONE route table of the web app (Navigation v2, owner decisions Z-01…Z-03, D-04…D-06).
 *
 * Every navigable page is one entry: its URL, its area (Ich · Team · Verwalten), its name (menu entry = H1 =
 * crumb = quick search), its icon, its page width, the permissions that open it, and — for a page that already
 * existed before #844 — the route FILE that renders it. Sidebar, the „Mehr“ sheet, the tab bar, the crumb, the
 * quick search, the guards and the start page read this table and nothing else.
 *
 * New URLs, unmoved files (D-844-03): `src/hooks.ts` reroutes a new URL to the entry's `file`
 * (`/verwalten/personen/123` renders `routes/(app)/admin/employees/[id]`). The old URL (= the file path)
 * redirects to the new one (`legacyRedirectTarget`, used by `routes/(app)/+layout.ts`), so bookmarks, e-mail and
 * push links of earlier releases keep working. A page that exists only since #844 has no `file`.
 *
 * Permissions (D-06): `requires` lists alternatives, each a set of keys that must ALL be held — copied unchanged
 * from the pre-#844 `admin-route-permissions.ts` / `team-nav.ts` entries (`routes-844.test.ts` pins that), each
 * line naming the API guard its page calls. `null` = every signed-in user. Fail-closed: an unknown path grants
 * nothing. A UX gate only; the API's 403 stays the authority.
 */
import { hasPermission, type PermissionHolder } from "$lib/permissions";
import { activeNavHref, matchesRoute } from "$lib/nav/active-route";

export type Area = "ich" | "team" | "verwalten";
export type PermissionAlternatives = readonly (readonly string[])[];

/** The two page widths of the shell (owner 09.11.2026): `read` = at most 1120 px centred (forms, settings,
 *  details), `full` = up to 2400 px with a 32 px margin (planners, calendars, tables, reports, start pages). */
export type PageWidth = "read" | "full";

export interface AppRoute {
  href: string;
  area: Area;
  label: string;
  icon: string;
  width: PageWidth;
  /** Permission alternatives; `null` = every signed-in user; `"children"` = visible iff a child is (hubs). */
  requires: PermissionAlternatives | null | "children";
  /** The route file this URL renders (the pre-#844 URL); absent for a page created by #844. */
  file?: string;
  /** Shown in the rail / „Mehr“ sheet. False for sub-pages, aliases and the avatar-menu Profil. */
  inNav: boolean;
  /** The hub this entry belongs to (listed on the hub page, not in the rail). */
  parent?: string;
  /** One line for the hub page. */
  description?: string;
  /** Issue #853 (D-853-04 revised) — the name of this page as a TAB of its parent area page („Woche“, „Bedarf“).
   *  Read only by a tab strip (`rosterTabs`); the H1, `<title>` and crumb keep `label`. */
  tabLabel?: string;
  /** Tenant feature that must be on (Verfügbarkeits-System, Phase 47.3). */
  feature?: "availability";
  /** An internal tool page (#843): reachable by URL behind its guard, never in a navigation, a hub, the
   *  command palette or as a start page. */
  internal?: true;
  /**
   * Issue #853 (D-853-15 revised) — NAVIGATION visibility only: the entry is shown in a navigation only
   * when one of these alternatives is held (in addition to `requires`). `mayOpenRoute` / `mayOpenPath` /
   * `homeHref` never read it, so a guard and a direct URL behave exactly as `requires` says.
   */
  navRequires?: PermissionAlternatives;
  /** Issue #853 (D-853-15 revised) — NAVIGATION visibility only: the entry is hidden from a navigation
   *  when one of these alternatives is held. Guards and direct URLs are unaffected (see `navRequires`). */
  navHiddenWhen?: PermissionAlternatives;
}

const Z = (resourceAction: string) => `${resourceAction}:ZUGEWIESEN`;

/** Who works with persons (creates or edits them) and therefore sees Verwalten › Personen in the navigation
 *  instead of Team › Personen (#853, D-853-15 revised). One constant so the two entries cannot drift. */
const PERSON_MANAGE_ALTERNATIVES: PermissionAlternatives = [
  [Z("employee:create")],
  [Z("employee:update")],
];

export const AREA_LABELS: Readonly<Record<Area, string>> = Object.freeze({
  ich: "Ich",
  team: "Team",
  verwalten: "Verwalten",
});

export const APP_ROUTES: readonly AppRoute[] = [
  // ── Ich ────────────────────────────────────────────────────────────────────────────────────────────
  {
    href: "/ich/tag",
    area: "ich",
    label: "Mein Tag",
    icon: "sun",
    width: "full",
    requires: null,
    file: "/dashboard",
    inNav: true,
  },
  {
    href: "/ich/zeiten",
    area: "ich",
    label: "Zeiten",
    icon: "clock",
    width: "full",
    requires: null,
    file: "/time-entries",
    inNav: true,
  },
  {
    href: "/ich/abwesenheiten",
    area: "ich",
    label: "Abwesenheiten",
    icon: "umbrella",
    width: "full",
    requires: null,
    file: "/leave",
    inNav: true,
  },
  // D-05: the own availability is the first part of „Dienstplan“ (the own shifts follow with #597)
  {
    href: "/ich/dienstplan",
    area: "ich",
    label: "Dienstplan",
    icon: "calendar-check",
    width: "full",
    requires: null,
    file: "/availability",
    inNav: true,
    feature: "availability",
  },
  // In the avatar menu (and the phone „Mehr“ sheet), not in the rail
  {
    href: "/ich/profil",
    area: "ich",
    label: "Profil",
    icon: "settings",
    width: "read",
    requires: null,
    file: "/settings",
    inNav: false,
  },
  {
    href: "/ich/profil/geraet-koppeln",
    area: "ich",
    label: "Handy koppeln",
    icon: "wifi",
    width: "read",
    requires: null,
    file: "/settings/geraet-koppeln",
    inNav: false,
  },

  // ── Team ───────────────────────────────────────────────────────────────────────────────────────────
  // GET /dashboard/team-week, /today-attendance, /team-trend (team-overview:read)
  {
    href: "/team/heute",
    area: "team",
    label: "Heute im Salon",
    icon: "store",
    width: "full",
    requires: [[Z("team-overview:read")]],
    inNav: true,
  },
  // The Postfach decides leave requests, Zeitnachträge and (#840 D-840-29) § 9 cases — any one is enough
  {
    href: "/team/aufgaben",
    area: "team",
    label: "Aufgaben",
    icon: "inbox",
    width: "full",
    requires: [[Z("leave-request:approve")], [Z("retro-request:approve")], [Z("section9:decide")]],
    file: "/inbox",
    inNav: true,
  },
  {
    href: "/team/zeiten",
    area: "team",
    label: "Zeiten",
    icon: "clock",
    width: "full",
    requires: [[Z("time-entry:read")]],
    file: "/team/time-entries",
    inNav: true,
  },
  {
    href: "/team/abwesenheiten",
    area: "team",
    label: "Abwesenheiten",
    icon: "umbrella",
    width: "full",
    requires: [[Z("leave-request:read")]],
    file: "/team/leave",
    inNav: true,
  },
  // The roster page is write-oriented with no read-only mode — gated on PLAN, not READ (Phase 378, D-05)
  {
    href: "/team/dienstplan",
    area: "team",
    label: "Dienstplan",
    icon: "grid",
    width: "full",
    requires: [[Z("shift:plan")]],
    file: "/shifts",
    inNav: true,
    tabLabel: "Woche",
  },
  {
    href: "/team/dienstplan/planung",
    area: "team",
    // #853 (D-853-04 revised): the four roster pages are tabs of ONE „Dienstplan“ (H1, title and crumb).
    label: "Dienstplan",
    icon: "grid",
    width: "full",
    requires: [[Z("shift:plan")]],
    file: "/shifts/planning",
    inNav: false,
    parent: "/team/dienstplan",
    tabLabel: "Bedarf",
  },
  {
    href: "/team/dienstplan/konflikte",
    area: "team",
    label: "Dienstplan",
    icon: "grid",
    width: "full",
    requires: [[Z("shift:plan")]],
    file: "/shifts/conflicts",
    inNav: false,
    parent: "/team/dienstplan",
    tabLabel: "Hinweise",
  },
  // D-05: the team availability belongs to the roster. #853 (D-853-04 revised): it is the fourth tab of
  // „Dienstplan“, no rail entry of its own; the rail marks „Dienstplan“ on it (`navCurrentPath`).
  // GET /employees plus GET/PUT /employees/:id/availability
  {
    href: "/team/verfuegbarkeit",
    area: "team",
    label: "Dienstplan",
    icon: "calendar-check",
    width: "full",
    requires: [
      [Z("employee:read"), Z("availability:read")],
      [Z("employee:read"), Z("availability:update")],
    ],
    file: "/admin/availability",
    inNav: false,
    parent: "/team/dienstplan",
    feature: "availability",
    tabLabel: "Verfügbarkeit",
  },
  // #853 (D-853-14, D-853-15 revised): the read-only team directory for leaders. A page created by #853 (no
  // `file`). GET /employees (reach narrowing #547). Hidden from the navigation of whoever sees Verwalten ›
  // Personen instead; the URL stays openable for everyone with employee:read.
  {
    href: "/team/personen",
    area: "team",
    label: "Personen",
    icon: "users",
    width: "full",
    requires: [[Z("employee:read")]],
    inNav: true,
    navHiddenWhen: PERSON_MANAGE_ALTERNATIVES,
  },

  // ── Verwalten ──────────────────────────────────────────────────────────────────────────────────────
  {
    href: "/verwalten",
    area: "verwalten",
    label: "Übersicht",
    icon: "dashboard",
    width: "full",
    requires: "children",
    inNav: true,
  },
  // GET /employees
  {
    href: "/verwalten/personen",
    area: "verwalten",
    label: "Personen",
    icon: "users",
    width: "full",
    requires: [[Z("employee:read")]],
    file: "/admin/employees",
    inNav: true,
    parent: "/verwalten",
    description: "Personen, Verträge, Rollen und Zugänge",
    // #853 (D-853-15): exactly one „Personen“ per person. Whoever creates or edits persons sees this entry;
    // everyone else with employee:read gets the read-only Team › Personen (navHiddenWhen of that entry).
    navRequires: PERSON_MANAGE_ALTERNATIVES,
  },
  // GET /salons (writes: salon:manage, decided by the API)
  {
    href: "/verwalten/salons",
    area: "verwalten",
    label: "Salons",
    icon: "store",
    width: "read",
    requires: [[Z("salon:read")]],
    file: "/admin/salons",
    inNav: true,
    parent: "/verwalten",
    description: "Standorte, Öffnungszeiten und Feiertage",
  },
  {
    href: "/verwalten/regeln",
    area: "verwalten",
    label: "Regeln",
    icon: "check",
    width: "read",
    requires: "children",
    inNav: true,
    parent: "/verwalten",
    description: "Urlaub, Betriebsurlaub, Urlaubsgrenzen und Schichten",
  },
  // no read guard; the page's writes decide (PUT /settings/work, /settings/leave-types)
  {
    href: "/verwalten/regeln/urlaub",
    area: "verwalten",
    label: "Urlaubsverwaltung",
    icon: "umbrella",
    width: "read",
    requires: [[Z("tenant-settings:update")], [Z("leave-config:manage")]],
    file: "/admin/vacation",
    inNav: false,
    parent: "/verwalten/regeln",
    description: "Arbeitszeit-Vorgaben, Urlaubsanspruch, Anträge, Erinnerungen und Sonderurlaub",
  },
  // writes /company-shutdowns
  {
    href: "/verwalten/regeln/betriebsurlaub",
    area: "verwalten",
    label: "Betriebsurlaub",
    icon: "calendar",
    width: "read",
    requires: [[Z("company-shutdown:manage")]],
    file: "/admin/shutdowns",
    inNav: false,
    parent: "/verwalten/regeln",
    description: "Zeiträume, in denen der ganze Betrieb geschlossen hat",
  },
  // GET /leave/limits (handler checks: leave-limit:manage or leave-request:approve)
  {
    href: "/verwalten/regeln/urlaubsgrenzen",
    area: "verwalten",
    label: "Urlaubsgrenzen & Sperren",
    icon: "umbrella",
    width: "read",
    requires: [[Z("leave-limit:manage")], [Z("leave-request:approve")]],
    file: "/admin/leave-limits",
    inNav: false,
    parent: "/verwalten/regeln",
    description: "Wie viele Personen gleichzeitig Urlaub haben dürfen",
  },
  // Promise.all of templates/coverage, week, patterns
  {
    href: "/verwalten/regeln/dienstplan",
    area: "verwalten",
    label: "Schichteinstellungen",
    icon: "grid",
    width: "read",
    requires: [[Z("shift-config:manage"), Z("shift:read"), Z("shift-pattern:read")]],
    file: "/admin/shifts",
    inNav: false,
    parent: "/verwalten/regeln",
    description: "Schichtvorlagen, Bedarfsregeln und Wochenmuster",
  },
  // GET /overtime/close-month/status
  {
    href: "/verwalten/monatsabschluss",
    area: "verwalten",
    label: "Monatsabschluss",
    icon: "lock",
    width: "full",
    requires: [[Z("month-close:read")]],
    file: "/admin/month-close",
    inNav: true,
    parent: "/verwalten",
    description: "Monate prüfen und abschließen",
  },
  // Z-03: the reports live under Verwalten
  {
    href: "/verwalten/berichte",
    area: "verwalten",
    label: "Berichte",
    icon: "chart",
    width: "full",
    requires: [[Z("report:read")]],
    file: "/reports",
    inNav: true,
    parent: "/verwalten",
    description: "Auswertungen nach Zeitraum, Person und Salon",
  },
  {
    href: "/verwalten/daten",
    area: "verwalten",
    label: "Daten",
    icon: "download",
    width: "read",
    requires: "children",
    inNav: true,
    parent: "/verwalten",
    description: "Import, DATEV-Export, Protokoll und Support-Zugriffe",
  },
  // POST /imports/employees, POST /imports/time-entries
  {
    href: "/verwalten/daten/import",
    area: "verwalten",
    label: "CSV-Import",
    icon: "upload",
    width: "read",
    requires: [[Z("employee:import")], [Z("time-entry:import")]],
    file: "/admin/import",
    inNav: false,
    parent: "/verwalten/daten",
    description: "Personen und Zeiten aus einer CSV-Datei übernehmen",
  },
  // GET /reports/datev
  {
    href: "/verwalten/daten/datev",
    area: "verwalten",
    label: "DATEV-Export",
    icon: "download",
    width: "read",
    requires: [[Z("report:export")]],
    file: "/admin/export",
    inNav: false,
    parent: "/verwalten/daten",
    description: "Lohndaten für die Lohnbuchhaltung",
  },
  // GET /audit-logs
  {
    href: "/verwalten/daten/protokoll",
    area: "verwalten",
    label: "Protokoll",
    icon: "shield",
    width: "full",
    requires: [[Z("audit-log:read")]],
    file: "/admin/audit",
    inNav: false,
    parent: "/verwalten/daten",
    description: "Wer hat was wann geändert, Aufbewahrung",
  },
  // GET /support-accesses (the end action's extra permission is checked in the page; the API decides)
  {
    href: "/verwalten/daten/support-zugriffe",
    area: "verwalten",
    label: "Support-Zugriffe",
    icon: "shield",
    width: "read",
    requires: [[Z("audit-log:read")]],
    file: "/admin/support-access",
    inNav: false,
    parent: "/verwalten/daten",
    description: "Freigaben für den Clokr-Support",
  },
  {
    href: "/verwalten/system",
    area: "verwalten",
    label: "System",
    icon: "settings",
    width: "read",
    requires: "children",
    inNav: true,
    parent: "/verwalten",
    description: "Allgemeines, Darstellung, Schnittstellen und Rollen",
  },
  // tabs: settings, terminals, API keys
  {
    href: "/verwalten/system/allgemein",
    area: "verwalten",
    label: "Allgemein",
    icon: "settings",
    width: "read",
    requires: [
      [Z("tenant-settings:read")],
      [Z("tenant-settings:update")],
      [Z("terminal:manage")],
      [Z("api-key:manage")],
    ],
    file: "/admin/system",
    inNav: false,
    parent: "/verwalten/system",
    description: "Unternehmen, Arbeitszeit, Sicherheit, Kommunikation und Geräte",
  },
  // no API guard (writes /me/preferences); grouped with the tenant settings
  {
    href: "/verwalten/system/branding",
    area: "verwalten",
    label: "Branding & Themes",
    icon: "palette",
    width: "read",
    requires: [[Z("tenant-settings:read")], [Z("tenant-settings:update")]],
    file: "/admin/themes",
    inNav: false,
    parent: "/verwalten/system",
    description: "Farbwelt und Modus",
  },
  // /presence-sources
  {
    href: "/verwalten/system/integrationen",
    area: "verwalten",
    label: "Integrationen",
    icon: "wifi",
    width: "read",
    requires: [[Z("presence-source:manage")]],
    file: "/admin/integrations",
    inNav: false,
    parent: "/verwalten/system",
    description: "WLAN-Anwesenheit und Handy-Kopplung",
  },
  // /integrations/phorest/*
  {
    href: "/verwalten/system/phorest",
    area: "verwalten",
    label: "Phorest",
    icon: "calendar",
    width: "read",
    requires: [[Z("integration:manage")]],
    file: "/admin/phorest",
    inNav: false,
    parent: "/verwalten/system",
    description: "Schichten und Termine aus Phorest",
  },
  // GET /roles, /role-assignments
  {
    href: "/verwalten/system/rollen",
    area: "verwalten",
    label: "Rollen & Rechte",
    icon: "key",
    width: "read",
    requires: [[Z("role:read")], [Z("role-assignment:manage")]],
    file: "/admin/roles",
    inNav: false,
    parent: "/verwalten/system",
    description: "Wer was sehen und ändern darf",
  },
  // #843 D-843-04: the design-system example page - internal, never in a navigation. It reads no API data, so
  // this is a UX gate only (the same read key the themes page accepts).
  {
    href: "/verwalten/bausteine",
    area: "verwalten",
    label: "Bausteine",
    icon: "grid",
    width: "full",
    requires: [[Z("tenant-settings:read")]],
    file: "/admin/bausteine",
    inNav: false,
    internal: true,
  },
];

/**
 * Redirect-only aliases that still have a page file of their own, with the permission alternatives their old
 * guard used (the admin layout guards them before their own redirect runs; it lands on an old URL, which then
 * redirects once more).
 */
export const LEGACY_ALIASES: readonly { href: string; requires: PermissionAlternatives }[] = [
  // → /admin/vacation#sonderurlaub (its own onMount redirect)
  {
    href: "/admin/special-leave",
    requires: [[Z("tenant-settings:update")], [Z("leave-config:manage")]],
  },
  // → /admin/integrations (301 from its +page.server.ts)
  { href: "/admin/wifi-presence", requires: [[Z("presence-source:manage")]] },
];

const ROUTE_HREFS = APP_ROUTES.map((route) => route.href);
const FILE_ROUTES = APP_ROUTES.filter(
  (route): route is AppRoute & { file: string } => route.file !== undefined,
);
const FILE_HREFS = FILE_ROUTES.map((route) => route.file);

/** The table entry `pathname` belongs to (longest matching href, segment-wise), or null. */
export function routeFor(pathname: string): AppRoute | null {
  const href = activeNavHref(ROUTE_HREFS, pathname);
  return href === null ? null : (APP_ROUTES.find((route) => route.href === href) ?? null);
}

/** The entry whose new href OR route file is `key` (pages still name their file path, e.g. `pageLabel("/inbox")`). */
export function routeByKey(key: string): AppRoute | null {
  return APP_ROUTES.find((route) => route.href === key || route.file === key) ?? null;
}

function rest(pathname: string, base: string): string {
  return pathname.slice(base.length);
}

/** The route file a new URL renders (`/verwalten/personen/1` → `/admin/employees/1`), or null when the path is
 *  not a rerouted URL (a page created by #844, an old URL, an unknown path). Used by `src/hooks.ts` `reroute`. */
export function rerouteTarget(pathname: string): string | null {
  const route = routeFor(pathname);
  if (route === null || route.file === undefined) return null;
  return route.file + rest(pathname, route.href);
}

/** The new URL an old URL redirects to (`/inbox` → `/team/aufgaben`, `/admin/employees/1` →
 *  `/verwalten/personen/1`), or null when `pathname` is not an old URL. Used by `routes/(app)/+layout.ts`. */
export function legacyRedirectTarget(pathname: string): string | null {
  if (pathname === "/admin" || pathname === "/admin/") return "/verwalten";
  // No new href lies under a file path (`routes-844.test.ts`), so a new URL never matches here.
  const file = activeNavHref(FILE_HREFS, pathname);
  if (file === null) return null;
  const route = FILE_ROUTES.find((entry) => entry.file === file);
  return route === undefined ? null : route.href + rest(pathname, file);
}

export interface RouteOptions {
  /** Tenant feature flag of the Verfügbarkeits-System (Phase 47.3); off hides its entries. */
  availabilityEnabled: boolean;
}

/** True iff some non-empty alternative is held completely. */
export function holdsAlternatives(
  user: PermissionHolder | null | undefined,
  requires: PermissionAlternatives,
): boolean {
  return requires.some(
    (alternative) => alternative.length > 0 && alternative.every((key) => hasPermission(user, key)),
  );
}

/** The roster page; the other roster pages name it as `parent` (tabs of one „Dienstplan“, #853). */
const ROSTER_HREF = "/team/dienstplan";

function childrenOf(href: string): AppRoute[] {
  return APP_ROUTES.filter((route) => route.parent === href);
}

/** May `user` open `route`? Hubs open iff one of their children does. Features are not checked here (the
 *  guard does not know the tenant flags; the nav hides feature entries through `visibleRoute`). */
export function mayOpenRoute(user: PermissionHolder | null | undefined, route: AppRoute): boolean {
  if (route.requires === null) return true;
  if (route.requires === "children")
    return childrenOf(route.href).some((child) => mayOpenRoute(user, child));
  return holdsAlternatives(user, route.requires);
}

/** Shown to `user` in a navigation: may open it, its tenant feature (if any) is on, and the navigation-only
 *  fields `navRequires` / `navHiddenWhen` (#853) allow it. A hub is shown only when one of its children is
 *  (the guard still opens a hub through any openable child, see `mayOpenRoute`). */
export function visibleRoute(
  user: PermissionHolder | null | undefined,
  route: AppRoute,
  options: RouteOptions,
): boolean {
  if (route.feature === "availability" && !options.availabilityEnabled) return false;
  if (route.navRequires !== undefined && !holdsAlternatives(user, route.navRequires)) return false;
  if (route.navHiddenWhen !== undefined && holdsAlternatives(user, route.navHiddenWhen)) {
    return false;
  }
  if (route.requires === "children") {
    return childrenOf(route.href).some((child) => visibleRoute(user, child, options));
  }
  return mayOpenRoute(user, route);
}

/** May `user` open the page at `pathname`? Fail-closed for an unknown path. Aliases use their old guard. */
export function mayOpenPath(user: PermissionHolder | null | undefined, pathname: string): boolean {
  const alias = LEGACY_ALIASES.find((entry) => matchesRoute(entry.href, pathname));
  if (alias !== undefined) return holdsAlternatives(user, alias.requires);
  const route = routeFor(pathname);
  if (route === null) return false;
  // A sub-path exists only below a page file (detail pages such as `/verwalten/personen/123`); below a page
  // created by #844 (a hub, Heute im Salon) an unknown sub-path stays closed.
  const exact = pathname === route.href || pathname === `${route.href}/`;
  if (!exact && route.file === undefined) return false;
  return mayOpenRoute(user, route);
}

/**
 * The path a navigation compares with its items to find the current one (#853). A page that is no rail entry
 * but a tab or sub-page of one (`inNav: false` with an `inNav` parent: the roster tab Verfügbarkeit, a hub
 * child) is represented by its parent, so the rail and the „Mehr“ sheet mark „Dienstplan“ on every roster tab.
 * A page below its parent's path (`/team/dienstplan/planung`, a hub child) is already matched by prefix and
 * every other path is returned unchanged; the rule of "which item is current" stays in `active-route.ts`.
 */
export function navCurrentPath(pathname: string): string {
  const route = routeFor(pathname);
  if (route === null || route.inNav || route.parent === undefined) return pathname;
  const parent = APP_ROUTES.find((entry) => entry.href === route.parent);
  return parent !== undefined && parent.inNav && !matchesRoute(parent.href, pathname)
    ? parent.href
    : pathname;
}

export interface RosterTab {
  value: string;
  href: string;
  label: string;
}

/**
 * The tabs of „Dienstplan“ (#853, D-853-04/05 revised): the roster page and every entry whose `parent` is
 * the roster page, in table order, as LINK tabs (each tab is its own route). A tab the person may not open,
 * or whose tenant feature is off, is not returned. `value` is the href.
 */
export function rosterTabs(
  user: PermissionHolder | null | undefined,
  options: RouteOptions,
): RosterTab[] {
  return APP_ROUTES.filter((route) => route.href === ROSTER_HREF || route.parent === ROSTER_HREF)
    .filter((route) => visibleRoute(user, route, options))
    .map((route) => ({
      value: route.href,
      href: route.href,
      label: route.tabLabel ?? route.label,
    }));
}

/** The visible hub children of `hubHref` for the hub page, in table order. */
export function visibleChildren(
  user: PermissionHolder | null | undefined,
  hubHref: string,
  options: RouteOptions,
): AppRoute[] {
  return childrenOf(hubHref).filter((route) => visibleRoute(user, route, options));
}

/** The start page of `user` (Z-02), from permissions only — never a role comparison:
 *  1. Heute im Salon for whoever may open it (the team reach: Salonmanager, Manager, Inhaber, Admin);
 *  2. Verwalten › Übersicht for an administration role — a Verwalten entry, but no access to the team's time
 *     records (whoever reads them leads people in the salon; the Personalabteilung reads team absences, not
 *     times);
 *  3. Mein Tag for everyone else (Mitarbeitende, and e.g. the Ausbilder, who reads the apprentices' times). */
export function homeHref(user: PermissionHolder | null | undefined): string {
  const open = (href: string) => {
    const route = routeByKey(href);
    return route !== null && mayOpenRoute(user, route);
  };
  if (open("/team/heute")) return "/team/heute";
  if (open("/verwalten") && !open("/team/zeiten")) return "/verwalten";
  return "/ich/tag";
}

/** The area label of `pathname` for the crumb („Team“), "" outside the table. */
export function areaLabelForPath(pathname: string): string {
  const route = routeFor(pathname);
  return route === null ? "" : AREA_LABELS[route.area];
}

/** The page width of `pathname`: its entry's width; a detail page below an entry (`/verwalten/personen/123`,
 *  no entry of its own) and an unknown path get the reading width. */
export function pageWidthForPath(pathname: string): PageWidth {
  const route = routeFor(pathname);
  if (route === null) return "read";
  const exact = pathname === route.href || pathname === `${route.href}/`;
  return exact ? route.width : "read";
}

export interface MobileTab {
  href: string;
  /** The short form shown in the tab bar (docs/glossar.md § 4); the page's name stays the table label. */
  label: string;
  icon: string;
}

/** Tab-bar slots (D-844-13, prototype v5): with a Team entry Salon · Aufgaben · Mein Tag · Abwesend (team),
 *  without one Mein Tag · Zeiten · Abwesend · Plan; „Mehr“ follows. Short forms only here. */
const TEAM_TABS: readonly [string, string][] = [
  ["/team/heute", "Salon"],
  ["/team/aufgaben", "Aufgaben"],
  ["/ich/tag", "Mein Tag"],
  ["/team/abwesenheiten", "Abwesend"],
];
const PERSONAL_TABS: readonly [string, string][] = [
  ["/ich/tag", "Mein Tag"],
  ["/ich/zeiten", "Zeiten"],
  ["/ich/abwesenheiten", "Abwesend"],
  ["/ich/dienstplan", "Plan"],
];

/** The tab-bar targets of `user`: a slot the user may not open (or whose feature is off) is skipped, never a
 *  dead link. */
export function mobileTabs(
  user: PermissionHolder | null | undefined,
  options: RouteOptions,
): MobileTab[] {
  const hasTeam = APP_ROUTES.some(
    (route) => route.area === "team" && route.inNav && visibleRoute(user, route, options),
  );
  return (hasTeam ? TEAM_TABS : PERSONAL_TABS).flatMap(([href, label]) => {
    const route = routeByKey(href);
    return route !== null && visibleRoute(user, route, options)
      ? [{ href, label, icon: route.icon }]
      : [];
  });
}
