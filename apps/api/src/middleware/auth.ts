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

/**
 * Authenticate via JWT or API Key (clk_ prefix).
 * API keys are validated against the database and scopes are attached to the request.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;

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

    // Update lastUsedAt (fire and forget)
    req.server.prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) => req.server.log.error({ err }, "Failed to update API key lastUsedAt"));

    // Set user context from API key (role = ADMIN for admin scope, MANAGER otherwise)
    const isAdmin = apiKey.scopes.includes("admin");
    req.user = {
      sub: `apikey:${apiKey.id}`,
      role: isAdmin ? "ADMIN" : ("MANAGER" as Role),
      tenantId: apiKey.tenantId,
    };
    // Attach scopes for downstream checks
    (req as any).apiKeyScopes = apiKey.scopes;
    return;
  }

  // Standard JWT auth
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply);
    if (reply.sent) return; // Auth already failed
    if (!roles.includes(req.user.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  };
}
