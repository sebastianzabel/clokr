/**
 * Issue #86 (D-04, AC-86-7) and Issue #854 - the tab strip of the employee detail page, decided from
 * the caller's permissions in one place so it is unit-testable (the route page imports `$app/*` and
 * cannot be mounted). UX only: the API refuses every action the caller may not do whatever the page
 * shows.
 *
 * Tabs: Person · Vertrag · Urlaub · Salons · Zugang. „Zugang“ merges the two former tabs
 * „Berechtigungen“ and „Gefahrenzone“; it is offered when the caller may use at least one of its
 * parts (access management, role assignment, anonymisation). The former ids stay valid as hash
 * ALIASES (`DETAIL_TAB_ALIASES`) so bookmarks and the deep links of other code keep working, and a
 * hidden tab cannot be reached through the URL hash because `tabFromHash()` restores the hash against
 * the VISIBLE ids only (T-854-50).
 */
import type { EmployeeAdminRights } from "$lib/page-rights";

export interface EmployeeDetailTab {
  id: string;
  label: string;
}

/** Old and short hash names mapped onto the current tab ids (`#arbeitszeit` is used by e2e and links). */
export const DETAIL_TAB_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  stammdaten: "person",
  arbeitszeit: "vertrag",
  berechtigungen: "zugang",
  danger: "zugang",
});

export function employeeDetailTabs(
  rights: Pick<EmployeeAdminRights, "canManageAccess" | "canAssignRoles" | "canAnonymize">,
): EmployeeDetailTab[] {
  const tabs: EmployeeDetailTab[] = [
    { id: "person", label: "Person" },
    { id: "vertrag", label: "Vertrag" },
    { id: "urlaub", label: "Urlaub" },
    // Salon assignments (Issue #86, AC-86-5): the page itself needs employee:read, which every
    // caller of it holds; the maintaining buttons inside follow employee:update.
    { id: "salons", label: "Salons" },
  ];
  // Account (employee:manage-access), the role choice (role-assignment:manage) and anonymisation /
  // hard delete (employee:anonymize) are the parts of this tab.
  if (rights.canManageAccess || rights.canAssignRoles || rights.canAnonymize) {
    tabs.push({ id: "zugang", label: "Zugang" });
  }
  return tabs;
}
