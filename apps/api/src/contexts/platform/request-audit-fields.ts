/**
 * Phase 74b review (WR-03, WR-06): the actor and request fields of an `app.audit()` call made on
 * behalf of an authenticated request.
 *
 * For a `clk_` API-key caller `req.user.sub` is `apikey:<id>`, which is not a `User.id`.
 * `AuditLog.userId` has a foreign key to `User`, so passing the subject through fails the audit
 * insert — and with the audit inside the write's transaction, the whole write. The actor is
 * resolved through the Unterbau's central access context (`accessContextFromRequest`, #77): a user
 * lands in `userId`; an API key leaves `userId` unset and is recorded as
 * `newValue.actor = { type: "API_KEY", apiKeyId }`, added next to the entry's own `newValue`.
 * Same storage convention as `auditSalon` (`api/salons.ts`, 64b WR-01), `auditRoleAssignment`
 * (`api/role-assignments.ts`) and `services/clock/audit-actor.ts`; the remaining routes that still
 * audit `req.user.sub` directly are tracked in #333.
 *
 * `request` carries the IP and headers (user agent), which CLAUDE.md § Audit-Proof requires on
 * every audit entry.
 *
 * Usage: `app.audit({ tx, action, entity, entityId, oldValue, ...requestAuditFields(req, newValue) })`.
 */
import type { FastifyRequest } from "fastify";
import { accessContextFromRequest } from "./access-context";

export interface RequestAuditFields {
  userId: string | undefined;
  newValue: object | undefined;
  request: { ip: string; headers: Record<string, string> };
}

export function requestAuditFields(req: FastifyRequest, newValue?: object): RequestAuditFields {
  const { actor } = accessContextFromRequest(req);
  const apiKeyActor =
    actor.kind === "apiKey" ? { type: "API_KEY" as const, apiKeyId: actor.apiKeyId } : null;
  return {
    userId: actor.kind === "user" ? actor.userId : undefined,
    newValue: apiKeyActor ? { ...(newValue ?? {}), actor: apiKeyActor } : newValue,
    request: { ip: req.ip, headers: req.headers as Record<string, string> },
  };
}
