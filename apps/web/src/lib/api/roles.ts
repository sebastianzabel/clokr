/**
 * Role and role-assignment API wrappers for the role-management UI (Issue #83).
 *
 * Server-owned on purpose: the German permission labels come from `GET /roles/permission-catalog`
 * (D-02) and the four-eyes combination rule of #78 lives only in the API (D-07). This module
 * branches on the server's control code, never on a message or a name.
 */
import { api, ApiError } from "$api/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PermissionCatalogEntry {
  key: string;
  label: string;
  reach: "EIGENE" | "ZUGEWIESEN";
  relation: "PERSON" | "MANDANT";
}

export interface PermissionCatalogGroup {
  resource: string;
  label: string;
  permissions: PermissionCatalogEntry[];
}

export interface AccessRole {
  id: string;
  name: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AssignmentScope =
  | { type: "TENANT" }
  | { type: "SALONS"; salonIds: string[] }
  | { type: "PERSONS"; employeeIds: string[] };

export interface RoleAssignment {
  id: string;
  userId: string;
  accessRoleId: string;
  roleName: string;
  isSystemRole: boolean;
  scope: AssignmentScope;
  createdAt: string;
  updatedAt: string;
}

export interface AssignablePerson {
  employeeId: string;
  userId: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

/** The control code the API answers when a save newly creates the four-eyes combination (#78). */
const FOUR_EYES_CONFIRMATION_CODE = "FOUR_EYES_CONFIRMATION_REQUIRED";

/** True only for the four-eyes 409 of the API — the UI then asks for explicit confirmation. */
export function isFourEyesConfirmation(err: unknown): err is ApiError {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const data = err.data as { code?: unknown } | undefined;
  return data?.code === FOUR_EYES_CONFIRMATION_CODE;
}

// ── Roles ─────────────────────────────────────────────────────────────────────

export function fetchPermissionCatalog() {
  return api.get<PermissionCatalogGroup[]>("/roles/permission-catalog");
}

export function listRoles() {
  return api.get<AccessRole[]>("/roles");
}

export function createRole(body: { name: string; permissions: string[]; confirm?: boolean }) {
  return api.post<AccessRole>("/roles", body);
}

export function updateRole(
  id: string,
  body: { name?: string; permissions?: string[]; confirm?: boolean },
) {
  return api.patch<AccessRole>(`/roles/${id}`, body);
}

export function copyRole(id: string, body: { name?: string; confirm?: boolean }) {
  return api.post<AccessRole>(`/roles/${id}/copy`, body);
}

export function deleteRole(id: string) {
  return api.delete<void>(`/roles/${id}`);
}

// ── Role assignments ──────────────────────────────────────────────────────────

export function listRoleAssignments() {
  return api.get<RoleAssignment[]>("/role-assignments");
}

export function listAssignablePeople() {
  return api.get<AssignablePerson[]>("/role-assignments/people");
}

export function createRoleAssignment(body: {
  userId: string;
  accessRoleId: string;
  scope: AssignmentScope;
}) {
  return api.post<RoleAssignment>("/role-assignments", body);
}

export function updateRoleAssignment(
  id: string,
  body: { accessRoleId?: string; scope?: AssignmentScope },
) {
  return api.patch<RoleAssignment>(`/role-assignments/${id}`, body);
}

export function deleteRoleAssignment(id: string) {
  return api.delete<void>(`/role-assignments/${id}`);
}
