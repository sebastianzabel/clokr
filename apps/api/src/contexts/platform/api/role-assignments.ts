/**
 * Phase 74b Plan 02 (Issue #74) — the maintenance API of role assignments, prefix
 * `/api/v1/role-assignments`.
 *
 * Grants, changes and revokes a `RoleAssignment` (74b-01: model, pure core, `userMayApply`
 * facade). Every route is guarded by `role-assignment:manage:ZUGEWIESEN` (75b-06); tenant-scope
 * enforcement of that permission (a TENANT-scope holder vs. a SALONS/PERSONS one) is Issue #91's
 * work, not this plan's. (Never write the guard call's name directly followed by its opening
 * parenthesis in this docblock — this plan's verify step greps raw source lines to count guard
 * call sites, and a comment mention would inflate that count.)
 *
 * Revoke is an audited hard delete (D-05) — `RoleAssignment` carries no `deletedAt`, history lives
 * in the AuditLog. Every id referenced by a write (user, role, salon, employee) is tenant-validated
 * and answers the byte-identical 404 of its own kind (D-08) — the four "not found" messages below
 * are the entire vocabulary; a caller cannot distinguish "foreign tenant" from "does not exist".
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Prisma } from "@clokr/db";
import { requirePermission } from "../request-permissions";
import { accessContextFromRequest } from "../access-context";
import { NOT_ANONYMIZED_EMPLOYEE_WHERE } from "../employee-anonymization-filter";
import {
  ROLE_LOCKOUT_MESSAGE,
  RoleLockoutError,
  normalizeRoleAssignmentScope,
  roleAssignmentScopeOf,
  type NormalizedRoleAssignmentScope,
} from "../role-assignment";
import { lockTenantForRoleChanges, withRoleLockoutGuard } from "../facade/role-assignments";
import { foreignKeyConstraintOf } from "../prisma-foreign-key";

// D-09: plain `z.string().min(1)`, NOT `.uuid()` — both T-100-09 probe arms (a real foreign id and
// a shaped-but-nonexistent id) must pass the same validation, same idiom as `roles.ts`'s
// `idParamSchema`.
const idSchema = z.string().min(1);

const idParamSchema = z.object({ id: idSchema });

// `.strict()` on every variant: an extra field (e.g. `{ type: "TENANT", salonIds: [...] }`) is a
// mixed shape and must be rejected with 400, never silently dropped (D-03/D-09).
const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TENANT") }).strict(),
  z
    .object({
      type: z.literal("SALONS"),
      salonIds: z.array(idSchema).min(1, "Ein Salon-Scope braucht mindestens einen Salon."),
    })
    .strict(),
  z
    .object({
      type: z.literal("PERSONS"),
      employeeIds: z
        .array(idSchema)
        .min(1, "Ein Personen-Scope braucht mindestens einen Mitarbeiter."),
    })
    .strict(),
]);

const createAssignmentSchema = z.object({
  userId: idSchema,
  accessRoleId: idSchema,
  scope: scopeSchema,
});

// `.nullish()` on both fields (roles.ts idiom): a frontend sends explicit `null` for "unchanged" as
// much as it omits the key, and `{}` (every field absent) must still parse — the T-100-09 probe's
// PATCH `minimalBody` relies on this to reach the tenant guard. `userId` is deliberately absent —
// it is not changeable (D-07); `.strict()` turns a body carrying it into a 400 (T-74b-13).
const updateAssignmentSchema = z
  .object({
    accessRoleId: idSchema.nullish(),
    scope: scopeSchema.nullish(),
  })
  .strict();

const listQuerySchema = z.object({ userId: idSchema.optional() });

const USER_NOT_FOUND = "Nutzer nicht gefunden";
const ROLE_NOT_FOUND = "Rolle nicht gefunden";
const SALON_NOT_FOUND = "Salon nicht gefunden";
const EMPLOYEE_NOT_FOUND = "Mitarbeiter nicht gefunden";
const ASSIGNMENT_NOT_FOUND = "Rollenzuweisung nicht gefunden";
const DUPLICATE_ASSIGNMENT_MESSAGE =
  "Diese Rolle ist dem Nutzer mit diesem Scope-Typ bereits zugewiesen.";

/** The RoleAssignment foreign keys a racing delete can violate on insert (migration 20260924145050). */
const ACCESS_ROLE_FOREIGN_KEY = "RoleAssignment_accessRoleId_fkey";
const USER_FOREIGN_KEY = "RoleAssignment_userId_fkey";

