/**
 * Issue #944 — what the quick search (⌘K) finds. Pages come from the ONE route table (`routes.ts`) and are
 * offered under the same rule as the navigation (`visibleRoute`), so a page the person may open is findable by
 * its name, tab name or description and a page the person may not open is not. Persons come from the
 * reach-filtered `GET /employees` (#547); this module only maps and ranks them.
 */
import type { PermissionHolder } from "$lib/permissions";
import { hasPermission } from "$lib/permissions";
import {
  APP_ROUTES,
  AREA_LABELS,
  mayOpenPath,
  visibleRoute,
  type RouteOptions,
} from "$lib/nav/routes";

export interface PageHit {
  kind: "page";
  id: string;
  label: string;
  description: string;
  icon: string;
  href: string;
  group: string;
}

export interface PersonHit {
  kind: "person";
  id: string;
  label: string;
  description: string;
  icon: "user";
  href: string;
  group: "Personen";
}

export type SearchHit = PageHit | PersonHit;

/** Maximum number of person hits shown. */
export const MAX_PERSON_HITS = 8;

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Every page `user` may open from the route table, as palette entries (internal pages never). A tab page
 *  (`tabLabel` below a parent) is named "<page> – <tab>"; its tab name is searchable. */
export function pageIndex(
  user: PermissionHolder | null | undefined,
  options: RouteOptions,
): PageHit[] {
  return APP_ROUTES.filter((route) => route.internal !== true && visibleRoute(user, route, options))
    .filter((route) => route.href !== "/ich/profil/geraet-koppeln")
    .map((route) => {
      const isTab = route.tabLabel !== undefined && route.parent !== undefined;
      const parent =
        route.parent === undefined ? undefined : APP_ROUTES.find((r) => r.href === route.parent);
      const label = isTab ? `${route.label} – ${route.tabLabel}` : route.label;
      return {
        kind: "page" as const,
        id: route.href,
        label,
        description:
          route.description ?? (parent && !isTab ? parent.label : AREA_LABELS[route.area]),
        icon: route.icon,
        href: route.href,
        group: AREA_LABELS[route.area],
      };
    });
}

/** Pages matching `query` (all pages for an empty query), best matches first: name before description. */
export function searchPages(pages: readonly PageHit[], query: string): PageHit[] {
  const q = fold(query.trim());
  if (q === "") return [...pages];
  const rank = (page: PageHit): number => {
    const label = fold(page.label);
    if (label.startsWith(q)) return 0;
    if (label.includes(q)) return 1;
    return fold(page.description).includes(q) ? 2 : 3;
  };
  return pages
    .map((page, index) => ({ page, index, score: rank(page) }))
    .filter((entry) => entry.score < 3)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.page);
}

/** Does `user` read persons (any reach)? Only then the person search is offered. */
export function maySearchPersons(user: PermissionHolder | null | undefined): boolean {
  return hasPermission(user, "employee:read:ZUGEWIESEN");
}

export interface PersonRow {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber?: string | null;
}

/** The page a person hit opens: Verwalten › Personen › person where the route table lets `user` open it, else
 *  Team › Personen (a list; the Team area has no detail page). */
export function personHref(
  user: PermissionHolder | null | undefined,
  id: string,
  options: RouteOptions,
): string {
  const list = APP_ROUTES.find((route) => route.href === "/verwalten/personen");
  // The page the person sees in the navigation (#853, D-853-15: the Verwalten entry only for those who
  // create or edit persons), and only when the guard opens the detail below it.
  const detail = `/verwalten/personen/${encodeURIComponent(id)}`;
  return list !== undefined && visibleRoute(user, list, options) && mayOpenPath(user, detail)
    ? detail
    : "/team/personen";
}

/** Persons whose name or employee number contains every word of `query`, at most `MAX_PERSON_HITS`. */
export function personHits(
  user: PermissionHolder | null | undefined,
  rows: readonly PersonRow[],
  query: string,
  options: RouteOptions,
): PersonHit[] {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: PersonHit[] = [];
  for (const row of rows) {
    const name = `${row.firstName} ${row.lastName}`;
    const haystack = fold(`${name} ${row.lastName} ${row.firstName} ${row.employeeNumber ?? ""}`);
    if (!words.every((word) => haystack.includes(word))) continue;
    hits.push({
      kind: "person",
      id: `person:${row.id}`,
      label: name.trim(),
      description: row.employeeNumber ? `Personalnummer ${row.employeeNumber}` : "Person",
      icon: "user",
      href: personHref(user, row.id, options),
      group: "Personen",
    });
    if (hits.length >= MAX_PERSON_HITS) break;
  }
  return hits;
}
