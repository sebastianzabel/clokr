import { FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "crypto";
import { Role } from "@clokr/db";

export interface JwtPayload {
  sub: string; // userId
  role: Role;
  tenantId: string;
  employeeId?: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    apiKeyScopes?: string[];
  }
}

/**
 * Phase 88 (#88, D-02, D-05a): the tenant guard refuses two things besides an invalid credential.
 *
 *   1. An operator token (AC-88-03). The operator secret differs from the tenant secret, so an operator
 *      token fails the tenant verify; the operator verifier (present only when OPERATOR_JWT_SECRET is
 *      configured) then recognises it and the answer is an explicit, audited 403 instead of the
 *      indistinguishable 401. A payload that verified with the TENANT secret but carries the operator kind
 *      or audience is refused the same way (defence in depth if the two secrets were ever equal).
 *   2. A tenant token without a tenant (#551): a verified payload whose tenant id is blank, whitespace-only,
 *      absent or not a string (a User without an Employee) is refused with 403 `TENANT_REQUIRED` before
 *      any permission check and before any query. The rule is `isBlankTenantId`, decided once in
 *      `contexts/platform/tenant-status.ts` and handed over as a decoration.
 *   3. A deactivated tenant, for JWT and API key alike (AC-88-08, D-05): an access token or key issued
 *      before the deactivation stays cryptographically valid, so the tenant state is checked on every
 *      request through `tenantIsActive` (cached for at most 10 s, invalidated explicitly).
 *
 * This file imports nothing from `contexts/` (eslint boundary, import cycle): the platform context hands
 * its helpers over as Fastify decorations of `plugins/tenant-status.ts`. A missing decoration throws and
 * ends in the global 500 handler — the guard fails closed, it never skips a check.
 */
function tenantGuard(req: FastifyRequest) {
  const server = req.server;
  if (
    typeof server.tenantIsActive !== "function" ||
    typeof server.hasOperatorClaims !== "function" ||
    typeof server.isBlankTenantId !== "function" ||
    typeof server.recordOperatorPrincipalRefused !== "function" ||
    !server.tenantDeactivatedError ||
    !server.tenantRequiredError
  ) {
    throw new Error("tenantStatusPlugin is not registered; refusing to authenticate");
  }
  return server;
}

/**
 * Authenticate via JWT or API Key (clk_ prefix).
 * API keys are validated against the database and scopes are attached to the request.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;
  const server = tenantGuard(req);

  // Check for API key (clk_ prefix)
  if (authHeader?.startsWith("Bearer clk_")) {
    const rawKey = authHeader.slice(7);
    const keyHash = createHash("sha256").update(rawKey).digest("hex");

    const apiKey = await req.server.prisma.apiKey.findUnique({ where: { keyHash } });
    if (!apiKey || apiKey.revokedAt) {
      return reply.code(401).send({ error: "Ungültiger oder widerrufener API Key" });
    }
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return reply.code(401).send({ error: "API Key abgelaufen" });
    }
    // The foreign key makes a key without a tenant unreachable; this is defence in depth, and it runs
    // before the lastUsedAt write so a refused key leaves no trace.
    if (server.isBlankTenantId(apiKey.tenantId)) {
      return reply.code(403).send(server.tenantRequiredError);
    }
    if (!(await server.tenantIsActive(apiKey.tenantId))) {
      return reply.code(403).send(server.tenantDeactivatedError);
    }

    // Update lastUsedAt (fire and forget)
    req.server.prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) =>
        req.server.log.error({ err }, "Failed to update API key lastUsedAt"),
      );

    // Set user context from API key (role = ADMIN for admin scope, MANAGER otherwise)
    const isAdmin = apiKey.scopes.includes("admin");
    req.user = {
      sub: `apikey:${apiKey.id}`,
      role: isAdmin ? "ADMIN" : ("MANAGER" as Role),
      tenantId: apiKey.tenantId,
    };
    // Attach scopes for downstream checks
    req.apiKeyScopes = apiKey.scopes;
    return;
  }

  // Standard JWT auth
  try {
    await req.jwtVerify();
  } catch {
    // Not a tenant token. If it is an operator token (the verifier exists only with OPERATOR_JWT_SECRET),
    // say so with an audited 403; anything else keeps the unchanged 401 body.
    if (typeof req.operatorJwtVerify === "function") {
      try {
        await req.operatorJwtVerify();
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const operatorSub = (req.operator as { sub?: unknown } | null)?.sub;
      await server.recordOperatorPrincipalRefused(
        req,
        typeof operatorSub === "string" ? operatorSub : "unknown",
        { operatorAccountVerified: typeof operatorSub === "string" },
      );
      return reply.code(403).send({ error: "Forbidden" });
    }
    return reply.code(401).send({ error: "Unauthorized" });
  }

  // Verified with the tenant secret, yet shaped like an operator token: never a tenant principal.
  if (server.hasOperatorClaims(req.user)) {
    const claimed = req.user as unknown as { sub?: unknown; tenantId?: unknown };
    await server.recordOperatorPrincipalRefused(
      req,
      typeof claimed.sub === "string" ? claimed.sub : "unknown",
      {
        operatorAccountVerified: false,
        claimedTenantId: typeof claimed.tenantId === "string" ? claimed.tenantId : null,
      },
    );
    return reply.code(403).send({ error: "Forbidden" });
  }

  // A tenant token without a tenant (a User without an Employee) never reaches a permission check or a
  // query (#551, D-01). The claim is read as unknown: an absent claim is undefined at runtime.
  if (server.isBlankTenantId((req.user as { tenantId?: unknown }).tenantId)) {
    return reply.code(403).send(server.tenantRequiredError);
  }

  if (!(await server.tenantIsActive(req.user.tenantId))) {
    return reply.code(403).send(server.tenantDeactivatedError);
  }
}

// The role guard that used to live here was removed in Phase 75b (Issue #75, D-18): every access
// decision asks for a catalog permission via `requirePermission` / `requireAnyPermission` from
// `contexts/platform`. `lint:role-checks` (apps/api/scripts/lint-role-checks.ts) fails on any
// call of the old helper and on any role comparison outside `contexts/platform/compat-role.ts`.
