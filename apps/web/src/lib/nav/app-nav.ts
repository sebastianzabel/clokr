/**
 * The ONE navigation definition (#516): the sections, their headings and their items, as the
 * desktop Sidebar and the mobile "Mehr" sheet show them. Both variants render exactly what
 * `visibleNavSections()` returns, so a target can neither exist on one and be missing on the
 * other nor be listed twice in two hand-written arrays. Redirect-only routes (`inNav: false` in
 * the admin route map) appear in no section.
 *
 * Sources, each the single owner of its part: the personal items below, `team-nav.ts` (Team) and
 * `admin-route-permissions.ts` (the five admin groups, filtered per permission, #83). A UI-only
 * gate; the API's permission guards still decide every request.
 */
import type { PermissionHolder } from "$lib/permissions";
import { visibleTeamNavItems } from "$lib/nav/team-nav";
import { visibleAdminNavGroups } from "$lib/nav/admin-route-permissions";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

/** A heading with its items. `isAdminGroup` selects the smaller admin sub-heading style. */
export interface NavSection {
  label: string;
  items: NavItem[];
  isAdminGroup?: boolean;
}

/** The personal items every signed-in user has ("Mein Bereich"). */
const PERSONAL_NAV: readonly NavItem[] = [
  { href: "/dashboard", label: "Übersicht", icon: "dashboard" },
  { href: "/time-entries", label: "Zeiterfassung", icon: "clock" },
  { href: "/leave", label: "Abwesenheiten", icon: "umbrella" },
  { href: "/availability", label: "Verfügbarkeit", icon: "calendar-check" },
];

export interface NavOptions {
  /** Tenant feature flag of the Verfügbarkeits-System (Phase 47.3); off hides both entries. */
  availabilityEnabled: boolean;
}

export function visibleNavSections(
  user: PermissionHolder | null | undefined,
  options: NavOptions,
): NavSection[] {
  const personal = PERSONAL_NAV.filter(
    (item) => options.availabilityEnabled || item.href !== "/availability",
  );
  const sections: NavSection[] = [{ label: "Mein Bereich", items: [...personal] }];
  const team = visibleTeamNavItems(user);
  if (team.length > 0) sections.push({ label: "Team", items: team });
  for (const group of visibleAdminNavGroups(user, options)) {
    sections.push({ label: group.label, items: group.items, isAdminGroup: true });
  }
  return sections;
}
