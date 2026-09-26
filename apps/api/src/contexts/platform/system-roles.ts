/**
 * Phase 75b (Issue #75) — the three system roles Admin, Manager and Mitarbeiter.
 * Phase 76b (Issue #76) — four more system roles: Inhaber, Salonmanager, Personalabteilung,
 * Ausbilder — the templates a customer copies to build a scoped SALONS/PERSONS role.
 *
 * A system role is a GLOBAL `AccessRole` row (`tenantId` null) with a fixed, well-known id (D-01).
 * Code identifies a system role ONLY by that id — never by its display name, which is a label for
 * people, not a control value (CLAUDE.md "Never use a new display string as a control value"). The
 * three 75b rows are inserted by
 * `packages/db/prisma/migrations/<timestamp>_system_roles_and_legacy_role_assignments`; the four
 * 76b rows by the separate, later, data-only
 * `packages/db/prisma/migrations/<timestamp>_system_role_templates` (D-02) — never by editing the
 * 75b file. Drift tests (`src/__tests__/system-roles-migration.test.ts`,
 * `src/__tests__/system-role-templates-migration.test.ts`) prove the migrated rows equal the
 * constants below for all seven slots. Changing a system role later therefore means a NEW
 * migration plus a code change here, never an edit of either alone.
 *
 * The 75b permission sets are not chosen by intuition: they reproduce what the legacy roles ADMIN,
 * MANAGER and EMPLOYEE may do today, read from the "heute" column of `docs/permissions.md` (D-03):
 *   - Admin       = every ZUGEWIESEN permission whose call sites admit A, plus every EIGENE one;
 *   - Manager     = every ZUGEWIESEN permission whose call sites admit M, plus every EIGENE one;
 *   - Mitarbeiter = every EIGENE permission, nothing else.
 * `src/contexts/platform/__tests__/system-roles.test.ts` derives those sets from the doc and
 * asserts they equal the lists below, element by element and in catalog order.
 *
 * The 76b template sets carry NO "heute" column meaning — they were decided per issue #76
 * (D-04..D-08), not derived from any legacy behaviour, and are pinned by hand-written literal-list
 * tests in the SAME test file, in a separate describe block. The one exception is Inhaber (D-04):
 * it is compared against the LIVE catalog enumeration (`PERMISSIONS.map(permissionKey)`), so a new
 * catalog permission fails that test until someone decides whether Inhaber gets it too.
 *
 * The lists are EXPLICIT on purpose, not computed from the catalog at runtime: a permission added
 * to the catalog later must not silently widen a system role. Each list still passes through
 * `normalizeRolePermissions`, so an unknown key fails at module load and the stored order is the
 * catalog order `AccessRole.permissions` uses everywhere else (73b, D-03).
 *
 * This module deliberately knows nothing about the legacy `User.role` column: mapping a legacy
 * role value onto a system role is the compat module's job (Phase 75b, D-14), not this one's.
 */
import { normalizeRolePermissions } from "./access-role";
import type { PermissionKey } from "./permission-catalog";

/** The fixed ids of the seven global system-role rows (D-01). Valid uuid shape. */
export const SYSTEM_ROLE_IDS = {
  ADMIN: "00000000-0000-4000-8000-00000000a001",
  MANAGER: "00000000-0000-4000-8000-00000000a002",
  EMPLOYEE: "00000000-0000-4000-8000-00000000a003",
  OWNER: "00000000-0000-4000-8000-00000000a004",
  SALON_MANAGER: "00000000-0000-4000-8000-00000000a005",
  HR: "00000000-0000-4000-8000-00000000a006",
  TRAINER: "00000000-0000-4000-8000-00000000a007",
} as const;

/** One of the seven system-role slots. */
export type SystemRoleSlot = keyof typeof SYSTEM_ROLE_IDS;

