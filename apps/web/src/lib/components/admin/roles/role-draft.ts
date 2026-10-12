/**
 * The role being edited in the role-management UI (Issue #83, D-09). Pure — no store, no API.
 * The page owns the draft so a tab switch never discards it.
 */
import type { AccessRole, PermissionCatalogGroup } from "$lib/api/roles";

export interface RoleDraft {
  roleId: string | null;
  name: string;
  permissions: string[];
  baseline: { name: string; permissions: string[] };
}

export function newRoleDraft(): RoleDraft {
  return { roleId: null, name: "", permissions: [], baseline: { name: "", permissions: [] } };
}

export function draftFromRole(role: AccessRole): RoleDraft {
  return {
    roleId: role.id,
    name: role.name,
    permissions: [...role.permissions],
    baseline: { name: role.name, permissions: [...role.permissions] },
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((key) => set.has(key));
}

/** True when the trimmed name or the permission set differs from the loaded state. */
export function draftDirty(draft: RoleDraft): boolean {
  return (
    draft.name.trim() !== draft.baseline.name.trim() ||
    !sameSet(draft.permissions, draft.baseline.permissions)
  );
}

/** The selected keys in catalog order — the order the request body carries. */
export function orderedKeys(
  groups: readonly PermissionCatalogGroup[],
  selected: readonly string[],
): string[] {
  const chosen = new Set(selected);
  return groups
    .flatMap((group) => group.permissions.map((p) => p.key))
    .filter((k) => chosen.has(k));
}