interface AccessRoleRow {
  id: string;
  name: string;
  tenantId: string | null;
}

interface RoleAssignmentRow {
  id: string;
  userId: string;
  accessRoleId: string;
  scopeType: NormalizedRoleAssignmentScope["scopeType"];
  salonIds: string[];
  employeeIds: string[];
  createdAt: Date;
  updatedAt: Date;
  accessRole: AccessRoleRow;
}

/** Maps a stored row (with its `accessRole` included) onto the public response shape. */
function toRoleAssignmentResponse(row: RoleAssignmentRow) {
  return {
    id: row.id,
    userId: row.userId,
    accessRoleId: row.accessRoleId,
    roleName: row.accessRole.name,
    isSystemRole: row.accessRole.tenantId === null,
    scope: roleAssignmentScopeOf(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** D-12: the exact audit value shape for every CREATE/UPDATE/DELETE on `RoleAssignment`. */
function toAuditValue(
  row: {
    userId: string;
    accessRoleId: string;
    scopeType: NormalizedRoleAssignmentScope["scopeType"];
    salonIds: string[];
    employeeIds: string[];
  },
  roleName: string,
) {
  return {
    userId: row.userId,
    accessRoleId: row.accessRoleId,
    roleName,
    scopeType: row.scopeType,
    salonIds: row.salonIds,
    employeeIds: row.employeeIds,
  };
}

/** Source: apps/api/src/contexts/platform/api/roles.ts (structural P2002/P2025 check idiom). */
function isPrismaErrorCode(err: unknown, code: string): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

/**
 * Every RoleAssignment audit row goes through here (same reasoning as `salons.ts`'s `auditSalon`,
 * Phase 64b review WR-01): an API-key caller's `req.user.sub` is `apikey:<id>`, not a `User.id` —
 * `AuditLog.userId` has a foreign key to `User`, so passing it through would fail the audit insert.
 * The actor is resolved through the Unterbau's central access context (`accessContextFromRequest`,
 * #77) instead of parsing the subject here; a non-user actor leaves `userId` unset and is recorded
 * as `newValue.actor = { type: "API_KEY", apiKeyId }`.
 */
async function auditRoleAssignment(
  app: FastifyInstance,
  req: FastifyRequest,
  entry: {
    action: string;
    entityId: string;
    oldValue?: unknown;
    newValue?: object;
    tx?: Prisma.TransactionClient;
  },
) {
  const { actor } = accessContextFromRequest(req);
  const apiKeyActor =
    actor.kind === "apiKey" ? { type: "API_KEY" as const, apiKeyId: actor.apiKeyId } : null;

  let newValue: object | undefined = entry.newValue;
  if (apiKeyActor) newValue = { ...(entry.newValue ?? {}), actor: apiKeyActor };

  await app.audit({
    userId: actor.kind === "user" ? actor.userId : undefined,
    action: entry.action,
    entity: "RoleAssignment",
    entityId: entry.entityId,
    oldValue: entry.oldValue,
    newValue,
    request: { ip: req.ip, headers: req.headers as Record<string, string> },
    tx: entry.tx,
  });
}

/** What the POST transaction decided — mapped onto the reply outside the transaction. */
type CreateOutcome =
  | { kind: "REFERENCE_NOT_FOUND"; resolution: ReferenceResolution }
  | { kind: "DUPLICATE" }
  | { kind: "CREATED"; row: RoleAssignmentRow };

/** What the guarded PATCH transaction decided — mapped onto the reply outside the transaction. */
type PatchOutcome =
  | { kind: "NOT_FOUND" }
  | { kind: "REFERENCE_NOT_FOUND"; resolution: ReferenceResolution }
  | { kind: "DUPLICATE" }
  | { kind: "UNCHANGED"; row: RoleAssignmentRow }
  | { kind: "UPDATED"; row: RoleAssignmentRow };

type ReferenceResolution =
  | { status: "OK"; accessRole: AccessRoleRow }
  | { status: "USER_NOT_FOUND" }
  | { status: "ROLE_NOT_FOUND" }
  | { status: "SALON_NOT_FOUND" }
  | { status: "EMPLOYEE_NOT_FOUND" };

/**
 * D-08: resolves every id referenced by a write against the caller's own tenant, in order, and
 * only for the refs given (`userId` is only checked on create — PATCH never changes it, D-07;
 * `scope` is omitted by a PATCH that leaves the scope untouched, so a stored scope that was valid
 * when written — e.g. a person list whose employee was anonymized since — does not block a role
 * change). One query per kind answers ALL of that kind's "not found" cases alike (unknown id,
 * foreign tenant, an anonymized target) — the whole point of D-08's byte-identical 404s.
 */
async function resolveAssignmentReferences(
  db: Prisma.TransactionClient,
  tenantId: string,
  refs: { userId?: string; accessRoleId: string; scope?: NormalizedRoleAssignmentScope },
): Promise<ReferenceResolution> {
  if (refs.userId !== undefined) {
    const user = await db.user.findFirst({
      where: { id: refs.userId, employee: { tenantId, ...NOT_ANONYMIZED_EMPLOYEE_WHERE } },
    });
    if (!user) return { status: "USER_NOT_FOUND" };
  }

  // roles.ts's nested-tenant-guard idiom — AccessRole.tenantId is nullable (a system role is
  // assignable, tenantId null); combining the two `if`s into one `&&` is the shape
  // `lint:tenant-scoping` does not accept for a nullable-tenant model (roles.ts precedent).
  const accessRole = await db.accessRole.findUnique({ where: { id: refs.accessRoleId } });
  if (!accessRole) return { status: "ROLE_NOT_FOUND" };
  if (accessRole.tenantId !== null) {
    if (accessRole.tenantId !== tenantId) {
      return { status: "ROLE_NOT_FOUND" };
    }
  }

  if (refs.scope?.scopeType === "SALONS") {
    const found = await db.salon.findMany({
      where: { id: { in: refs.scope.salonIds }, tenantId },
      select: { id: true },
    });
    if (found.length !== refs.scope.salonIds.length) return { status: "SALON_NOT_FOUND" };
  }

  if (refs.scope?.scopeType === "PERSONS") {
    const found = await db.employee.findMany({
      where: { id: { in: refs.scope.employeeIds }, tenantId, ...NOT_ANONYMIZED_EMPLOYEE_WHERE },
      select: { id: true },
    });
    if (found.length !== refs.scope.employeeIds.length) return { status: "EMPLOYEE_NOT_FOUND" };
  }

  return { status: "OK", accessRole };
}

/** Maps a {@link ReferenceResolution} 404 status onto its reply — never reached for `"OK"`. */
function sendReferenceNotFound(reply: FastifyReply, resolution: ReferenceResolution) {
  const messages: Record<string, string> = {
    USER_NOT_FOUND,
    ROLE_NOT_FOUND,
    SALON_NOT_FOUND,
    EMPLOYEE_NOT_FOUND,
  };
  return reply.code(404).send({ error: messages[resolution.status] });
}

export async function roleAssignmentRoutes(app: FastifyInstance) {
  // GET /api/v1/role-assignments — the tenant's assignments, optional `?userId=` filter (D-07).
  app.get("/", {
    schema: {
      tags: ["Rollenzuweisungen"],
      security: [{ bearerAuth: [] }],
      summary: "List the caller's tenant's role assignments",
      description:
        "Returns every role assignment of the caller's own tenant, ordered by creation time. An optional `?userId=` filters to that user's assignments.",
    },
    preHandler: requirePermission("role-assignment:manage:ZUGEWIESEN"),
    handler: async (req) => {
      const { userId } = listQuerySchema.parse(req.query);
      const tenantId = req.user.tenantId;
      const rows = await app.prisma.roleAssignment.findMany({
        where: { tenantId, ...(userId !== undefined ? { userId } : {}) },
        include: { accessRole: true },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toRoleAssignmentResponse);
    },
  });

  // POST /api/v1/role-assignments — grant a role with a scope (D-03/D-04/D-08/D-09/D-12).
  app.post("/", {
    schema: {
      tags: ["Rollenzuweisungen"],
      security: [{ bearerAuth: [] }],
      summary: "Grant a role with a scope",
      description:
        "Assigns an access role (system or customer) to a user of the caller's own tenant, with exactly one scope: the whole tenant, an explicit salon list, or an explicit employee list. Every referenced id is validated against the caller's own tenant; a foreign or nonexistent id answers 404, one message per kind, byte-identical between the two cases (T-100-09). A duplicate (same user, role and scope type) answers 409.",
    },
    preHandler: requirePermission("role-assignment:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const body = createAssignmentSchema.parse(req.body);
      const tenantId = req.user.tenantId;
      const scope = normalizeRoleAssignmentScope(body.scope);

      try {
        // 74b review WR-02: the reference checks and the insert run in ONE transaction that first
        // takes the tenant row lock every guarded role change takes (lockTenantForRoleChanges,
        // also the first statement of withRoleLockoutGuard). Anonymizing the grantee holds that
        // lock too, so the "user not anonymized" check can no longer pass before an anonymization
        // commits and the insert land after it (D-22: an anonymized person holds no rights). The
        // checks read on `tx` after the lock, i.e. what the previous lock holder committed.
        const outcome = await app.prisma.$transaction(
          async (tx: Prisma.TransactionClient): Promise<CreateOutcome> => {
            await lockTenantForRoleChanges(tx, tenantId);

            const resolution = await resolveAssignmentReferences(tx, tenantId, {
              userId: body.userId,
              accessRoleId: body.accessRoleId,
              scope,
            });
            if (resolution.status !== "OK") return { kind: "REFERENCE_NOT_FOUND", resolution };

            const duplicate = await tx.roleAssignment.findFirst({
              where: {
                tenantId,
                userId: body.userId,
                accessRoleId: body.accessRoleId,
                scopeType: scope.scopeType,
              },
            });
            if (duplicate) return { kind: "DUPLICATE" };

            const row = await tx.roleAssignment.create({
              data: {
                tenantId,
                userId: body.userId,
                accessRoleId: body.accessRoleId,
                scopeType: scope.scopeType,
                salonIds: scope.salonIds,
                employeeIds: scope.employeeIds,
              },
              include: { accessRole: true },
            });
            await auditRoleAssignment(app, req, {
              action: "CREATE",
              entityId: row.id,
              newValue: toAuditValue(row, resolution.accessRole.name),
              tx,
            });
            return { kind: "CREATED", row };
          },
        );

        switch (outcome.kind) {
          case "REFERENCE_NOT_FOUND":
            return sendReferenceNotFound(reply, outcome.resolution);
          case "DUPLICATE":
            return reply.code(409).send({ error: DUPLICATE_ASSIGNMENT_MESSAGE });
          case "CREATED":
            return reply.code(201).send(toRoleAssignmentResponse(outcome.row));
        }
      } catch (err: unknown) {
        if (isPrismaErrorCode(err, "P2002")) {
          return reply.code(409).send({ error: DUPLICATE_ASSIGNMENT_MESSAGE });
        }
        // 74b review WR-02: a referenced row that vanished between the check and the insert. A
        // customer role delete does not take the tenant lock, so its foreign key is the backstop
        // here; it answers the same 404 as a role that was never there. Any other P2003 (e.g. the
        // audit insert's) is not a missing reference and is rethrown.
        const constraint = foreignKeyConstraintOf(err);
        if (constraint === ACCESS_ROLE_FOREIGN_KEY) {
          return reply.code(404).send({ error: ROLE_NOT_FOUND });
        }
        if (constraint === USER_FOREIGN_KEY) {
          return reply.code(404).send({ error: USER_NOT_FOUND });
        }
        throw err;
      }
    },
  });

  // GET /api/v1/role-assignments/:id — a single assignment of the caller's own tenant. Pattern 1
  // (RESEARCH.md): RoleAssignment.tenantId is NEVER null, so the simple inline `{ id, tenantId }`
  // shape applies directly — not roles.ts's nested-if, which exists only for AccessRole's nullable
  // tenant. A foreign tenant's real assignment and a nonexistent id both answer 404 identically
  // (T-100-09, D-11) because the scoped query itself cannot distinguish them.
  app.get("/:id", {
    schema: {
      tags: ["Rollenzuweisungen"],
      security: [{ bearerAuth: [] }],
      summary: "Read a single role assignment",
      description:
        "Returns one role assignment of the caller's own tenant. A foreign tenant's real assignment and a nonexistent id both answer 404 with the same body (T-100-09).",
    },
    preHandler: requirePermission("role-assignment:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;
      const existing = await app.prisma.roleAssignment.findFirst({
        where: { id, tenantId },
        include: { accessRole: true },
      });
      if (!existing) {
        return reply.code(404).send({ error: ASSIGNMENT_NOT_FOUND });
      }
      return toRoleAssignmentResponse(existing);
    },
  });

  // PATCH /api/v1/role-assignments/:id — change the role and/or scope of an assignment of the
  // caller's own tenant (D-07). `userId` is never changeable (revoke + create instead) — the
  // schema's `.strict()` turns a body carrying it into a 400 (T-74b-13). A no-op (nothing actually
  // changes) writes and audits nothing (D-07/D-12).
  app.patch("/:id", {
    schema: {
      tags: ["Rollenzuweisungen"],
      security: [{ bearerAuth: [] }],
      summary: "Change a role assignment's role and/or scope",
      description:
        "Changes the access role and/or scope of a role assignment of the caller's own tenant. `userId` is not changeable — revoke and create a new assignment instead. A no-op request writes nothing and audits nothing. A foreign tenant's real assignment and a nonexistent id both answer 404 with the same body (T-100-09). A change that would create a duplicate (same user, role and scope type) answers 409. A change that would remove the last tenant-wide holder of role:manage or role-assignment:manage (narrowing a TENANT scope or switching the role) answers 409 and changes nothing (lockout protection).",
    },
    preHandler: requirePermission("role-assignment:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      // Parsed BEFORE the lookup (roles.ts house convention) so an empty body `{}` still reaches
      // the tenant guard below — every field here is nullish, so `{}` always parses.
      const body = updateAssignmentSchema.parse(req.body ?? {});
      const tenantId = req.user.tenantId;
      const requestedScope =
        body.scope !== undefined && body.scope !== null
          ? normalizeRoleAssignmentScope(body.scope)
          : null;

      try {
        // 74b review WR-01: the assignment is read INSIDE the guarded transaction, after the
        // tenant row lock, and every decision (404, no-op, references, duplicate, audit
        // `oldValue`) is derived from that read. A snapshot read before the lock let a
        // concurrent PATCH's narrowing be silently reverted by a stale full-row write, and left
        // the audit chain with an `oldValue` that did not match the previous `newValue`. The lock
        // serialises every guarded writer in the tenant, so it covers PATCH-vs-PATCH on one row.
        // D-19/D-20: narrowing a TENANT scope or switching the role can remove the last
        // tenant-wide holder of a guarded permission; RoleLockoutError rolls update and audit back.
        const outcome = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) =>
          withRoleLockoutGuard(tx, tenantId, async (): Promise<PatchOutcome> => {
            const current = await tx.roleAssignment.findFirst({
              where: { id, tenantId },
              include: { accessRole: true },
            });
            // A foreign tenant's assignment and an unknown id both end here (T-100-09).
            if (!current) return { kind: "NOT_FOUND" };

            const nextAccessRoleId = body.accessRoleId ?? current.accessRoleId;
            const nextScope: NormalizedRoleAssignmentScope = requestedScope ?? {
              scopeType: current.scopeType,
              salonIds: current.salonIds,
              employeeIds: current.employeeIds,
            };

            const roleChanged = nextAccessRoleId !== current.accessRoleId;
            const scopeChanged =
              nextScope.scopeType !== current.scopeType ||
              nextScope.salonIds.length !== current.salonIds.length ||
              !nextScope.salonIds.every((v, i) => v === current.salonIds[i]) ||
              nextScope.employeeIds.length !== current.employeeIds.length ||
              !nextScope.employeeIds.every((v, i) => v === current.employeeIds[i]);

            if (!roleChanged && !scopeChanged) {
              // A no-op is not a change (D-07/D-12): nothing to write, nothing to audit.
              return { kind: "UNCHANGED", row: current };
            }

            // Resolve only the changed scope references — the same 404s as POST (D-08). The role
            // is always resolved because its name feeds the audit value; an unchanged role is the
            // stored one, which the AccessRole foreign key keeps resolvable.
            const resolution = await resolveAssignmentReferences(tx, tenantId, {
              accessRoleId: nextAccessRoleId,
              scope: scopeChanged ? nextScope : undefined,
            });
            if (resolution.status !== "OK") return { kind: "REFERENCE_NOT_FOUND", resolution };

            if (roleChanged || nextScope.scopeType !== current.scopeType) {
              const duplicate = await tx.roleAssignment.findFirst({
                where: {
                  tenantId,
                  userId: current.userId,
                  accessRoleId: nextAccessRoleId,
                  scopeType: nextScope.scopeType,
                  id: { not: id },
                },
              });
              if (duplicate) return { kind: "DUPLICATE" };
            }

            const row = await tx.roleAssignment.update({
              where: { id, tenantId },
              data: {
                accessRoleId: nextAccessRoleId,
                scopeType: nextScope.scopeType,
                salonIds: nextScope.salonIds,
                employeeIds: nextScope.employeeIds,
              },
              include: { accessRole: true },
            });
            await auditRoleAssignment(app, req, {
              action: "UPDATE",
              entityId: row.id,
              oldValue: toAuditValue(current, current.accessRole.name),
              newValue: toAuditValue(row, resolution.accessRole.name),
              tx,
            });
            return { kind: "UPDATED", row };
          }),
        );

        switch (outcome.kind) {
          case "NOT_FOUND":
            return reply.code(404).send({ error: ASSIGNMENT_NOT_FOUND });
          case "REFERENCE_NOT_FOUND":
            return sendReferenceNotFound(reply, outcome.resolution);
          case "DUPLICATE":
            return reply.code(409).send({ error: DUPLICATE_ASSIGNMENT_MESSAGE });
          case "UNCHANGED":
          case "UPDATED":
            return toRoleAssignmentResponse(outcome.row);
        }
      } catch (err: unknown) {
        if (err instanceof RoleLockoutError) {
          return reply.code(409).send({ error: ROLE_LOCKOUT_MESSAGE });
        }
        if (isPrismaErrorCode(err, "P2002")) {
          return reply.code(409).send({ error: DUPLICATE_ASSIGNMENT_MESSAGE });
        }
        if (isPrismaErrorCode(err, "P2025")) {
          return reply.code(404).send({ error: ASSIGNMENT_NOT_FOUND });
        }
        throw err;
      }
    },
  });

  // DELETE /api/v1/role-assignments/:id — revoke = audited hard delete (D-05). No `deletedAt` on
  // `RoleAssignment`; history lives entirely in the AuditLog.
  app.delete("/:id", {
    schema: {
      tags: ["Rollenzuweisungen"],
      security: [{ bearerAuth: [] }],
      summary: "Revoke a role assignment",
      description:
        "Hard-deletes a role assignment of the caller's own tenant, audited. A foreign tenant's real assignment and a nonexistent id both answer 404 with the same body (T-100-09). Revoking the last tenant-wide holder of role:manage or role-assignment:manage answers 409 and changes nothing (lockout protection).",
    },
    preHandler: requirePermission("role-assignment:manage:ZUGEWIESEN"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;

      try {
        // D-19/D-20: the delete and its audit run under the lockout guard, on the transaction
        // client. Revoking the last tenant-wide holder of a guarded permission throws
        // RoleLockoutError, which rolls back both. 74b review WR-01: the row is read inside the
        // guard, after the tenant lock, so the audit `oldValue` is the state actually deleted.
        // A foreign or unknown id writes nothing, so the guard cannot fire for it and both answer
        // the same 404 (T-100-09).
        const deleted = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) =>
          withRoleLockoutGuard(tx, tenantId, async () => {
            const current = await tx.roleAssignment.findFirst({
              where: { id, tenantId },
              include: { accessRole: true },
            });
            if (!current) return false;
            await tx.roleAssignment.delete({ where: { id, tenantId } });
            await auditRoleAssignment(app, req, {
              action: "DELETE",
              entityId: current.id,
              oldValue: toAuditValue(current, current.accessRole.name),
              tx,
            });
            return true;
          }),
        );
        if (!deleted) {
          return reply.code(404).send({ error: ASSIGNMENT_NOT_FOUND });
        }
        return reply.code(204).send();
      } catch (err: unknown) {
        if (err instanceof RoleLockoutError) {
          return reply.code(409).send({ error: ROLE_LOCKOUT_MESSAGE });
        }
        if (isPrismaErrorCode(err, "P2025")) {
          return reply.code(404).send({ error: ASSIGNMENT_NOT_FOUND });
        }
        throw err;
      }
    },
  });
}
