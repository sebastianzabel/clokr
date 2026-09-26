import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@clokr/db";
import { hasPermission, requirePermission } from "../request-permissions";
import {
  ROLE_NAME_MAX_LENGTH,
  roleNameKey,
  unknownPermissionKeys,
  normalizeRolePermissions,
  copyRoleName,
} from "../access-role";
import { ROLE_LOCKOUT_MESSAGE, RoleLockoutError } from "../role-assignment";
import { withRoleLockoutGuard } from "../facade/role-assignments";
import { foreignKeyConstraintOf } from "../prisma-foreign-key";
import { requestAuditFields } from "../request-audit-fields";
import {
  createsFourEyesCombination,
  FourEyesConfirmationRequiredError,
  FOUR_EYES_CONFIRMATION_MESSAGE,
  FOUR_EYES_CONFIRMATION_REQUIRED,
} from "../four-eyes";

const ROLE_NAME_CONFLICT_MESSAGE = "Eine Rolle mit diesem Namen existiert bereits.";
const ROLE_NOT_FOUND_MESSAGE = "Rolle nicht gefunden";
const ROLE_SYSTEM_UPDATE_MESSAGE =
  "Systemrollen können nicht geändert werden. Kopieren Sie die Rolle, um sie anzupassen.";
const ROLE_SYSTEM_DELETE_MESSAGE = "Systemrollen können nicht gelöscht werden.";
const ROLE_ASSIGNED_DELETE_MESSAGE =
  "Die Rolle ist noch Nutzern zugewiesen und kann nicht gelöscht werden.";
/** The `onDelete: Restrict` backstop of D-21 (migration 20260924145050_role_assignment). */
const ROLE_ASSIGNMENT_ROLE_FOREIGN_KEY = "RoleAssignment_accessRoleId_fkey";
// Issue #354 (pre-merge security review of #75): a `role:manage` holder who also currently holds
// the target role via an assignment could otherwise add rights to it and grant itself more —
// self-service escalation. Rejected unless the caller additionally holds role-assignment:manage.
const ROLE_SELF_HELD_UPDATE_MESSAGE =
  "Eine Ihnen selbst zugewiesene Rolle können Sie ohne die Berechtigung role-assignment:manage nicht ändern.";
// Phase 78b (issue #78, D-05): the fixed 409 reply for a save that would newly create the
// four-eyes combination without confirm: true — same `{ error, code }` shape as
// SALON_ALREADY_COUPLED_REPLY (contexts/scheduling/api/integrations.ts).
const FOUR_EYES_CONFIRMATION_REPLY = {
  error: FOUR_EYES_CONFIRMATION_MESSAGE,
  code: FOUR_EYES_CONFIRMATION_REQUIRED,
};

const nameSchema = z.string().trim().min(1).max(ROLE_NAME_MAX_LENGTH);

