/**
 * The ONE navigation definition (#516, since #844 the three areas Ich · Team · Verwalten, Z-01): the sections,
 * their headings and their items, as the desktop Sidebar and the mobile "Mehr" sheet show them. Both variants
 * render exactly what `visibleNavSections()` returns, so a target can neither exist on one and be missing on the
 * other nor be listed twice. Sub-pages of a hub (`parent` other than the area root), aliases and the avatar-menu
 * Profil appear in no section.
 *
 * Source: the route table (`routes.ts`). A UI-only gate; the API's permission guards still decide every request.
 */
import type { PermissionHolder } from "$lib/permissions";
import {
  APP_ROUTES,
  AREA_LABELS,
  visibleRoute,
  type Area,
  type RouteOptions,
} from "$lib/nav/routes";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Stable e2e handle `nav-<slug>` of the route FILE (pre-#844 URL) where one exists, so specs that address
   *  `nav-admin-employees` keep working; a page created by #844 uses its href. */
  testId: string;
}

/** `/admin/employees` → `nav-admin-employees` (Phase 73-05, D-05). */
export function navTestId(route: { href: string; file?: string }): string {
  return `nav-${(route.file ?? route.href).replace(/^\//, "").replace(/\//g, "-")}`;
}

/** An area heading with its items. */
export interface NavSection {
  area: Area;
  label: string;
  items: NavItem[];
}

export type NavOptions = RouteOptions;

const AREAS: readonly Area[] = ["ich", "team", "verwalten"];

/** The areas `user` sees, each with its visible rail entries; an area without one is dropped (Z-01: a person
 *  with one role sees one area). */
export function visibleNavSections(
  user: PermissionHolder | null | undefined,
  options: NavOptions,
): NavSection[] {
  return AREAS.map((area) => ({
    area,
    label: AREA_LABELS[area],
    items: APP_ROUTES.filter(
      (route) => route.area === area && route.inNav && visibleRoute(user, route, options),
    ).map((route) => ({
      href: route.href,
      label: route.label,
      icon: route.icon,
      testId: navTestId(route),
    })),
  })).filter((section) => section.items.length > 0);
}
