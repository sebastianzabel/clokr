/**
 * Issue #574 (D-574-09..11) — the ONE place a page's name lives.
 *
 * The desktop Sidebar and the mobile "Mehr" sheet (through `app-nav.ts`), the Topbar crumb
 * (`labelForPath`), the quick search (CommandPalette) and the H1 of every nav page all read this
 * table, so a page can no longer carry four different names. The names follow `docs/glossar.md`.
 * `page-labels-one-source-574.test.ts` fails on a surface that spells a name itself.
 *
 * Deliberately absent: `/leave/planung` and `/teamcal` — both only redirect since #840
 * (D-840-06) and have no page of their own.
 */
import { activeNavHref } from "$lib/nav/active-route";

export const PAGE_LABELS = Object.freeze({
  "/dashboard": "Übersicht",
  "/time-entries": "Zeiterfassung",
  "/leave": "Abwesenheiten",
  "/availability": "Verfügbarkeit",
  "/inbox": "Aufgaben",
  "/team/time-entries": "Team-Zeiten",
  "/team/leave": "Abwesenheiten",
  "/shifts": "Schichtplanung",
  "/reports": "Berichte",
  "/admin/employees": "Mitarbeitende",
  "/admin/vacation": "Urlaubsverwaltung",
  // redirect-only alias (/admin/vacation#sonderurlaub) — carries its target's name
  "/admin/special-leave": "Urlaubsverwaltung",
  "/admin/shutdowns": "Betriebsurlaub",
  "/admin/leave-limits": "Urlaubsgrenzen & Sperren",
  "/admin/shifts": "Schichteinstellungen",
  "/admin/availability": "Verfügbarkeit",
  "/admin/salons": "Salons",
  "/admin/month-close": "Monatsabschluss",
  "/admin/audit": "Protokoll",
  "/admin/support-access": "Support-Zugriffe",
  "/admin/import": "CSV-Import",
  "/admin/export": "DATEV-Export",
  "/admin/system": "Allgemein",
  "/admin/themes": "Branding & Themes",
  "/admin/integrations": "Integrationen",
  // redirect-only alias (Phase 52 rename to /admin/integrations) — carries its target's name
  "/admin/wifi-presence": "Integrationen",
  "/admin/phorest": "Phorest",
  "/admin/roles": "Rollen & Rechte",
  "/admin": "Administration",
  "/settings": "Mein Profil",
  "/settings/geraet-koppeln": "Handy koppeln",
} as const);

export type PageHref = keyof typeof PAGE_LABELS;

const PAGE_HREFS = Object.keys(PAGE_LABELS);

/** The name of the page `href`. Throws for an href outside the table — a nav entry without a
 *  name must break the unit tests, never render an empty label (fail closed). */
export function pageLabel(href: PageHref): string {
  const label = (PAGE_LABELS as Record<string, string>)[href];
  if (label === undefined) {
    throw new Error(`page-labels: no page name for "${href}" — add it to the page-name table`);
  }
  return label;
}

/** The name of the page `path` belongs to — the longest matching href wins (shared rule,
 *  `active-route.ts`), so `/admin/employees/123` is "Mitarbeitende". "" when no page matches. */
export function labelForPath(path: string): string {
  const key = activeNavHref(PAGE_HREFS, path);
  return key === null ? "" : (PAGE_LABELS as Record<string, string>)[key];
}
