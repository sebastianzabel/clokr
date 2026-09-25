/**
 * Phase 100b Plan 01 (AC-1/AC-2, D-06) — Unterbau's public surface.
 *
 * What is exported here is this context's public surface — ADR 0001 rule 3 (no direct table
 * access across foreign schemas; access only through the owning context's public interface) is
 * why this file exists at all. Anything NOT exported here is
 * module-internal and may change at any time without notice — a caller outside this context that
 * needs a new question answered gets a new named export, never a reach-around import of an
 * internal module.
 *
 * Phase 101B Plan 07 (Issue #101, AC-2) gave this file its first real exports: these ten symbols
 * from six modules are exactly what every other context was already deep-importing before this
 * wave, named here instead of reached around. This still does NOT make Unterbau a facade context
 * like the other four — unlike them, Unterbau (Tenant/Employee/User and the rest of the shared
 * substrate) is readable from every context per ADR 0001: it is the ground every context stands
 * on, not a peer context another peer must go through a facade to reach. The re-exports below are
 * plain module re-exports of pre-existing helpers, not new facade functions —
 * `facade/employee-scope.ts` predates this file's first export and answers the same tenant-scope
 * question it always has; nothing here creates a new Prisma-backed surface.
 *
 * Should a genuine Unterbau facade need to exist later (a compliance-only surface, say), it would
 * live in `./facade/` like the others, never directly in this file — this file is a PURE
 * re-export surface and must contain no Prisma call, because it deliberately sits outside
 * `SCOPED_DIRS` (`apps/api/scripts/lint-tenant-scoping-types.ts`) — only `./facade/**` is walked
 * by plan 100B-04's tenant-gate extension, and a query placed directly here would be invisible to
 * that gate.
 *
 * D-02/D-07/D-08 apply the same way here as in every other context's `index.ts`, should a facade
 * ever be added: purpose-named functions answering the caller's question, `db:
 * Prisma.TransactionClient` as the first parameter, and a non-uniform soft-delete guard (reading
 * functions carry `deletedAt: null`; named compliance functions — DSGVO Art. 17 anonymisation,
 * hard delete, retention archival — deliberately omit it and say so in their own docblock).
 *
 * NOT_ANONYMIZED_EMPLOYEE_WHERE is re-exported from ./employee-anonymization-filter (plan 04's
 * leaf, zero foreign imports) rather than from ./anonymize, precisely so this index does NOT
 * transitively reach ../time-tracking or ../absence through it. anonymize.ts itself is unchanged
 * and still imports both, for its actual anonymisation functions (E-5, DSGVO Art. 17) — ADR 0001
 * Eintrag H explains why anonymize.ts stays in the Unterbau rather than moving to composition/.
 */
export { getHolidays, STATE_MAP } from "./holidays";
// Phase 292 (#292): the code STATE_MAP maps into. Declared public so a caller that carries a
// state code between two platform calls (month-gap-check.ts) can name its type instead of
// widening it to `string` and casting at the `getHolidays()` boundary.
export type { FederalStateCode } from "./holidays";
export { employeeScopeWhere } from "./facade/employee-scope";
export type { EmployeeScope } from "./facade/employee-scope";
export { auditReasonSchema, AUDIT_REASON_REQUIRED } from "./audit-reason";
export { calculateWorkDays } from "./calculate-work-days";
export { syncSchoolHolidaysForTenant } from "./plugins/school-holidays-sync";
export { NOT_ANONYMIZED_EMPLOYEE_WHERE } from "./employee-anonymization-filter";
// Phase 77b (Issue #77): the central, fail-closed access context and the one EmployeeScope factory.
export {
  accessContextFromRequest,
  accessContextForJob,
  employeeScopeFor,
  AccessContextError,
} from "./access-context";
export type { AccessContext } from "./access-context";

// Phase 72b (#72): the permission catalog (resource × action × reach) that #73/#75/#83 build on.
export {
  PERMISSIONS,
  PERMISSION_RESOURCES,
  PERMISSION_REACHES,
  PERMISSION_RELATIONS,
  permissionKey,
} from "./permission-catalog";
export type {
  Permission,
  PermissionKey,
  PermissionReach,
  PermissionRelation,
  PermissionResource,
} from "./permission-catalog";
// Phase 64b (issue #64) — salon read + write surface (Plan 02 adds the write functions)
export {
  listSalons,
  countActiveSalons,
  isMultiSalonTenant,
  salonOpeningHoursSchema,
  DEFAULT_SALON_OPENING_HOURS,
  findSalon,
  // Phase 325 (issue #325), D-04: additive re-export — every Shift/PhorestAppointment writer
  // resolves the tenant's default salon through this one function.
  findDefaultSalon,
  createSalon,
  createSalonSchema,
  updateSalon,
  updateSalonSchema,
  deactivateSalon,
  activateSalon,
} from "./facade/salons";
export type {
  SalonOpeningHours,
  CreateSalonInput,
  UpdateSalonInput,
  SalonStateChange,
  SalonDeactivation,
} from "./facade/salons";
// Phase 67b (issue #67) — salon assignment read surface; the lock-checked write functions
// (plan 02) are deliberately NOT re-exported, because they import the working-time-account index
// and this file must not transitively load another context.
export { salonForDay, listSalonAssignments } from "./facade/salon-assignments";
export type { SalonForDay } from "./facade/salon-assignments";
// Phase 73b (#73): the role-permission resolution path #74 calls, plus the case-insensitive
// name identity #74's own role-assignment lookups reuse.
export { roleGrants, normalizeRolePermissions, roleNameKey } from "./access-role";
// Phase 74b (#74): the function-level resolution of effective rights — "may user U apply
// permission P to a target described by employee and/or salon?" — plus the scope normalisation
// every role-assignment write path uses.
export { userMayApply } from "./facade/role-assignments";
// Phase 75b (#75), D-16/D-17: the holders of a ZUGEWIESEN permission in a tenant — the Unterbau
// answer every notification-recipient site asks instead of a role-based Prisma predicate.
export { userIdsHoldingPermission } from "./facade/role-assignments";
export {
  decideUserMayApply,
  normalizeRoleAssignmentScope,
  roleAssignmentScopeOf,
} from "./role-assignment";
export type {
  RoleAssignmentScope,
  RoleAssignmentTarget,
  NormalizedRoleAssignmentScope,
} from "./role-assignment";
// Phase 75b (#75): the three global system roles — fixed ids, display names and the permission
// sets derived from docs/permissions.md. Code identifies a system role by id only.
export {
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
  isSystemRoleId,
} from "./system-roles";
export type { SystemRoleSlot } from "./system-roles";
// Phase 75b (#75): the request-scoped permission resolver and the guards/checks every call site
// uses instead of a legacy role (D-08..D-12, D-30), plus the ONE compat-role derivation (D-14).
export {
  effectiveGrants,
  hasPermission,
  permissionReach,
  requirePermission,
  requireAnyPermission,
} from "./request-permissions";
export type { EffectiveGrants } from "./request-permissions";
export {
  systemRoleIdForLegacyRole,
  deriveCompatRole,
  compatRoleForUser,
  parseCompatRoleFilter,
  compatRoleUserWhere,
} from "./compat-role";
export type { CompatRoleAssignmentRow, CompatRoleFilter } from "./compat-role";
