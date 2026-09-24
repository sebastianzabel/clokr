/**
 * Phase 67b Plan 01 (issue #67, D-21) — the shared WR-01 audit helper for every
 * `EmployeeSalonAssignment` mutation and the route's T-100-09 rejection path.
 *
 * A direct copy of `auditSalon`'s body (`contexts/platform/api/salons.ts`): the actor is resolved
 * through the Unterbau's central access context (`accessContextFromRequest`, #77) rather than by
 * parsing `req.user.sub` here, because a `clk_` API-key caller's subject (`apikey:<id>`) is not a
 * `User.id` — `AuditLog.userId` has a foreign key to `User`, so passing it through would fail the
 * audit insert (a 500 on every write, and on the T-100-09 path a 500 for a foreign entity against
 * a 404 for an unknown id — an oracle). A non-user actor leaves `userId` unset and is recorded as
 * `newValue.actor = { type: "API_KEY", apiKeyId }`.
 *
 * This exists as its own module (rather than restating `auditSalon` inline) because four concrete
 * call sites need it in this phase — this route file, and (Plan 02+) `employees.ts`, `imports.ts`,
 * `salons.ts`'s own deactivation extension. It is not a generic extension point: the same defect
 * (auditing `req.user.sub` directly) elsewhere is tracked in #333, not solved here.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@clokr/db";
import { accessContextFromRequest } from "./access-context";

export async function auditSalonAssignmentEvent(
  app: FastifyInstance,
  req: FastifyRequest,
  entry: {
    entity: "EmployeeSalonAssignment" | "Employee" | "Salon";
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
    entity: entry.entity,
    entityId: entry.entityId,
    oldValue: entry.oldValue,
    newValue,
    request: { ip: req.ip, headers: req.headers as Record<string, string> },
    tx: entry.tx,
  });
}