/** The display names of the system roles (D-02). Labels only — never compared by code. */
export const SYSTEM_ROLE_NAMES: Readonly<Record<SystemRoleSlot, string>> = Object.freeze({
  ADMIN: "Admin",
  MANAGER: "Manager",
  EMPLOYEE: "Mitarbeiter",
  OWNER: "Inhaber",
  SALON_MANAGER: "Salonmanager",
  HR: "Personalabteilung",
  TRAINER: "Ausbilder",
});

/** Every EIGENE permission of the 72b catalog — the whole Mitarbeiter role (D-03). */
const EMPLOYEE_PERMISSION_KEYS = [
  "employee:read:EIGENE",
  "employee:update-avatar:EIGENE",
  "contract:read:EIGENE",
  "time-entry:read:EIGENE",
  "time-entry:create:EIGENE",
  "time-entry:update:EIGENE",
  "time-entry:delete:EIGENE",
  "retro-request:read:EIGENE",
  "retro-request:create:EIGENE",
  "leave-request:read:EIGENE",
  "leave-request:create:EIGENE",
  "leave-request:cancel:EIGENE",
  "section9:read:EIGENE",
  "section9:upload:EIGENE",
  "leave-entitlement:read:EIGENE",
  "vocational-school:read:EIGENE",
  "overtime:read:EIGENE",
  "shift:read:EIGENE",
  "shift-pattern:read:EIGENE",
  "availability:read:EIGENE",
  "availability:update:EIGENE",
  "report:export:EIGENE",
] as const;

/** EIGENE permissions plus every ZUGEWIESEN permission whose call sites admit M today (D-03). */
const MANAGER_PERMISSION_KEYS = [
  "employee:read:EIGENE",
  "employee:read:ZUGEWIESEN",
  "employee:update-avatar:EIGENE",
  "employee:update-avatar:ZUGEWIESEN",
  "contract:read:EIGENE",
  "contract:read:ZUGEWIESEN",
  "contract:update:ZUGEWIESEN",
  "salon:read:ZUGEWIESEN",
  "time-entry:read:EIGENE",
  "time-entry:read:ZUGEWIESEN",
  "time-entry:create:EIGENE",
  "time-entry:create:ZUGEWIESEN",
  "time-entry:update:EIGENE",
  "time-entry:update:ZUGEWIESEN",
  "time-entry:delete:EIGENE",
  "time-entry:delete:ZUGEWIESEN",
  "time-entry:revalidate:ZUGEWIESEN",
  "retro-request:read:EIGENE",
  "retro-request:read:ZUGEWIESEN",
  "retro-request:create:EIGENE",
  "retro-request:create:ZUGEWIESEN",
  "retro-request:approve:ZUGEWIESEN",
  "leave-request:read:EIGENE",
  "leave-request:read:ZUGEWIESEN",
  "leave-request:create:EIGENE",
  "leave-request:create:ZUGEWIESEN",
  "leave-request:approve:ZUGEWIESEN",
  "leave-request:correct:ZUGEWIESEN",
  "leave-request:attest:ZUGEWIESEN",
  "leave-request:cancel:EIGENE",
  "leave-request:cancel:ZUGEWIESEN",
  "section9:read:EIGENE",
  "section9:read:ZUGEWIESEN",
  "section9:upload:EIGENE",
  "section9:upload:ZUGEWIESEN",
  "section9:decide:ZUGEWIESEN",
  "leave-entitlement:read:EIGENE",
  "leave-entitlement:read:ZUGEWIESEN",
  "leave-entitlement:update:ZUGEWIESEN",
  "leave-config:read:ZUGEWIESEN",
  "vocational-school:read:EIGENE",
  "vocational-school:read:ZUGEWIESEN",
  "vocational-school:manage:ZUGEWIESEN",
  "overtime:read:EIGENE",
  "overtime:read:ZUGEWIESEN",
  "overtime:settle:ZUGEWIESEN",
  "month-close:read:ZUGEWIESEN",
  "month-close:close:ZUGEWIESEN",
  "shift:read:EIGENE",
  "shift:read:ZUGEWIESEN",
  "shift:plan:ZUGEWIESEN",
  "shift-pattern:read:EIGENE",
  "shift-pattern:read:ZUGEWIESEN",
  "shift-pattern:update:ZUGEWIESEN",
  "availability:read:EIGENE",
  "availability:read:ZUGEWIESEN",
  "availability:update:EIGENE",
  "availability:update:ZUGEWIESEN",
  "report:read:ZUGEWIESEN",
  "report:export:EIGENE",
  "report:export:ZUGEWIESEN",
  "report:notify:ZUGEWIESEN",
  "team-overview:read:ZUGEWIESEN",
] as const;

