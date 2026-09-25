/**
 * Phase 75b (Issue #75), D-08..D-12, D-30 — the request-scoped permission resolver and the
 * guards/checks every call site uses instead of a legacy role.
 *
 * ── What a caller holds ──────────────────────────────────────────────────────────────────────
 * {@link effectiveGrants} computes, once per request, two sets of catalog keys plus the caller's
 * own employee id:
 * - `zugewiesen`: ZUGEWIESEN keys, effective tenant-wide. Only a well-formed TENANT assignment
 *   feeds this set — SALONS/PERSONS scopes grant nothing tenant-wide until #91 enforces scopes at
 *   the API (D-09, fail closed).
 * - `eigene`: EIGENE keys, from any well-formed assignment; they apply to `ownEmployeeId` only.
 *
 * Sources, in this order:
 * - API key (detected by `req.apiKeyScopes`, which only the key path of `requireAuth` sets — never
 *   by reading the role on `req.user`, D-12): the Admin system role when the scopes include
 *   `admin`, else the Manager system role, with the role's FULL set (EIGENE included) and
 *   `ownEmployeeId` undefined, so every own-data comparison fails closed exactly as today (D-11,
 *   D-30, research C-3).
 * - User: ONE query loads the user's legacy column and their stored assignments in
 *   `req.user.tenantId`. When there is NO stored row, the system role of the legacy column stands
 *   in as one implicit TENANT assignment (the "Altrollen-Rückfall", D-08) — mapped by
 *   `systemRoleIdForLegacyRole` in `compat-role.ts`, the only module allowed to read role values.
 *   A single stored row (even a malformed one, or one on a foreign tenant's role) suppresses the
 *   fallback: such rows contribute nothing, so the caller then holds nothing from them (fail
 *   closed). No User row (a deleted user's still-valid token) → nothing.
 * Every contribution goes through `roleGrants` — the one role-evaluation path (AK-73-7) — after the
 * 74b filters "the role belongs to this tenant" and `storedRoleAssignmentScope` (IN-02).
 *
 * ── Deliberate non-choices ──────────────────────────────────────────────────────────────────
 * - Lives in the platform root, not under `facade/`: its signatures take Fastify types, which
 *   `lint-facade-signatures` (F2) forbids there. Other contexts import it only through
 *   `contexts/platform/index.ts`.
 * - Does not build a 77b access context (`access-context.ts`): its request constructor throws on an
 *   empty tenant, and a user without Employee legitimately carries `tenantId: ""` — the legacy role
 *   guard let them through, so the resolver must too (falling back to their column's system role).
 * - Does not re-check `User.isActive`: a valid access token of a since-deactivated user passed the
 *   legacy guard; changing that is not neutral and is deferred hardening (D-10).
 * - Memoized per request in a `WeakMap`, never globally: a cache of role rows would hide a role
 *   edited in the database (the D-22 mutation proof edits one) and would outlive the request.
 * - A missing system-role row throws (→ 500 through the global error handler, logged). Silently
 *   granting or denying would be wrong; the migration that inserts the rows runs before the code.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../../middleware/auth";
import { roleGrants } from "./access-role";
import { systemRoleIdForLegacyRole } from "./compat-role";
import {
  PERMISSIONS,
  permissionKey,
  type PermissionKey,
  type PermissionReach,
  type PermissionResource,
} from "./permission-catalog";
import { storedRoleAssignmentScope } from "./role-assignment";
import { SYSTEM_ROLE_IDS } from "./system-roles";

/** What the caller of one request may do (see the module docblock). */
export interface EffectiveGrants {
  readonly zugewiesen: ReadonlySet<PermissionKey>;
  readonly eigene: ReadonlySet<PermissionKey>;
  readonly ownEmployeeId: string | undefined;
}

/** A role row as the resolver evaluates it. */
interface GrantingRole {
  readonly id: string;
  readonly tenantId: string | null;
  readonly permissions: readonly string[];
}

const CATALOG: readonly { key: PermissionKey; reach: PermissionReach }[] = PERMISSIONS.map(
  (permission) => ({ key: permissionKey(permission), reach: permission.reach }),
);
const KNOWN_KEYS: ReadonlySet<string> = new Set(CATALOG.map((entry) => entry.key));

const memo = new WeakMap<FastifyRequest, Promise<EffectiveGrants>>();

function assertKnownKey(key: string): asserts key is PermissionKey {
  if (!KNOWN_KEYS.has(key)) {
    throw new Error(`request-permissions: unknown permission "${key}" (not in the catalog)`);
  }
}

/** Adds what `role` grants: EIGENE keys always, ZUGEWIESEN keys only for a tenant-wide source. */
function collect(
  role: GrantingRole,
  tenantWide: boolean,
  zugewiesen: Set<PermissionKey>,
  eigene: Set<PermissionKey>,
): void {
  for (const { key, reach } of CATALOG) {
    if (!roleGrants(role, key)) continue;
    if (reach === "EIGENE") eigene.add(key);
    else if (tenantWide) zugewiesen.add(key);
  }
}

