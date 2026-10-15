/**
 * Issue #538 - what the caller's PERMISSIONS let a page show, decided in one place per page so it is
 * unit-testable per permission set (the route files import `$app/*` and cannot be mounted, see
 * `layout-boundaries.test.ts`). None of this is an access boundary: the API refuses everything the
 * caller may not do, these only hide controls and blocks. The compat role (`User.role`) is never
 * read - a custom role or a salon-scoped role (Salonmanager, Ausbilder) shows exactly what its
 * permissions allow. Keys are written out in full and checked against `docs/permissions.md`.
 */
import { hasPermission, type PermissionHolder } from "$lib/permissions";

type Caller = PermissionHolder | null | undefined;

/** `/reports`: one flag per block, each the permission of the endpoint behind it. */
export interface ReportRights {
  /** `GET /dashboard/today-attendance` - team-overview:read. */
  canTeamAttendance: boolean;
  /** `GET /dashboard/overtime-overview` - team-overview:read AND overtime:read. */
  canTeamOvertime: boolean;
  /** `GET /reports/leave-overview`, `/carryover-at-risk`, `/monthly` - report:read. */
  canReportRead: boolean;
  /** DATEV and the PDFs - report:export. */
  canReportExport: boolean;
  /** `POST /reports/carryover-warn` - report:notify. */
  canReportNotify: boolean;
  /** The team area replaces the personal monthly closes for anyone holding any of its rights. */
  showTeamArea: boolean;
}

export function reportRights(user: Caller): ReportRights {
  const canTeamAttendance = hasPermission(user, "team-overview:read:ZUGEWIESEN");
  const canTeamOvertime = canTeamAttendance && hasPermission(user, "overtime:read:ZUGEWIESEN");
  const canReportRead = hasPermission(user, "report:read:ZUGEWIESEN");
  const canReportExport = hasPermission(user, "report:export:ZUGEWIESEN");
  return {
    canTeamAttendance,
    canTeamOvertime,
    canReportRead,
    canReportExport,
    canReportNotify: hasPermission(user, "report:notify:ZUGEWIESEN"),
    showTeamArea: canTeamAttendance || canTeamOvertime || canReportRead || canReportExport,
  };
}

/** `/admin/employees` (list and detail): the controls the employee endpoints would accept. */
export interface EmployeeAdminRights {
  /** `POST /employees` - employee:create. */
  canCreate: boolean;
  /** Unlock, (de)activate, resend invitation - employee:manage-access. */
  canManageAccess: boolean;
  /** `PATCH /employees/:id`, including the § 18 ArbZG exemption - employee:update. */
  canUpdate: boolean;
  /** Setting or choosing a role (create, PATCH, import) - role-assignment:manage (#78, #354). */
  canAssignRoles: boolean;
  /** The list's action column exists when it holds at least one action. */
  showActions: boolean;
}

export function employeeAdminRights(user: Caller): EmployeeAdminRights {
  const canManageAccess = hasPermission(user, "employee:manage-access:ZUGEWIESEN");
  const canUpdate = hasPermission(user, "employee:update:ZUGEWIESEN");
  return {
    canCreate: hasPermission(user, "employee:create:ZUGEWIESEN"),
    canManageAccess,
    canUpdate,
    canAssignRoles: hasPermission(user, "role-assignment:manage:ZUGEWIESEN"),
    showActions: canManageAccess || canUpdate,
  };
}

/** `/time-entries`: may the caller file a Zeitnachtrag for their own entry
 *  (`POST /retro-entry-requests`, retro-request:create:EIGENE)? */
export function mayFileRetroRequest(user: Caller): boolean {
  return hasPermission(user, "retro-request:create:EIGENE");
}
