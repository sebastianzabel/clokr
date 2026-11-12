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
  /** Tenant feature that must be on (Verfügbarkeits-System, Phase 47.3). */
  feature?: "availability";
  /** An internal tool page (#843): reachable by URL behind its guard, never in a navigation, a hub, the
   *  command palette or as a start page. */
  internal?: true;
}

const Z = (resourceAction: string) => `${resourceAction}:ZUGEWIESEN`;

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
  },
  {
    href: "/team/dienstplan/planung",
    area: "team",
    label: "Planungsbedarf",
    icon: "grid",
    width: "full",
    requires: [[Z("shift:plan")]],
    file: "/shifts/planning",
    inNav: false,
    parent: "/team/dienstplan",
  },
  {
    href: "/team/dienstplan/konflikte",
    area: "team",
    label: "Hinweise zur Schichtplanung",
    icon: "grid",
    width: "full",
    requires: [[Z("shift:plan")]],
    file: "/shifts/conflicts",
    inNav: false,
    parent: "/team/dienstplan",
  },
  // D-05: the team availability belongs to the roster; own rail entry until #851 joins both into one page.
  // GET /employees plus GET/PUT /employees/:id/availability
  {
    href: "/team/verfuegbarkeit",
    area: "team",
    label: "Verfügbarkeit",
    icon: "calendar-check",
    width: "full",
    requires: [
      [Z("employee:read"), Z("availability:read")],
      [Z("employee:read"), Z("availability:update")],
    ],
    file: "/admin/availability",
    inNav: true,
    feature: "availability",
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
    description: "Arbeitszeit, Abwesenheiten, Dienstplan, Monatsabschluss und Benachrichtigungen",
  },
  // Issue #854: a page created by the Verwalten rebuild (no route file of its own before). Its sections come from
  // /admin/system and /admin/vacation; the registry (settings-pages.ts) pins `requires` to the union of theirs.
  {
    href: "/verwalten/regeln/arbeitszeit",
    area: "verwalten",
    label: "Arbeitszeit & Verträge",
    icon: "clock",
    width: "read",
    requires: [
      [Z("tenant-settings:read")],
      [Z("tenant-settings:update")],
      [Z("terminal:manage")],
      [Z("api-key:manage")],
      [Z("leave-config:manage")],
    ],
    inNav: false,
    parent: "/verwalten/regeln",
    description: "Standard-Arbeitszeit, Pausen, Überstunden, Gleitzeit und Berufsschule",
  },
  // no read guard; the page's writes decide (PUT /settings/work, /settings/leave-types)
  {
    href: "/verwalten/regeln/abwesenheiten",
    area: "verwalten",
    label: "Abwesenheiten",
    icon: "umbrella",
    width: "read",
    // The union of the alternatives of the vacation page, the company shutdowns and the leave limits (D-854-05).
    requires: [
      [Z("tenant-settings:update")],
      [Z("leave-config:manage")],
      [Z("company-shutdown:manage")],
      [Z("leave-limit:manage")],
      [Z("leave-request:approve")],
    ],
    file: "/admin/vacation",
    inNav: false,
    parent: "/verwalten/regeln",
    description: "Urlaub, Sonderurlaub, Betriebsurlaub, Urlaubsgrenzen und Übertrag",
  },
  // writes /company-shutdowns. The list is the „Betriebsurlaub“ tab of Abwesenheiten (the route file is a redirect
  // stub, #854); the entry stays as the carrier of the detail sub-route /verwalten/regeln/betriebsurlaub/<id>.
  {
    href: "/verwalten/regeln/betriebsurlaub",
    area: "verwalten",
    label: "Betriebsurlaub",
    icon: "calendar",
    width: "read",
    requires: [[Z("company-shutdown:manage")]],
    file: "/admin/shutdowns",
    inNav: false,
    parent: "/verwalten/regeln/abwesenheiten",
    description: "Ein Betriebsurlaub im Detail",
  },
  // Promise.all of templates/coverage, week, patterns
  {
    href: "/verwalten/regeln/dienstplan",
    area: "verwalten",
    label: "Dienstplan",
    icon: "grid",
    width: "read",
    // Issue #854: the union of the gates of its sections (settings-pages.ts, D-854-05) - the shift
    // configuration plus the System and Urlaub settings that joined it; the tabs narrow it per person.
    requires: [
      [Z("shift-config:manage"), Z("shift:read"), Z("shift-pattern:read")],
      [Z("tenant-settings:read")],
      [Z("tenant-settings:update")],
      [Z("terminal:manage")],
      [Z("api-key:manage")],
      [Z("leave-config:manage")],
    ],
    file: "/admin/shifts",
    inNav: false,
    parent: "/verwalten/regeln",
    description:
      "Schichtvorlagen, Bedarfsregeln, Wochenmuster, Öffnungszeiten-Bindung und Erinnerungen",
  },
  // Issue #854: a page created by the Verwalten rebuild. Its sections come from /admin/system; the registry
  // (settings-pages.ts) pins `requires` to the union of theirs. The close WORKFLOW is /verwalten/monatsabschluss.
  {
    href: "/verwalten/regeln/monatsabschluss",
    area: "verwalten",
    label: "Monatsabschluss",
    icon: "lock",
    width: "read",
    requires: [
      [Z("tenant-settings:read")],
      [Z("tenant-settings:update")],
      [Z("terminal:manage")],
      [Z("api-key:manage")],
    ],
    inNav: false,
    parent: "/verwalten/regeln",
    description: "Wann ein Monat abgeschlossen werden darf",
  },
  // Issue #854: a page created by the Verwalten rebuild. Its sections come from /admin/system and /admin/vacation;
  // the registry (settings-pages.ts) pins `requires` to the union of theirs.
  {
    href: "/verwalten/regeln/benachrichtigungen",
    area: "verwalten",
    label: "Benachrichtigungen & E-Mail",
    icon: "inbox",
    width: "read",
    requires: [
      [Z("tenant-settings:read")],
      [Z("tenant-settings:update")],
      [Z("terminal:manage")],
      [Z("api-key:manage")],
      [Z("leave-config:manage")],
    ],
    inNav: false,
    parent: "/verwalten/regeln",
    description: "E-Mail-Server, Benachrichtigungen und Erinnerungen",
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
 * An old URL that has no route-table entry of its own: its permission alternatives (the old guard) and, since
 * #854, optionally the page that now holds its content.
 */
export interface LegacyRedirect {
  href: string;
  requires: PermissionAlternatives;
  /**
   * An old page whose content now lives on another page (#854): the old URL and every sub-path redirect to
   * `to` (a constant of this table, never derived from the request). May end in `#<tab>`. Such an alias has no
   * page file; `rerouteTarget` renders the page of `to` so the `(app)` layout load can send the redirect.
   */
  to?: string;
}

/**
 * Redirect-only aliases with the permission alternatives their old guard used (the admin layout guards them
 * before their own redirect runs). An alias without `to` still has a page file of its own that redirects once
 * more; an alias with `to` is redirected on the server and has no file.
 */
export const LEGACY_ROUTE_REDIRECTS: readonly LegacyRedirect[] = [
  // The Sonderurlaub rules are a tab of the Abwesenheiten page.
  {
    href: "/admin/special-leave",
    requires: [[Z("tenant-settings:update")], [Z("leave-config:manage")]],
    to: "/verwalten/regeln/abwesenheiten#sonderurlaub",
  },
  // The #844 URL of the vacation page (renamed by #854, plan 854-11); it may be bookmarked.
  {
    href: "/verwalten/regeln/urlaub",
    requires: [[Z("tenant-settings:update")], [Z("leave-config:manage")]],
    to: "/verwalten/regeln/abwesenheiten",
  },
  // The leave limits and blackouts (#836) are a tab of the Abwesenheiten page (plan 854-13). Both URLs keep the
  // old guard: a holder of leave-request:approve reaches the page and sees this tab alone.
  {
    href: "/admin/leave-limits",
    requires: [[Z("leave-limit:manage")], [Z("leave-request:approve")]],
    to: "/verwalten/regeln/abwesenheiten#urlaubsgrenzen",
  },
  {
    href: "/verwalten/regeln/urlaubsgrenzen",
    requires: [[Z("leave-limit:manage")], [Z("leave-request:approve")]],
    to: "/verwalten/regeln/abwesenheiten#urlaubsgrenzen",
  },
  // → /admin/integrations (301 from its +page.server.ts)
  { href: "/admin/wifi-presence", requires: [[Z("presence-source:manage")]] },
];

/** The folded-page alias `pathname` belongs to, or null. */
function foldedAlias(pathname: string): (LegacyRedirect & { to: string }) | null {
  const alias = LEGACY_ROUTE_REDIRECTS.find(
    (entry) => entry.to !== undefined && matchesRoute(entry.href, pathname),
  );
  return alias === undefined ? null : (alias as LegacyRedirect & { to: string });
}

/**
 * The redirect location of `target` with the request's query string kept: the query goes BEFORE the fragment
 * (`/a#t` + `?x=1` → `/a?x=1#t`), appending it to the whole target would put it behind the fragment.
 */
export function redirectLocation(target: string, search: string): string {
  const hashAt = target.indexOf("#");
  if (hashAt === -1) return target + search;
  return target.slice(0, hashAt) + search + target.slice(hashAt);
}

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
  // A folded old page has no file: render the page that holds its content, the layout load then redirects.
  const folded = foldedAlias(pathname);
  if (folded !== null) {
    const toPath = folded.to.split("#")[0];
    return rerouteTarget(toPath) ?? toPath;
  }
  const route = routeFor(pathname);
  if (route === null || route.file === undefined) return null;
  return route.file + rest(pathname, route.href);
}

