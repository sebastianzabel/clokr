import { FastifyRequest, FastifyReply } from "fastify";
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

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply);
    if (!roles.includes(req.user.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
  };
}
