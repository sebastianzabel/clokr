/**
 * Issue #86 (D-04, AC-86-7) - the tab strip of the employee detail page, decided from the caller's
 * permissions in one place so it is unit-testable (the route page imports `$app/*` and cannot be
 * mounted). UX only: the API refuses every action the caller may not do whatever the page shows.
 *
 * The tab ids stay stable (`berechtigungen`, `danger`) so existing deep links keep working for the
 * people who may still open them; a hidden tab cannot be reached through the URL hash because the
 * page restores the hash against THIS list.
 */
import type { EmployeeAdminRights } from "$lib/page-rights";

export interface EmployeeDetailTab {
  id: string;
  label: string;
}

export function employeeDetailTabs(
  rights: Pick<EmployeeAdminRights, "canManageAccess" | "canAssignRoles" | "canAnonymize">,
): EmployeeDetailTab[] {
  const tabs: EmployeeDetailTab[] = [
    { id: "stammdaten", label: "Stammdaten" },
    { id: "arbeitszeit", label: "Arbeitszeit" },
    { id: "urlaub", label: "Urlaub" },
  ];
  // Account lock/unlock/invite (employee:manage-access) and the role choice (role-assignment:manage)
  // both live on this tab.
  if (rights.canManageAccess || rights.canAssignRoles) {
    tabs.push({ id: "berechtigungen", label: "Berechtigungen" });
  }
  // Anonymize and hard-delete (employee:anonymize) are the only actions of this tab.
  if (rights.canAnonymize) {
    tabs.push({ id: "danger", label: "Gefahrenzone" });
  }
  return tabs;
}