async function loadSystemRole(req: FastifyRequest, id: string): Promise<GrantingRole> {
  const role = await req.server.prisma.accessRole.findUnique({
    where: { id },
    select: { id: true, tenantId: true, permissions: true },
  });
  if (!role) {
    throw new Error(
      `request-permissions: system role ${id} is missing — the migration that inserts the system roles has not been applied`,
    );
  }
  return role;
}

async function resolveGrants(req: FastifyRequest): Promise<EffectiveGrants> {
  const zugewiesen = new Set<PermissionKey>();
  const eigene = new Set<PermissionKey>();

  if (req.apiKeyScopes !== undefined) {
    const roleId = req.apiKeyScopes.includes("admin")
      ? SYSTEM_ROLE_IDS.ADMIN
      : SYSTEM_ROLE_IDS.MANAGER;
    collect(await loadSystemRole(req, roleId), true, zugewiesen, eigene);
    return { zugewiesen, eigene, ownEmployeeId: undefined };
  }

  const tenantId = req.user.tenantId;
  const ownEmployeeId = req.user.employeeId;
  const user = await req.server.prisma.user.findUnique({
    where: { id: req.user.sub },
    select: {
      role: true,
      roleAssignments: {
        where: { tenantId },
        select: {
          scopeType: true,
          salonIds: true,
          employeeIds: true,
          accessRole: { select: { id: true, tenantId: true, permissions: true } },
        },
      },
    },
  });
  if (!user) return { zugewiesen, eigene, ownEmployeeId };

  if (user.roleAssignments.length === 0) {
    const fallback = await loadSystemRole(req, systemRoleIdForLegacyRole(user.role));
    collect(fallback, true, zugewiesen, eigene);
    return { zugewiesen, eigene, ownEmployeeId };
  }

  for (const row of user.roleAssignments) {
    const roleBelongsHere =
      row.accessRole.tenantId === null || row.accessRole.tenantId === tenantId;
    if (!roleBelongsHere) continue;
    const scope = storedRoleAssignmentScope(row);
    if (scope === null) continue;
    collect(row.accessRole, scope.scopeType === "TENANT", zugewiesen, eigene);
  }
  return { zugewiesen, eigene, ownEmployeeId };
}

/**
 * The caller's effective grants, resolved at most once per request. Call only after
 * `requireAuth` succeeded (every guard below does that first).
 */
export function effectiveGrants(req: FastifyRequest): Promise<EffectiveGrants> {
  let grants = memo.get(req);
  if (!grants) {
    grants = resolveGrants(req);
    memo.set(req, grants);
  }
  return grants;
}

/**
 * Does the caller hold `key`? A ZUGEWIESEN key is answered from the tenant-wide set, an EIGENE key
 * from the own set — the caller still has to compare the target with `ownEmployeeId`. An unknown
 * key throws (a typo must never read as "denied").
 */
export async function hasPermission(req: FastifyRequest, key: PermissionKey): Promise<boolean> {
  assertKnownKey(key);
  const grants = await effectiveGrants(req);
  return key.endsWith(":ZUGEWIESEN") ? grants.zugewiesen.has(key) : grants.eigene.has(key);
}

/**
 * The widest reach the caller holds for `resourceAction` (`"employee:read"`): ZUGEWIESEN,
 * EIGENE, or null for neither. Throws when the catalog has neither reach for it.
 */
export async function permissionReach(
  req: FastifyRequest,
  resourceAction: `${PermissionResource}:${string}`,
): Promise<PermissionReach | null> {
  const zugewiesen = `${resourceAction}:ZUGEWIESEN` as PermissionKey;
  const eigene = `${resourceAction}:EIGENE` as PermissionKey;
  const hasZugewiesen = KNOWN_KEYS.has(zugewiesen);
  const hasEigene = KNOWN_KEYS.has(eigene);
  if (!hasZugewiesen && !hasEigene) {
    throw new Error(
      `request-permissions: unknown permission "${resourceAction}" (neither reach is in the catalog)`,
    );
  }
  if (hasZugewiesen && (await hasPermission(req, zugewiesen))) return "ZUGEWIESEN";
  if (hasEigene && (await hasPermission(req, eigene))) return "EIGENE";
  return null;
}

/**
 * preHandler: authenticate exactly as `requireAuth` does (its 401 bodies unchanged), then answer
 * 403 `{ error: "Forbidden" }` — byte-identical to the legacy role guard — unless the caller holds
 * `key`. The key is validated against the catalog when the guard is CREATED, i.e. at route
 * registration.
 */
export function requirePermission(key: PermissionKey) {
  assertKnownKey(key);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    if (!(await hasPermission(req, key))) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  };
}

/**
 * Like {@link requirePermission}, admitting a caller who holds ANY of `keys` — for a legacy guard
 * whose route serves both reaches (e.g. own data via EIGENE, everyone's via ZUGEWIESEN) and
 * decides the reach in the handler.
 */
export function requireAnyPermission(...keys: PermissionKey[]) {
  if (keys.length === 0) {
    throw new Error("request-permissions: requireAnyPermission needs at least one permission");
  }
  for (const key of keys) assertKnownKey(key);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    for (const key of keys) {
      if (await hasPermission(req, key)) return;
    }
    return reply.code(403).send({ error: "Forbidden" });
  };
}
