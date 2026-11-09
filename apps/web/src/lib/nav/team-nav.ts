/**
 * Phase 378 (Issue #378) — the ONE list of Team-Bereich nav entries and the permission(s) that
 * gate each one. Replaces the two byte-identical, role-gated `managerNav` (Sidebar.svelte) /
 * `managerMore` (BottomTabBar.svelte) arrays that used to exist independently — both now import
 * `visibleTeamNavItems()` instead of hand-filtering their own copy.
 *
 * The mapping is not "every team-ish permission gets an entry" — it is picked so that, applied to
 * the two REAL scoped Systemrollen-Templates (`docs/permissions.md`'s Salonmanager and Ausbilder
 * rows), the result matches the issue's Akzeptanzkriterien exactly:
 *   - Salonmanager (Salon-Scope) sees Inbox, Team-Zeiten, Abwesenheiten,
 *     Schichtplanung — not Berichte (the template holds no `report:read:ZUGEWIESEN`).
 *   - Ausbilder (Personen-Scope) sees only Team-Zeiten, Abwesenheiten — no
 *     Inbox (no approve permission), no Schichtplanung (no `shift:plan`, only `shift:read` —
 *     the page has no read-only mode, see the item's own comment below), no Berichte.
 *   - ADMIN/MANAGER (legacy fallback, every permission via the compat system-role fallback) see
 *     every item, unchanged from before this phase.
 */
import { hasAnyPermission, hasPermission, type PermissionHolder } from "$lib/permissions";

export interface TeamNavItem {
  href: string;
  label: string;
  icon: string;
}

interface TeamNavEntry extends TeamNavItem {
  /** A single permission key, or several where holding ANY of them is enough (e.g. `/inbox`
   *  approves both leave requests and Zeitnachträge — either permission alone unlocks it). */
  permission: string | readonly string[];
}

// #840 (D-840-06): ONE team entry for leave — „Abwesenheiten“ (/team/leave) holds the Übersicht
// timeline, the Anträge and the Planung; the old „Team-Kalender“ entry (/teamcal) left with its
// page (the URL redirects). „Inbox“ matches the page title of /inbox.
const TEAM_NAV_ENTRIES: readonly TeamNavEntry[] = [
  {
    href: "/inbox",
    label: "Inbox",
    icon: "inbox",
    // The Postfach decides leave requests, Zeitnachträge and (since #840 D-840-29) § 9 cases —
    // any one of the three is enough to need it.
    permission: [
      "leave-request:approve:ZUGEWIESEN",
      "retro-request:approve:ZUGEWIESEN",
      "section9:decide:ZUGEWIESEN",
    ],
  },
  {
    href: "/team/time-entries",
    label: "Team-Zeiten",
    icon: "clock",
    permission: "time-entry:read:ZUGEWIESEN",
  },
  {
    href: "/team/leave",
    label: "Abwesenheiten",
    icon: "umbrella",
    permission: "leave-request:read:ZUGEWIESEN",
  },
  {
    href: "/shifts",
    label: "Schichtplanung",
    icon: "grid",
    // The page is entirely write-oriented (create/generate/copy/delete shifts) with no read-only
    // rendering mode — gated on the PLAN permission, not the READ one, so a holder of only
    // `shift:read:ZUGEWIESEN` (Ausbilder) is not handed a half-working edit UI (Phase 378, D-05).
    permission: "shift:plan:ZUGEWIESEN",
  },
  {
    href: "/reports",
    label: "Berichte",
    icon: "chart",
    permission: "report:read:ZUGEWIESEN",
  },
] as const;

function isVisible(entry: TeamNavEntry, user: PermissionHolder | null | undefined): boolean {
  return Array.isArray(entry.permission)
    ? hasAnyPermission(user, entry.permission)
    : hasPermission(user, entry.permission as string);
}

/** The Team-Bereich nav items `user` currently holds a permission for, in the fixed display
 *  order above. Empty for a plain Mitarbeiter — callers hide the whole "Team" section then. */
export function visibleTeamNavItems(user: PermissionHolder | null | undefined): TeamNavItem[] {
  return TEAM_NAV_ENTRIES.filter((entry) => isVisible(entry, user)).map(
    ({ href, label, icon }) => ({ href, label, icon }),
  );
}

/**
 * Issue #86 (AC-86-3) - may `user` open the team page `href`? Answers from the same
 * `TEAM_NAV_ENTRIES` permission as the nav, so a page that guards itself by this function and the
 * nav entry that links to it can never disagree. UX only - the API refuses a caller without the
 * permission anyway. An href that is not a team nav entry is refused (fail-closed).
 */
export function mayOpenTeamPage(href: string, user: PermissionHolder | null | undefined): boolean {
  const entry = TEAM_NAV_ENTRIES.find((e) => e.href === href);
  return entry !== undefined && isVisible(entry, user);
}
