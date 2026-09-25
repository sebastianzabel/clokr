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
 * order and puts the compat-column change on the last of them (D-29); the entry builders give the
 * materialized fallback (D-26), a created and a removed row their exact values.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@clokr/db";
import { accessContextFromRequest } from "./access-context";
import { requestAuditFields } from "./request-audit-fields";
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

// ── Assignment changes with a compat-role write-back (Phase 75b Plan 11, D-26/D-29) ────────────

/** D-26: the `reason` of the CREATE audit row of a materialized legacy-role assignment. */
export const LEGACY_ROLE_MATERIALIZATION_REASON = "Übernahme der Alt-Rolle (#75)";

/** One pending RoleAssignment audit row of an assignment change, not yet written. */
export interface RoleAssignmentAuditEntry {
  action: "CREATE" | "UPDATE" | "DELETE";
  entityId: string;
  oldValue?: object;
  newValue?: object;
}

/** A stored assignment as a write-half function of `compat-role.ts` returns it. */
type WrittenAssignment = RoleAssignmentAuditSource & { id: string; roleName: string };

/**
 * D-26: the CREATE row of a materialized fallback — the D-12 value plus `origin: "SYSTEM"` (the
 * row was not requested, the system stored what the fallback already granted), the reason and the
 * legacy `User.role` it came from, the same fields the data migration records (D-05).
 */
export function materializedAssignmentAuditEntry(materialized: {
  assignment: WrittenAssignment;
  legacyRole: string;
}): RoleAssignmentAuditEntry {
  const { assignment, legacyRole } = materialized;
  return {
    action: "CREATE",
    entityId: assignment.id,
    newValue: {
      ...roleAssignmentAuditValue(assignment, assignment.roleName),
      origin: "SYSTEM",
      reason: LEGACY_ROLE_MATERIALIZATION_REASON,
      legacyRole,
    },
  };
}

/** The CREATE row of a created assignment, in the D-12 shape. */
export function createdAssignmentAuditEntry(row: WrittenAssignment): RoleAssignmentAuditEntry {
  return {
    action: "CREATE",
    entityId: row.id,
    newValue: roleAssignmentAuditValue(row, row.roleName),
  };
}

/**
 * The DELETE row of a removed assignment: the D-12 value as `oldValue`, and `newValue` only when
 * the caller names the trigger (e.g. `{ reason: "Anonymisierung" }`, 74b D-22).
 */
export function removedAssignmentAuditEntry(
  row: WrittenAssignment,
  newValue?: object,
): RoleAssignmentAuditEntry {
  return {
    action: "DELETE",
    entityId: row.id,
    oldValue: roleAssignmentAuditValue(row, row.roleName),
    ...(newValue !== undefined ? { newValue } : {}),
  };
}

/**
 * Writes the audit rows of one assignment change of `userId`, in order, on `tx` — and records the
 * compat-column change the change caused (D-29): `compatRole: { from, to }` is merged into the
 * `newValue` of the LAST row, so the column is never rewritten without an audit trace and without
 * a second row for the same change. When the change wrote no assignment row but still rewrote the
 * column (anonymizing a user who relied on the fallback, or a column that disagreed with its
 * stored rows), one UPDATE row on entity `User` records `{ compatRole, reason? }` instead.
 */
export async function auditRoleAssignmentChange(
  app: FastifyInstance,
  req: FastifyRequest,
  tx: Prisma.TransactionClient,
  change: {
    userId: string;
    entries: RoleAssignmentAuditEntry[];
    compatRole: { from: string; to: string } | null;
    reason?: string;
  },
): Promise<void> {
  const { entries, compatRole } = change;
  if (compatRole !== null && entries.length === 0) {
    await app.audit({
      action: "UPDATE",
      entity: "User",
      entityId: change.userId,
      ...requestAuditFields(req, {
        compatRole,
        ...(change.reason !== undefined ? { reason: change.reason } : {}),
      }),
      tx,
    });
    return;
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    await auditRoleAssignment(app, req, {
      action: entry.action,
      entityId: entry.entityId,
      oldValue: entry.oldValue,
      newValue:
        isLast && compatRole !== null ? { ...(entry.newValue ?? {}), compatRole } : entry.newValue,
      tx,
    });
  }
}
