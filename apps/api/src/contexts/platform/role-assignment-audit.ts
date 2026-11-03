/**
 * Phase 75b (Issue #75) — the shared audit helpers for every `RoleAssignment` write.
 *
 * Moved unchanged out of `api/role-assignments.ts` (Phase 74b, D-12), because since 75b three
 * route files write role assignments: the maintenance API itself, the employee form's role bridge
 * (`api/employees.ts`, D-15) and the CSV import (`api/imports.ts`, D-15). Each of them must record
 * the same D-12 value shape with the same API-key-safe actor, so the helpers live here once
 * (`salon-assignment-audit.ts` is the sibling precedent from 67b). Not a generic extension point:
 * the remaining routes that audit `req.user.sub` directly are tracked in #333.
 *
 * `auditRoleAssignmentChange` (Phase 75b Plan 11) writes the rows of one assignment change in
 * order, nothing else (Issue #641: the stored assignments are the only place a role lives); the
 * entry builders give a created and a removed row their exact values.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@clokr/db";
import { accessContextFromRequest } from "./access-context";
import type { NormalizedRoleAssignmentScope } from "./role-assignment";

/** The fields of a stored role assignment that its audit value records. */
export interface RoleAssignmentAuditSource {
  userId: string;
  accessRoleId: string;
  scopeType: NormalizedRoleAssignmentScope["scopeType"];
  salonIds: string[];
  employeeIds: string[];
}

/** D-12: the exact audit value shape for every CREATE/UPDATE/DELETE on `RoleAssignment`. */
export function roleAssignmentAuditValue(row: RoleAssignmentAuditSource, roleName: string) {
  return {
    userId: row.userId,
    accessRoleId: row.accessRoleId,
    roleName,
    scopeType: row.scopeType,
    salonIds: row.salonIds,
    employeeIds: row.employeeIds,
  };
}

/**
 * Every RoleAssignment audit row goes through here (same reasoning as `salons.ts`'s `auditSalon`,
 * Phase 64b review WR-01): an API-key caller's `req.user.sub` is `apikey:<id>`, not a `User.id` —
 * `AuditLog.userId` has a foreign key to `User`, so passing it through would fail the audit insert.
 * The actor is resolved through the Unterbau's central access context (`accessContextFromRequest`,
 * #77) instead of parsing the subject here; a non-user actor leaves `userId` unset and is recorded
 * as `newValue.actor = { type: "API_KEY", apiKeyId }`.
 */
export async function auditRoleAssignment(
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

// ── Assignment changes (Phase 75b Plan 11, D-26) ────────────────────────────────────────────────

/** One pending RoleAssignment audit row of an assignment change, not yet written. */
export interface RoleAssignmentAuditEntry {
  action: "CREATE" | "UPDATE" | "DELETE";
  entityId: string;
  oldValue?: object;
  newValue?: object;
}

/** A stored assignment as a write-half function of `system-role-assignment.ts` returns it. */
type WrittenAssignment = RoleAssignmentAuditSource & { id: string; roleName: string };

/** The CREATE row of a created assignment, in the D-12 shape. */
export function createdAssignmentAuditEntry(row: WrittenAssignment): RoleAssignmentAuditEntry {
  return {
    action: "CREATE",
    entityId: row.id,
    newValue: roleAssignmentAuditValue(row, row.roleName),
  };
}

/** The DELETE row of a removed assignment: the D-12 value as `oldValue` (74b shape). */
export function removedAssignmentAuditEntry(row: WrittenAssignment): RoleAssignmentAuditEntry {
  return {
    action: "DELETE",
    entityId: row.id,
    oldValue: roleAssignmentAuditValue(row, row.roleName),
  };
}

/**
 * Writes the audit rows of one assignment change of `userId`, in order, on `tx`. The rows are the
 * whole trace of the change: the stored assignments are the only place a role lives, so no
 * derived value rides on them and no row is written for any other entity.
 */
export async function auditRoleAssignmentChange(
  app: FastifyInstance,
  req: FastifyRequest,
  tx: Prisma.TransactionClient,
  change: {
    userId: string;
    entries: RoleAssignmentAuditEntry[];
  },
): Promise<void> {
  for (const entry of change.entries) {
    await auditRoleAssignment(app, req, {
      action: entry.action,
      entityId: entry.entityId,
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      tx,
    });
  }
}