/** EIGENE permissions plus every ZUGEWIESEN permission whose call sites admit A today (D-03). */
const ADMIN_PERMISSION_KEYS = [
  "employee:read:EIGENE",
  "employee:read:ZUGEWIESEN",
  "employee:create:ZUGEWIESEN",
  "employee:update:ZUGEWIESEN",
  "employee:manage-access:ZUGEWIESEN",
  "employee:anonymize:ZUGEWIESEN",
  "employee:import:ZUGEWIESEN",
  "employee:update-avatar:EIGENE",
  "employee:update-avatar:ZUGEWIESEN",
  "contract:read:EIGENE",
  "contract:read:ZUGEWIESEN",
  "contract:update:ZUGEWIESEN",
  "tenant-settings:read:ZUGEWIESEN",
  "tenant-settings:update:ZUGEWIESEN",
  "api-key:manage:ZUGEWIESEN",
  "audit-log:read:ZUGEWIESEN",
  "holiday:manage:ZUGEWIESEN",
  "salon:read:ZUGEWIESEN",
  "salon:manage:ZUGEWIESEN",
  "role:read:ZUGEWIESEN",
  "role:manage:ZUGEWIESEN",
  "role-assignment:manage:ZUGEWIESEN",
  "time-entry:read:EIGENE",
  "time-entry:read:ZUGEWIESEN",
  "time-entry:create:EIGENE",
  "time-entry:create:ZUGEWIESEN",
  "time-entry:update:EIGENE",
  "time-entry:update:ZUGEWIESEN",
  "time-entry:delete:EIGENE",
  "time-entry:delete:ZUGEWIESEN",
  "time-entry:revalidate:ZUGEWIESEN",
  "time-entry:import:ZUGEWIESEN",
  "retro-request:read:EIGENE",
  "retro-request:read:ZUGEWIESEN",
  "retro-request:create:EIGENE",
  "retro-request:create:ZUGEWIESEN",
  "retro-request:approve:ZUGEWIESEN",
  "presence-source:manage:ZUGEWIESEN",
  "terminal:manage:ZUGEWIESEN",
  "leave-request:read:EIGENE",
  "leave-request:read:ZUGEWIESEN",
  "leave-request:create:EIGENE",
  "leave-request:create:ZUGEWIESEN",
  "leave-request:approve:ZUGEWIESEN",
  "leave-request:correct:ZUGEWIESEN",
  "leave-request:attest:ZUGEWIESEN",
  "leave-request:cancel:EIGENE",
  "leave-request:cancel:ZUGEWIESEN",
  "section9:read:EIGENE",
  "section9:read:ZUGEWIESEN",
  "section9:upload:EIGENE",
  "section9:upload:ZUGEWIESEN",
  "section9:decide:ZUGEWIESEN",
  "leave-entitlement:read:EIGENE",
  "leave-entitlement:read:ZUGEWIESEN",
  "leave-entitlement:update:ZUGEWIESEN",
  "leave-config:read:ZUGEWIESEN",
  "leave-config:manage:ZUGEWIESEN",
  "company-shutdown:manage:ZUGEWIESEN",
  "vocational-school:read:EIGENE",
  "vocational-school:read:ZUGEWIESEN",
  "vocational-school:manage:ZUGEWIESEN",
  "overtime:read:EIGENE",
  "overtime:read:ZUGEWIESEN",
  "overtime:settle:ZUGEWIESEN",
  "overtime:set-opening-balance:ZUGEWIESEN",
  "month-close:read:ZUGEWIESEN",
  "month-close:close:ZUGEWIESEN",
  "month-close:unlock:ZUGEWIESEN",
  "month-close:close-year:ZUGEWIESEN",
  "shift:read:EIGENE",
  "shift:read:ZUGEWIESEN",
  "shift:plan:ZUGEWIESEN",
  "shift-config:manage:ZUGEWIESEN",
  "shift-pattern:read:EIGENE",
  "shift-pattern:read:ZUGEWIESEN",
  "shift-pattern:update:ZUGEWIESEN",
  "availability:read:EIGENE",
  "availability:read:ZUGEWIESEN",
  "availability:update:EIGENE",
  "availability:update:ZUGEWIESEN",
  "integration:manage:ZUGEWIESEN",
  "report:read:ZUGEWIESEN",
  "report:export:EIGENE",
  "report:export:ZUGEWIESEN",
  "report:notify:ZUGEWIESEN",
  "team-overview:read:ZUGEWIESEN",
] as const;