/** The new URL an old URL redirects to (`/inbox` → `/team/aufgaben`, `/admin/employees/1` →
 *  `/verwalten/personen/1`), or null when `pathname` is not an old URL. Used by `routes/(app)/+layout.ts`. */
export function legacyRedirectTarget(pathname: string): string | null {
  if (pathname === "/admin" || pathname === "/admin/") return "/verwalten";
  const folded = foldedAlias(pathname);
  if (folded !== null) return folded.to;
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

/** Shown to `user` in a navigation: may open it, and its tenant feature (if any) is on. */
export function visibleRoute(
  user: PermissionHolder | null | undefined,
  route: AppRoute,
  options: RouteOptions,
): boolean {
  if (route.feature === "availability" && !options.availabilityEnabled) return false;
  return mayOpenRoute(user, route);
}

/** May `user` open the page at `pathname`? Fail-closed for an unknown path. Aliases use their old guard. */
export function mayOpenPath(user: PermissionHolder | null | undefined, pathname: string): boolean {
  const alias = LEGACY_ROUTE_REDIRECTS.find((entry) => matchesRoute(entry.href, pathname));
  if (alias !== undefined) return holdsAlternatives(user, alias.requires);
  const route = routeFor(pathname);
  if (route === null) return false;
  // A sub-path exists only below a page file (detail pages such as `/verwalten/personen/123`); below a page
  // created by #844 (a hub, Heute im Salon) an unknown sub-path stays closed.
  const exact = pathname === route.href || pathname === `${route.href}/`;
  if (!exact && route.file === undefined) return false;
  return mayOpenRoute(user, route);
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
