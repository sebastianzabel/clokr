/**
 * Phase 73b (Issue #73) — pure normalisation helpers for `AccessRole`.
 *
 * A role is a named SET of catalog permission keys (contexts/platform/permission-catalog.ts).
 * A system role is a row with `tenantId` null (global, seeded by #75/#76); a customer role is a
 * row with a tenant (owner decision on #73 — there is no separate "isSystem" flag, since a flag
 * could diverge from the tenant reference it would merely restate).
 *
 * The stored permission list is validated, de-duplicated and put into catalog order on every
 * write, so an unchanged copy is byte-equal to its source and audit diffs stay stable.
 *
 * `nameKey` exists because Prisma cannot express citext or a functional index in
 * `schema.prisma`, and the migration SQL this repo generates must never be hand-edited
 * (CLAUDE.md § Creating a migration). `nameKey` gives the database a real backstop for the
 * tenant-internal uniqueness race via `@@unique([tenantId, nameKey])`.
 *
 * Lockout invariant for #74 (D-12, not enforced here — no assignments exist yet): before a
 * customer role's permission set is changed, at least one active user must retain
 * `role:manage` at tenant scope after the change. This module carries no code for that rule;
 * it is recorded here as the contract #74 must implement on role update, assignment revocation,
 * and user deactivation/anonymisation.
 *
 * `roleGrants` is the ONE code path #74 evaluates a role through when deciding whether a role
 * grants a permission — identical for a system role and a customer role, because it reads only
 * `accessRole.permissions` and never `accessRole.tenantId` (AK-73-7). No "generic resolver", no
 * `hasPermission(user, …)` lives here — binding a user to a role (assignment, scope) is #74/#75,
 * not this module (D-11, no generalization on spec).
 */
import { PERMISSIONS, permissionKey, type PermissionKey } from "./permission-catalog";

/** Matches `apiKeyRoutes`' `createKeySchema.name` precedent (`api-keys.ts`). */
export const ROLE_NAME_MAX_LENGTH = 100;

/** The case-insensitive identity of a role name: trimmed, lower-cased. */
export function roleNameKey(name: string): string {
  return name.trim().toLowerCase();
}

const KNOWN_PERMISSION_KEYS = new Set<string>(PERMISSIONS.map(permissionKey));

/** Distinct input keys that are not a permission of the 72b catalog, in input order. */
export function unknownPermissionKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const key of keys) {
    if (KNOWN_PERMISSION_KEYS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unknown.push(key);
  }
  return unknown;
}

/**
 * Validates, de-duplicates and orders permission keys in catalog order (D-03). Throws when any
 * key is not in the 72b catalog — callers translate that into the 400 response. An empty input
 * yields an empty result: a role without permissions is valid (e.g. a draft).
 */
export function normalizeRolePermissions(keys: readonly string[]): PermissionKey[] {
  const unknown = unknownPermissionKeys(keys);
  if (unknown.length > 0) {
    throw new Error(`Unbekannte Permission(s): ${unknown.join(", ")}`);
  }
  const wanted = new Set(keys);
  const ordered: PermissionKey[] = [];
  for (const permission of PERMISSIONS) {
    const key = permissionKey(permission);
    if (wanted.has(key)) ordered.push(key);
  }
  return ordered;
}

/**
 * Does `accessRole` grant `permission`? Answers from `accessRole.permissions` ONLY — `tenantId`
 * is part of the input type on purpose (#74 passes whole rows of either a system or a customer
 * role) but is NEVER read here (AK-73-7): a system role and an unchanged copy of it that carries
 * a tenant must resolve identically for every catalog key.
 */
export function roleGrants(
  accessRole: { readonly tenantId: string | null; readonly permissions: readonly string[] },
  permission: PermissionKey,
): boolean {
  return accessRole.permissions.includes(permission);
}

/**
 * The name a copy of `sourceName` gets when no explicit name is given (73b-03's copy route):
 * attempt 1 -> `"<base> (Kopie)"`, attempt n >= 2 -> `"<base> (Kopie n)"`. `<base>` is the
 * trimmed source name, cut (then end-trimmed) so the full result never exceeds
 * `ROLE_NAME_MAX_LENGTH` characters. `attempt` must be an integer >= 1.
 */
export function copyRoleName(sourceName: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`copyRoleName: attempt must be an integer >= 1, got ${attempt}`);
  }
  const suffix = attempt === 1 ? " (Kopie)" : ` (Kopie ${attempt})`;
  const trimmedSource = sourceName.trim();
  const maxBaseLength = ROLE_NAME_MAX_LENGTH - suffix.length;
  const base =
    trimmedSource.length > maxBaseLength
      ? trimmedSource.slice(0, maxBaseLength).trimEnd()
      : trimmedSource;
  return `${base}${suffix}`;
}