/**
 * Inhaber (D-04) — every catalog permission, the "arbeitender Inhaber" (working owner). This is a
 * SEPARATE literal from `ADMIN_PERMISSION_KEYS`, never a reference to it: today the content
 * happens to match Admin's list, but Inhaber and Admin are different rows with different intended
 * scope/label, and a future divergence of one must never silently move the other. A dedicated test
 * compares this list against the LIVE catalog enumeration (`PERMISSIONS.map(permissionKey)`), not
 * against a count, so a new catalog permission fails that test until someone decides for Inhaber.
 */
const OWNER_PERMISSION_KEYS = [
  "employee:read:EIGENE",
  "employee:read:ZUGEWIESEN",
  "employee:create:ZUGEWIESEN",
  "employee:update:ZUGEWIESEN",
  "employee:manage-access:ZUGEWIESEN",
  "employee:anonymize:ZUGEWIESEN",
  "employee:import:ZUGEWIESEN",
  "employee:update-avatar:EIGENE",
  "employee:update-avatar:ZUGEWIESEN",
  "contract:read:EIGENE",
  "contract:read:ZUGEWIESEN",
  "contract:update:ZUGEWIESEN",
  "tenant-settings:read:ZUGEWIESEN",
  "tenant-settings:update:ZUGEWIESEN",
  "api-key:manage:ZUGEWIESEN",
  "audit-log:read:ZUGEWIESEN",
  "holiday:manage:ZUGEWIESEN",
  "salon:read:ZUGEWIESEN",
  "salon:manage:ZUGEWIESEN",
  "role:read:ZUGEWIESEN",
  "role:manage:ZUGEWIESEN",
  "role-assignment:manage:ZUGEWIESEN",
  "time-entry:read:EIGENE",
  "time-entry:read:ZUGEWIESEN",
  "time-entry:create:EIGENE",
  "time-entry:create:ZUGEWIESEN",
  "time-entry:update:EIGENE",
  "time-entry:update:ZUGEWIESEN",
  "time-entry:delete:EIGENE",
  "time-entry:delete:ZUGEWIESEN",
  "time-entry:revalidate:ZUGEWIESEN",
  "time-entry:import:ZUGEWIESEN",
  "retro-request:read:EIGENE",
  "retro-request:read:ZUGEWIESEN",
  "retro-request:create:EIGENE",
  "retro-request:create:ZUGEWIESEN",
  "retro-request:approve:ZUGEWIESEN",
  "presence-source:manage:ZUGEWIESEN",
  "terminal:manage:ZUGEWIESEN",
  "leave-request:read:EIGENE",
  "leave-request:read:ZUGEWIESEN",
  "leave-request:create:EIGENE",
  "leave-request:create:ZUGEWIESEN",
  "leave-request:approve:ZUGEWIESEN",
  "leave-request:correct:ZUGEWIESEN",
  "leave-request:attest:ZUGEWIESEN",
  "leave-request:cancel:EIGENE",
  "leave-request:cancel:ZUGEWIESEN",
  "section9:read:EIGENE",
  "section9:read:ZUGEWIESEN",
  "section9:upload:EIGENE",
  "section9:upload:ZUGEWIESEN",
  "section9:decide:ZUGEWIESEN",
  "leave-entitlement:read:EIGENE",
  "leave-entitlement:read:ZUGEWIESEN",
  "leave-entitlement:update:ZUGEWIESEN",
  "leave-config:read:ZUGEWIESEN",
  "leave-config:manage:ZUGEWIESEN",
  "company-shutdown:manage:ZUGEWIESEN",
  "vocational-school:read:EIGENE",
  "vocational-school:read:ZUGEWIESEN",
  "vocational-school:manage:ZUGEWIESEN",
  "overtime:read:EIGENE",
  "overtime:read:ZUGEWIESEN",
  "overtime:settle:ZUGEWIESEN",
  "overtime:set-opening-balance:ZUGEWIESEN",
  "month-close:read:ZUGEWIESEN",
  "month-close:close:ZUGEWIESEN",
  "month-close:unlock:ZUGEWIESEN",
  "month-close:close-year:ZUGEWIESEN",
  "shift:read:EIGENE",
  "shift:read:ZUGEWIESEN",
  "shift:plan:ZUGEWIESEN",
  "shift-config:manage:ZUGEWIESEN",
  "shift-pattern:read:EIGENE",
  "shift-pattern:read:ZUGEWIESEN",
  "shift-pattern:update:ZUGEWIESEN",
  "availability:read:EIGENE",
  "availability:read:ZUGEWIESEN",
  "availability:update:EIGENE",
  "availability:update:ZUGEWIESEN",
  "integration:manage:ZUGEWIESEN",
  "report:read:ZUGEWIESEN",
  "report:export:EIGENE",
  "report:export:ZUGEWIESEN",
  "report:notify:ZUGEWIESEN",
  "team-overview:read:ZUGEWIESEN",
] as const;

