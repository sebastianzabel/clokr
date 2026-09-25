import fp from "fastify-plugin";
import type { Prisma } from "@clokr/db";
import { API_KEY_SUBJECT_PREFIX } from "../access-context";

declare module "fastify" {
  interface FastifyInstance {
    audit: (params: {
      userId?: string;
      action: string;
      entity: string;
      entityId?: string;
      oldValue?: unknown;
      newValue?: unknown;
      request?: { ip: string; headers: Record<string, string | string[] | undefined> };
      tx?: Prisma.TransactionClient;
    }) => Promise<void>;
  }
}

/** The API-key actor metadata embedded in `AuditLog.newValue.actor` — same shape as
 * `services/clock/audit-actor.ts` and `contexts/platform/request-audit-fields.ts`. */
interface ApiKeyActorMeta {
  type: "API_KEY";
  apiKeyId: string;
}

/** Folds `actor` into `newValue` without losing whatever the caller already put there. An object
 * gets the key added; a primitive (or `undefined`) is wrapped, mirroring `emitClockAudit`'s
 * merge in `services/clock/audit-actor.ts`. */
function withActorMeta(newValue: unknown, actor: ApiKeyActorMeta): object {
  if (newValue !== undefined && typeof newValue === "object" && newValue !== null) {
    return { ...(newValue as Record<string, unknown>), actor };
  }
  return newValue === undefined ? { actor } : { value: newValue, actor };
}

export const auditPlugin = fp(async (app) => {
  app.decorate(
    "audit",
    async (params: {
      userId?: string;
      action: string;
      entity: string;
      entityId?: string;
      oldValue?: unknown;
      newValue?: unknown;
      request?: { ip: string; headers: Record<string, string | string[] | undefined> };
      tx?: Prisma.TransactionClient;
    }) => {
      const client = params.tx ?? app.prisma;

      // Issue #333: AuditLog.userId has a foreign key onto User. Many call sites still pass
      // `req.user.sub` straight through, which for an API-key caller is `apikey:<id>` — not a
      // User.id. Writing it verbatim fails the insert (500), and because that happens even on
      // the CROSS_TENANT_ACCESS_DENIED audit of a foreign-tenant lookup, it turns an otherwise
      // identical 404 into a distinguishable 500 (a T-100-09 tenant-membership oracle). This is
      // the ONE place every app.audit() call passes through — user-resolved call sites
      // (requestAuditFields(), auditSalon, auditRoleAssignment, emitClockAudit) already hand in
      // `userId: undefined` and their own `actor` metadata, so this check is a no-op for them;
      // it only ever fires for the ~146 sites that still pass the raw subject.
      let userId = params.userId;
      let newValue = params.newValue;
      if (typeof userId === "string" && userId.startsWith(API_KEY_SUBJECT_PREFIX)) {
        const apiKeyId = userId.slice(API_KEY_SUBJECT_PREFIX.length);
        userId = undefined;
        newValue = withActorMeta(newValue, { type: "API_KEY", apiKeyId });
      }

      await client.auditLog.create({
        data: {
          userId,
          action: params.action,
          entity: params.entity,
          entityId: params.entityId,
          oldValue: params.oldValue ? JSON.parse(JSON.stringify(params.oldValue)) : undefined,
          newValue: newValue ? JSON.parse(JSON.stringify(newValue)) : undefined,
          ipAddress: params.request?.ip,
          userAgent: params.request?.headers["user-agent"] as string | undefined,
        },
      });
    },
  );
});