const permissionsSchema = z.array(z.string()).superRefine((keys, ctx) => {
  for (const key of unknownPermissionKeys(keys)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unbekannte Permission: ${key}`,
      path: [keys.indexOf(key)],
    });
  }
});

const createRoleSchema = z.object({
  name: nameSchema,
  permissions: permissionsSchema,
  // Phase 78b (issue #78, D-05): explicit confirmation of a combination-creating save. `.nullish()`
  // matches this file's own idiom — a frontend sends explicit `null` as much as it omits the key.
  confirm: z.boolean().nullish(),
});

// D-08: plain `z.string().min(1)`, NOT `.uuid()` — both T-100-09 probe arms (a real foreign id
// and a shaped-but-nonexistent id) must pass the same validation, or a stricter schema would
// answer the two arms differently for a reason unrelated to tenant isolation.
const idParamSchema = z.object({ id: z.string().min(1) });

// `.nullish()` on both fields: a frontend sends explicit `null` for "unchanged" as much as it
// omits the key, and `{}` (every field absent) must still parse — the T-100-09 probe's PATCH
// `minimalBody` relies on this to reach the tenant guard.
const updateRoleSchema = z.object({
  name: nameSchema.nullish(),
  permissions: permissionsSchema.nullish(),
  // Phase 78b (issue #78, D-05): explicit confirmation of a combination-creating save.
  confirm: z.boolean().nullish(),
});

// `.nullish()` on `name`: the route parses `req.body ?? {}`, so a bodyless copy still parses, and
// the T-100-09 probe's `minimalBody: {}` reaches the tenant guard before anything is created.
const copyRoleSchema = z.object({
  name: nameSchema.nullish(),
  // Phase 78b (issue #78, D-05): a copy is a new creation (D-04) — its own confirmation.
  confirm: z.boolean().nullish(),
});

/** Bound on the generated-name retry loop (D-06/D-07) — never actually reached in practice. */
const COPY_NAME_ATTEMPT_LIMIT = 1000;

interface AccessRoleRow {
  id: string;
  tenantId: string | null;
  name: string;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Maps a stored row onto the public response shape — `isSystem` is derived, never stored. */
function toRoleResponse(source: AccessRoleRow) {
  return {
    id: source.id,
    name: source.name,
    permissions: source.permissions,
    isSystem: source.tenantId === null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

/**
 * True when `nameKey` is already used by the tenant's own customer roles (excluding `excludeId`,
 * for a future rename) or by any system role (D-06). Two lookups, not one combined query, so a
 * copy-and-adapt of this shape for a future `:id` route stays simple.
 */
async function nameTaken(
  db: Prisma.TransactionClient,
  tenantId: string,
  nameKey: string,
  excludeId: string | null,
): Promise<boolean> {
  const ownMatch = await db.accessRole.findFirst({
    where: {
      tenantId,
      nameKey,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
  if (ownMatch) return true;

  const systemMatch = await db.accessRole.findFirst({
    where: { tenantId: null, nameKey },
  });
  return systemMatch !== null;
}

/** Source: apps/api/src/contexts/absence/api/leave.ts:150-155 (structural P2002 check idiom). */
function isPrismaErrorCode(err: unknown, code: string): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

export async function roleRoutes(app: FastifyInstance) {
  // GET /api/v1/roles — every system role plus the caller's own customer roles (AK-73-3).
  app.get("/", {
    schema: {
      tags: ["Rollen"],
      security: [{ bearerAuth: [] }],
      summary: "List roles",
      description:
        "Returns every system role (global, no tenant) plus the customer roles owned by the caller's own tenant. System roles are listed first, then customer roles, both alphabetically by name.",
    },
    preHandler: requirePermission("role:read:ZUGEWIESEN"),
    handler: async (req) => {
      const rows = await app.prisma.accessRole.findMany({
        where: { OR: [{ tenantId: null }, { tenantId: req.user.tenantId }] },
      });
      const sorted = [...rows].sort((a, b) => {
        const aSystem = a.tenantId === null;
        const bSystem = b.tenantId === null;
        if (aSystem !== bSystem) return aSystem ? -1 : 1;
        return a.nameKey.localeCompare(b.nameKey);
      });
      return sorted.map(toRoleResponse);
    },
  });

  // POST /api/v1/roles — create a customer role for the caller's own tenant (AK-73-1/AK-73-2).
  app.post("/", {
    schema: {
      tags: ["Rollen"],
      security: [{ bearerAuth: [] }],
      summary: "Create a customer role",
      description:
        "Creates a customer role of the caller's own tenant from a name and a set of catalog permission keys. Unknown permission keys are rejected with 400; a name that collides case-insensitively with an existing role of the same tenant, or with any system role, is rejected with 409. A permission set that newly combines changing one's own time entries with approving time corrections (the four-eyes combination, issue #78) answers 409 FOUR_EYES_CONFIRMATION_REQUIRED unless the body carries confirm: true; the confirmation is then recorded in the CREATE audit entry.",
    },
    preHandler: requirePermission("role:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const body = createRoleSchema.parse(req.body);
      const tenantId = req.user.tenantId;
      const permissions = normalizeRolePermissions(body.permissions);
      const nameKey = roleNameKey(body.name);
      // D-04: a create has no previous state — "before" is always empty.
      const createsCombination = createsFourEyesCombination([], permissions);

      try {
        const created = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          if (await nameTaken(tx, tenantId, nameKey, null)) {
            return null;
          }
          // Pitfall 1: run this LAST, after the name-conflict check, so a request that fails both
          // answers 409 name-conflict (existing precedence wins, D-06).
          if (createsCombination && body.confirm !== true) {
            throw new FourEyesConfirmationRequiredError();
          }
          const source = await tx.accessRole.create({
            data: { tenantId, name: body.name, nameKey, permissions },
          });
          await app.audit({
            tx,
            action: "CREATE",
            entity: "AccessRole",
            entityId: source.id,
            ...requestAuditFields(req, {
              name: source.name,
              permissions: source.permissions,
              tenantId: source.tenantId,
              // Gated on the computed transition, never on body.confirm alone (Pitfall 2).
              ...(createsCombination ? { fourEyesWarningConfirmed: true } : {}),
            }),
          });
          return source;
        });

        if (!created) {
          return reply.code(409).send({ error: ROLE_NAME_CONFLICT_MESSAGE });
        }
        return reply.code(201).send(toRoleResponse(created));
      } catch (err: unknown) {
        if (err instanceof FourEyesConfirmationRequiredError) {
          return reply.code(409).send(FOUR_EYES_CONFIRMATION_REPLY);
        }
        if (isPrismaErrorCode(err, "P2002")) {
          return reply.code(409).send({ error: ROLE_NAME_CONFLICT_MESSAGE });
        }
        throw err;
      }
    },
  });

  // GET /api/v1/roles/:id — a system role or the caller's own customer role (AK-73-2). Never a
  // shared loader with PATCH/DELETE: the tenant-scoping gate only credits a fetch that sits in
  // the same function scope as the later write it authorises (RESEARCH.md Pitfall 1).
  app.get("/:id", {
    schema: {
      tags: ["Rollen"],
      security: [{ bearerAuth: [] }],
      summary: "Read a single role",
      description:
        "Returns a system role (readable by every tenant) or a customer role of the caller's own tenant. A foreign tenant's customer role and a nonexistent id both answer 404 with the same body (T-100-09).",
    },
    preHandler: requirePermission("role:read:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const existing = await app.prisma.accessRole.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
      }
      if (existing.tenantId !== null) {
        if (existing.tenantId !== req.user.tenantId) {
          return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
        }
      }
      return toRoleResponse(existing);
    },
  });

  // PATCH /api/v1/roles/:id — change an own customer role's name and/or permissions
  // (AK-73-2/AK-73-10); a system role answers 409 with no write and no audit (AK-73-4).
  app.patch("/:id", {
    schema: {
      tags: ["Rollen"],
      security: [{ bearerAuth: [] }],
      summary: "Update a customer role",
      description:
        "Changes name and/or permissions of a customer role of the caller's own tenant. A no-op request (nothing actually changes) writes nothing and audits nothing. A system role is never changeable and answers 409. A change that would remove the last tenant-wide holder of role:manage or role-assignment:manage answers 409 and changes nothing (lockout protection). A role the caller currently holds via any own assignment answers 403 unless the caller also holds role-assignment:manage (self-service escalation, issue #354). A permission change that newly combines changing one's own time entries with approving time corrections (the four-eyes combination, issue #78) answers 409 FOUR_EYES_CONFIRMATION_REQUIRED unless the body carries confirm: true, checked after the lockout guard so a change that also causes a lockout answers the lockout 409 instead; the confirmation is then recorded in the UPDATE audit entry. A foreign tenant's customer role and a nonexistent id both answer 404 with the same body (T-100-09).",
    },
    preHandler: requirePermission("role:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      // Parsed BEFORE the lookup (house convention) so an empty body `{}` still reaches the
      // tenant guard below — every field here is nullish, so `{}` always parses.
      const body = updateRoleSchema.parse(req.body);

      const existing = await app.prisma.accessRole.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
      }
      if (existing.tenantId !== null) {
        if (existing.tenantId !== req.user.tenantId) {
          return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
        }
      }
      if (existing.tenantId === null) {
        return reply.code(409).send({ error: ROLE_SYSTEM_UPDATE_MESSAGE });
      }

      // Issue #354 (pre-merge security review of #75): a `role:manage` holder who is themselves
      // assigned this role could edit it to add rights and grant themselves more — checked on
      // ANY literal assignment (even a malformed one), not only an EFFECTIVE one, and before the
      // no-op diff below so an attempted change is refused regardless of whether it would net out
      // to nothing.
      const selfAssignment = await app.prisma.roleAssignment.findFirst({
        where: { userId: req.user.sub, accessRoleId: id, tenantId: req.user.tenantId },
      });
      if (
        selfAssignment !== null &&
        !(await hasPermission(req, "role-assignment:manage:ZUGEWIESEN"))
      ) {
        return reply.code(403).send({ error: ROLE_SELF_HELD_UPDATE_MESSAGE });
      }

      const nextName = body.name ?? existing.name;
      const nextPermissions =
        body.permissions != null
          ? normalizeRolePermissions(body.permissions)
          : existing.permissions;

      const permissionsUnchanged =
        nextPermissions.length === existing.permissions.length &&
        nextPermissions.every((p, i) => p === existing.permissions[i]);
      if (nextName === existing.name && permissionsUnchanged) {
        // A no-op is not a change (D-CONTEXT PATCH note): nothing to write, nothing to audit. A
        // no-op can never create the combination, so this early return needs no four-eyes check.
        return toRoleResponse(existing);
      }

      // D-04: PATCH's "before" is the stored permissions prior to this change.
      const createsCombination = createsFourEyesCombination(existing.permissions, nextPermissions);

      const nextNameKey = roleNameKey(nextName);

      try {
        const updated = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          if (nextName !== existing.name) {
            if (await nameTaken(tx, req.user.tenantId, nextNameKey, existing.id)) {
              return null;
            }
          }
          // D-19/D-20: removing a guarded permission from a customer role can remove the last
          // tenant-wide holder. The guard runs on EVERY update (it can only fire on a >= 1 -> 0
          // transition), so no per-trigger "which permissions were removed" logic can drift. The
          // update and its audit run on the transaction client; RoleLockoutError rolls both back.
          const row = await withRoleLockoutGuard(tx, req.user.tenantId, async () => {
            const updatedRow = await tx.accessRole.update({
              where: { id },
              data: { name: nextName, nameKey: nextNameKey, permissions: nextPermissions },
            });
            await app.audit({
              tx,
              action: "UPDATE",
              entity: "AccessRole",
              entityId: updatedRow.id,
              oldValue: { name: existing.name, permissions: existing.permissions },
              ...requestAuditFields(req, {
                name: updatedRow.name,
                permissions: updatedRow.permissions,
                // Gated on the computed transition, never on body.confirm alone (Pitfall 2).
                ...(createsCombination ? { fourEyesWarningConfirmed: true } : {}),
              }),
            });
            return updatedRow;
          });
          // P-01: checked AFTER withRoleLockoutGuard returns, still inside this same transaction —
          // a change that ALSO causes a lockout answers the lockout 409 instead (the lockout guard
          // can only decide after the write; D-06 says the four-eyes 409 is only for an otherwise-
          // valid request). The row is already updated and audited at this point; throwing here
          // rolls back both.
          if (createsCombination && body.confirm !== true) {
            throw new FourEyesConfirmationRequiredError();
          }
          return row;
        });

        if (!updated) {
          return reply.code(409).send({ error: ROLE_NAME_CONFLICT_MESSAGE });
        }
        return toRoleResponse(updated);
      } catch (err: unknown) {
        if (err instanceof RoleLockoutError) {
          return reply.code(409).send({ error: ROLE_LOCKOUT_MESSAGE });
        }
        if (err instanceof FourEyesConfirmationRequiredError) {
          return reply.code(409).send(FOUR_EYES_CONFIRMATION_REPLY);
        }
        if (isPrismaErrorCode(err, "P2002")) {
          return reply.code(409).send({ error: ROLE_NAME_CONFLICT_MESSAGE });
        }
        if (isPrismaErrorCode(err, "P2025")) {
          return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
        }
        throw err;
      }
    },
  });

  // DELETE /api/v1/roles/:id — hard-deletes an own customer role (AK-73-2/AK-73-10); a system
  // role answers 409 with no write and no audit (AK-73-5); so does a customer role that is still
  // assigned (Phase 74b, D-21).
  app.delete("/:id", {
    schema: {
      tags: ["Rollen"],
      security: [{ bearerAuth: [] }],
      summary: "Delete a customer role",
      description:
        "Hard-deletes a customer role of the caller's own tenant (owner decision on #73 — not a retention-relevant record). A system role is never deletable and answers 409. A customer role that is still assigned to a user answers 409 and is not deleted. A foreign tenant's customer role and a nonexistent id both answer 404 with the same body (T-100-09).",
    },
    preHandler: requirePermission("role:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const existing = await app.prisma.accessRole.findUnique({ where: { id } });
      if (!existing) {
        return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
      }
      if (existing.tenantId !== null) {
        if (existing.tenantId !== req.user.tenantId) {
          return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
        }
      }
      if (existing.tenantId === null) {
        return reply.code(409).send({ error: ROLE_SYSTEM_DELETE_MESSAGE });
      }

      try {
        const outcome = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          // D-21: an assigned role cannot be deleted. Checked only AFTER the tenant guard and the
          // system-role 409 above — before the tenant guard it would answer a foreign tenant's
          // assigned role differently from an unknown id (a T-100-09 oracle). The
          // `onDelete: Restrict` foreign key on RoleAssignment.accessRoleId is the backstop for an
          // assignment created concurrently after this count (P2003, mapped below).
          const assignedCount = await tx.roleAssignment.count({
            where: { accessRoleId: id, tenantId: req.user.tenantId },
          });
          if (assignedCount > 0) return "ASSIGNED" as const;

          await tx.accessRole.delete({ where: { id } });
          await app.audit({
            tx,
            action: "DELETE",
            entity: "AccessRole",
            entityId: existing.id,
            oldValue: {
              name: existing.name,
              permissions: existing.permissions,
              tenantId: existing.tenantId,
            },
            ...requestAuditFields(req),
          });
          return "DELETED" as const;
        });
        if (outcome === "ASSIGNED") {
          return reply.code(409).send({ error: ROLE_ASSIGNED_DELETE_MESSAGE });
        }
        return reply.code(204).send();
      } catch (err: unknown) {
        // 74b review WR-03: only the RoleAssignment -> AccessRole foreign key means "still
        // assigned". Any other P2003 (before the actor fix: the audit insert's AuditLog.userId FK
        // for an API-key caller) is a real failure and must not be answered as a false 409.
        if (foreignKeyConstraintOf(err) === ROLE_ASSIGNMENT_ROLE_FOREIGN_KEY) {
          return reply.code(409).send({ error: ROLE_ASSIGNED_DELETE_MESSAGE });
        }
        if (isPrismaErrorCode(err, "P2025")) {
          return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
        }
        throw err;
      }
    },
  });

  // POST /api/v1/roles/:id/copy — the only way to adapt a system role (AK-73-6): copies a system
  // role or an own customer role into a NEW customer role of the caller's own tenant. The copy is
  // free-standing and freely editable from the moment it is created — it carries no reference back
  // to its source; the lineage lives only in the COPY audit entry (AK-73-10).
  app.post("/:id/copy", {
    schema: {
      tags: ["Rollen"],
      security: [{ bearerAuth: [] }],
      summary: "Copy a role into an own customer role",
      description:
        "Creates a customer role of the caller's own tenant with the same permissions as a system role or an own customer role. Without an explicit name, one is generated from the source name: '<Quelle> (Kopie)', then '(Kopie 2)', '(Kopie 3)' … An explicit name that collides is rejected with 409, same as create. A copy is treated as a new creation (issue #78, D-04): a source that holds the four-eyes combination (changing one's own time entries plus approving time corrections) answers 409 FOUR_EYES_CONFIRMATION_REQUIRED unless the body carries confirm: true, regardless of whether the source's own confirmation was already recorded; the confirmation is then recorded in the COPY audit entry. A foreign tenant's customer role and a nonexistent id both answer 404 with the same body (T-100-09).",
    },
    preHandler: requirePermission("role:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      // Parsed BEFORE the lookup (house convention) so a bodyless copy `{}` still reaches the
      // tenant guard below — every field here is nullish, and `req.body ?? {}` covers no body at
      // all (the T-100-09 probe's `minimalBody` for this route).
      const body = copyRoleSchema.parse(req.body ?? {});

      const source = await app.prisma.accessRole.findUnique({ where: { id } });
      if (!source) {
        return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
      }
      if (source.tenantId !== null) {
        if (source.tenantId !== req.user.tenantId) {
          return reply.code(404).send({ error: ROLE_NOT_FOUND_MESSAGE });
        }
      }
      // A system role AND an own customer role are both valid sources — one code path, no branch
      // on the kind of source (D-07); the guard above already rejected a foreign customer role.

      const tenantId = req.user.tenantId;
      const permissions = normalizeRolePermissions(source.permissions);
      // D-04: a copy is a new creation — "before" is always empty, regardless of whether the
      // source itself already holds the combination (with or without a recorded confirmation).
      const createsCombination = createsFourEyesCombination([], permissions);

      try {
        const created = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          let name: string;
          let nameKey: string;

          if (body.name != null) {
            name = body.name;
            nameKey = roleNameKey(name);
            if (await nameTaken(tx, tenantId, nameKey, null)) {
              return null;
            }
          } else {
            let attempt = 1;
            let generatedName = copyRoleName(source.name, attempt);
            let generatedNameKey = roleNameKey(generatedName);
            while (await nameTaken(tx, tenantId, generatedNameKey, null)) {
              attempt++;
              if (attempt > COPY_NAME_ATTEMPT_LIMIT) {
                return null;
              }
              generatedName = copyRoleName(source.name, attempt);
              generatedNameKey = roleNameKey(generatedName);
            }
            name = generatedName;
            nameKey = generatedNameKey;
          }

          // Pitfall 1: run this LAST, after the name resolution above, so a request that fails
          // both answers 409 name-conflict (existing precedence wins, D-06).
          if (createsCombination && body.confirm !== true) {
            throw new FourEyesConfirmationRequiredError();
          }

          const row = await tx.accessRole.create({
            data: { tenantId, name, nameKey, permissions },
          });
          await app.audit({
            tx,
            action: "COPY",
            entity: "AccessRole",
            entityId: row.id,
            ...requestAuditFields(req, {
              name: row.name,
              permissions: row.permissions,
              tenantId: row.tenantId,
              copiedFromId: source.id,
              copiedFromName: source.name,
              // Gated on the computed transition, never on body.confirm alone (Pitfall 2).
              ...(createsCombination ? { fourEyesWarningConfirmed: true } : {}),
            }),
          });
          return row;
        });

        if (!created) {
          return reply.code(409).send({ error: ROLE_NAME_CONFLICT_MESSAGE });
        }
        return reply.code(201).send(toRoleResponse(created));
      } catch (err: unknown) {
        if (err instanceof FourEyesConfirmationRequiredError) {
          return reply.code(409).send(FOUR_EYES_CONFIRMATION_REPLY);
        }
        if (isPrismaErrorCode(err, "P2002")) {
          return reply.code(409).send({ error: ROLE_NAME_CONFLICT_MESSAGE });
        }
        throw err;
      }
    },
  });
}