/**
 * Salonmanager (D-05), intended scope SALONS — ZUGEWIESEN only, no EIGENE. Excludes
 * `leave-request:correct` (retroactively rewrites an approved leave and recalculates saldo —
 * Inhaber's call), every `overtime:`/`month-close:`/`contract:`/`report:` key (saldo and the
 * monthly report stay with Inhaber/Personalabteilung), every MANDANT-relation permission (they
 * only take effect at TENANT scope), `shift-pattern:update`/`availability:update`
 * (contract-adjacent — planning uses `shift:plan`), `vocational-school:manage` and
 * `leave-entitlement:update`.
 */
const SALON_MANAGER_PERMISSION_KEYS = [
  "employee:read:ZUGEWIESEN",
  "time-entry:read:ZUGEWIESEN",
  "time-entry:create:ZUGEWIESEN",
  "time-entry:update:ZUGEWIESEN",
  "time-entry:delete:ZUGEWIESEN",
  "time-entry:revalidate:ZUGEWIESEN",
  "retro-request:read:ZUGEWIESEN",
  "retro-request:create:ZUGEWIESEN",
  "retro-request:approve:ZUGEWIESEN",
  "leave-request:read:ZUGEWIESEN",
  "leave-request:create:ZUGEWIESEN",
  "leave-request:approve:ZUGEWIESEN",
  "leave-request:attest:ZUGEWIESEN",
  "leave-request:cancel:ZUGEWIESEN",
  "section9:read:ZUGEWIESEN",
  "section9:upload:ZUGEWIESEN",
  "section9:decide:ZUGEWIESEN",
  "leave-entitlement:read:ZUGEWIESEN",
  "vocational-school:read:ZUGEWIESEN",
  "shift:read:ZUGEWIESEN",
  "shift:plan:ZUGEWIESEN",
  "shift-pattern:read:ZUGEWIESEN",
  "availability:read:ZUGEWIESEN",
  "team-overview:read:ZUGEWIESEN",
] as const;

