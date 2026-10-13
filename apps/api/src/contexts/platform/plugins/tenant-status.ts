/**
 * Per-request tenant state and operator-principal refusal helpers (Phase 88, #88, D-02, D-05, D-05a).
 *
 * `middleware/auth.ts` may not import from `contexts/` (eslint boundary, import cycle through
 * `request-permissions.ts`), so everything it needs from the platform context arrives as Fastify
 * decorations of this plugin:
 *
 * - `tenantIsActive(tenantId)` — whether the tenant may be served right now. Cached per process for at
 *   most `TENANT_STATUS_CACHE_TTL_MS` (10 s): a request of a deactivated tenant is refused within that
 *   bound even when nothing invalidated the cache. This instance serves one customer (instance per
 *   customer), so additional replicas are the only staleness vector; `invalidateTenantState(tenantId)`
 *   drops the entry at once and is called by the paths that (de)activate a tenant. A blank or absent
 *   tenant id is never looked up (D-10, #551: users without an Employee have no tenant) and an unknown
 *   tenant counts as active — the check only ever refuses a tenant it positively knows is deactivated.
 * - `tenantDeactivatedError` — the one refusal body (`TENANT_DEACTIVATED`, 403).
 * - `hasOperatorClaims(payload)` — whether a payload that verified with the TENANT secret nevertheless
 *   carries the operator kind claim or audience (defence in depth against equal secrets).
 * - `recordOperatorPrincipalRefused(req, sub, options)` — the audit row for an operator token on a
 *   tenant route, written through the bounded `recordPrincipalRefusal` (one row per sub/route/minute).
 */
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { isTenantDeactivated, TENANT_DEACTIVATED_ERROR } from "../tenant-status";
import { OPERATOR_AUDIT_ACTIONS, recordPrincipalRefusal } from "../operator-audit";
import { OPERATOR_TOKEN_AUDIENCE, OPERATOR_TOKEN_KIND } from "../operator-auth";

/** Upper bound of the per-process staleness of the tenant state (D-05a). */
export const TENANT_STATUS_CACHE_TTL_MS = 10_000;
const TENANT_STATUS_CACHE_MAX_ENTRIES = 5_000;

export type OperatorRefusalOptions = {
  /** True when the token verified with the OPERATOR secret, i.e. the account id in `sub` is real. */
  operatorAccountVerified?: boolean;
  /** The tenant the token claimed, for the audit subject. */
  claimedTenantId?: string | null;
};

declare module "fastify" {
  interface FastifyInstance {
    tenantIsActive(tenantId: string | null | undefined): Promise<boolean>;
    invalidateTenantState(tenantId: string): void;
    tenantDeactivatedError: typeof TENANT_DEACTIVATED_ERROR;
    hasOperatorClaims(payload: unknown): boolean;
    recordOperatorPrincipalRefused(
      req: FastifyRequest,
      operatorSub: string,
      options?: OperatorRefusalOptions,
    ): Promise<void>;
  }
}

export const tenantStatusPlugin = fp(async (app) => {
  const cache = new Map<string, { active: boolean; expiresAt: number }>();
  // Bumped by every invalidation: a lookup that started before it must not write its (possibly stale)
  // answer back into the cache.
  let generation = 0;

  app.decorate("tenantDeactivatedError", TENANT_DEACTIVATED_ERROR);

  app.decorate("tenantIsActive", async (tenantId: string | null | undefined): Promise<boolean> => {
    if (!tenantId || tenantId.trim() === "") return true;

    const now = Date.now();
    const hit = cache.get(tenantId);
    if (hit && hit.expiresAt > now) return hit.active;

    const startedAt = generation;
    const active = !(await isTenantDeactivated(app.prisma, tenantId));
    if (startedAt === generation) {
      if (cache.size >= TENANT_STATUS_CACHE_MAX_ENTRIES) cache.clear();
      cache.set(tenantId, { active, expiresAt: Date.now() + TENANT_STATUS_CACHE_TTL_MS });
    }
    return active;
  });

  app.decorate("invalidateTenantState", (tenantId: string): void => {
    generation += 1;
    cache.delete(tenantId);
  });

  app.decorate("hasOperatorClaims", (payload: unknown): boolean => {
    if (typeof payload !== "object" || payload === null) return false;
    const p = payload as Record<string, unknown>;
    const aud = p.aud;
    return (
      p.kind === OPERATOR_TOKEN_KIND ||
      aud === OPERATOR_TOKEN_AUDIENCE ||
      (Array.isArray(aud) && aud.includes(OPERATOR_TOKEN_AUDIENCE))
    );
  });

  app.decorate(
    "recordOperatorPrincipalRefused",
    async (
      req: FastifyRequest,
      operatorSub: string,
      options: OperatorRefusalOptions = {},
    ): Promise<void> => {
      try {
        await recordPrincipalRefusal(app.prisma, {
          action: OPERATOR_AUDIT_ACTIONS.OPERATOR_PRINCIPAL_REFUSED,
          principalSub: operatorSub,
          operatorId: options.operatorAccountVerified ? operatorSub : null,
          subjectTenantId: options.claimedTenantId ?? null,
          route: req.routeOptions?.url ?? req.url,
          method: req.method,
          request: req,
        });
      } catch (err) {
        // The refusal itself must not depend on the audit write: the caller answers 403 either way.
        req.log.error({ err }, "Failed to audit a refused operator token");
      }
    },
  );
});