/**
 * Personalabteilung (D-07), intended scope TENANT — ZUGEWIESEN only, no EIGENE. Excludes every
 * `time-entry:`/`retro-request:` key, presence-source/terminal, every `shift:`/`shift-pattern:`/
 * `availability:` key (attendance = movement profile), `team-overview:read`, `report:*` (bundles
 * daily rows with the monthly report), every approve/decide/attest/correct/cancel permission
 * ("jede Genehmigung" stays with Inhaber/Salonmanager), `employee:anonymize` (DSGVO deletion stays
 * Inhaber), `employee:import` (the CSV import sets roles), `employee:manage-access`
 * (login/roles), `overtime:settle`/`overtime:set-opening-balance`, `month-close:close`/
 * `unlock`/`close-year`, and every MANDANT permission.
 */
const HR_PERMISSION_KEYS = [
  "employee:read:ZUGEWIESEN",
  "employee:create:ZUGEWIESEN",
  "employee:update:ZUGEWIESEN",
  "employee:update-avatar:ZUGEWIESEN",
  "contract:read:ZUGEWIESEN",
  "contract:update:ZUGEWIESEN",
  "leave-request:read:ZUGEWIESEN",
  "section9:read:ZUGEWIESEN",
  "leave-entitlement:read:ZUGEWIESEN",
  "leave-entitlement:update:ZUGEWIESEN",
  "vocational-school:read:ZUGEWIESEN",
  "overtime:read:ZUGEWIESEN",
  "month-close:read:ZUGEWIESEN",
] as const;

/**
 * Ausbilder (D-08), intended scope PERSONS — ZUGEWIESEN only, no EIGENE, no approve/correct (403
 * on those, AC). `employee:read` is required to see who the listed trainees are.
 */
const TRAINER_PERMISSION_KEYS = [
  "employee:read:ZUGEWIESEN",
  "time-entry:read:ZUGEWIESEN",
  "leave-request:read:ZUGEWIESEN",
  "vocational-school:read:ZUGEWIESEN",
  "shift:read:ZUGEWIESEN",
] as const;

/** The permission content of each system role, in catalog order (D-03, D-04). */
export const SYSTEM_ROLE_PERMISSIONS: Readonly<Record<SystemRoleSlot, readonly PermissionKey[]>> =
  Object.freeze({
    ADMIN: Object.freeze(normalizeRolePermissions(ADMIN_PERMISSION_KEYS)),
    MANAGER: Object.freeze(normalizeRolePermissions(MANAGER_PERMISSION_KEYS)),
    EMPLOYEE: Object.freeze(normalizeRolePermissions(EMPLOYEE_PERMISSION_KEYS)),
    OWNER: Object.freeze(normalizeRolePermissions(OWNER_PERMISSION_KEYS)),
    SALON_MANAGER: Object.freeze(normalizeRolePermissions(SALON_MANAGER_PERMISSION_KEYS)),
    HR: Object.freeze(normalizeRolePermissions(HR_PERMISSION_KEYS)),
    TRAINER: Object.freeze(normalizeRolePermissions(TRAINER_PERMISSION_KEYS)),
  });

const SYSTEM_ROLE_ID_SET: ReadonlySet<string> = new Set(Object.values(SYSTEM_ROLE_IDS));

/** True when `id` is the id of one of the seven system roles (D-01). */
export function isSystemRoleId(id: string): boolean {
  return SYSTEM_ROLE_ID_SET.has(id);
}
