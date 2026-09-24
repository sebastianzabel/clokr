import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@clokr/db";
import { requireRole } from "../../../middleware/auth";
import {
  ROLE_NAME_MAX_LENGTH,
  roleNameKey,
  unknownPermissionKeys,
  normalizeRolePermissions,
} from "../access-role";

const ROLE_NAME_CONFLICT_MESSAGE = "Eine Rolle mit diesem Namen existiert bereits.";

const nameSchema = z.string().trim().min(1).max(ROLE_NAME_MAX_LENGTH);

const permissionsSchema = z.array(z.string()).superRefine((keys, ctx) => {
  for (const key of unknownPermissionKeys(keys)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unbekannte Permission: ${key}`,
      path: [keys.indexOf(key)],
    });
  }
});

const createRoleSchema = z.object({
  name: nameSchema,
  permissions: permissionsSchema,
});

interface AccessRoleRow {
  id: string;
  tenantId: string | null;
  name: string;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Maps a stored row onto the public response shape — `isSystem` is derived, never stored. */
function toRoleResponse(source: AccessRoleRow) {
  return {
    id: source.id,
    name: source.name,
    permissions: source.permissions,
    isSystem: source.tenantId === null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

/**
 * True when `nameKey` is already used by the tenant's own customer roles (excluding `excludeId`,
 * for a future rename) or by any system role (D-06). Two lookups, not one combined query, so a
 * copy-and-adapt of this shape for a future `:id` route stays simple.
 */
async function nameTaken(
  db: Prisma.TransactionClient,
  tenantId: string,
  nameKey: string,
  excludeId: string | null,
): Promise<boolean> {
  const ownMatch = await db.accessRole.findFirst({
    where: {
      tenantId,
      nameKey,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
  if (ownMatch) return true;

  const systemMatch = await db.accessRole.findFirst({
    where: { tenantId: null, nameKey },
  });
  return systemMatch !== null;
}

/** Source: apps/api/src/contexts/absence/api/leave.ts:150-155 (structural P2002 check idiom). */
function isPrismaErrorCode(err: unknown, code: string): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

export async function roleRoutes(app: FastifyInstance) {
  // GET /api/v1/roles — every system role plus the caller's own customer roles (AK-73-3).
  app.get("/", {
    schema: {
      tags: ["Rollen"],
      security: [{ bearerAuth: [] }],
      summary: "List roles",
      description:
        "Returns every system role (global, no tenant) plus the customer roles owned by the caller's own tenant. System roles are listed first, then customer roles, both alphabetically by name.",
    },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const rows = await app.prisma.accessRole.findMany({
        where: { OR: [{ tenantId: null }, { tenantId: req.user.tenantId }] },
      });
      const sorted = [...rows].sort((a, b) => {
        const aSystem = a.tenantId === null;
        const bSystem = b.tenantId === null;
        if (aSystem !== bSystem) return aSystem ? -1 : 1;
        return a.nameKey.localeCompare(b.nameKey);
      });
      return sorted.map(toRoleResponse);
    },
  });

  // POST /api/v1/roles — create a customer role for the caller's own tenant (AK-73-1/AK-73-2).
  app.post("/", {
    schema: {
      tags: ["Rollen"],
      security: [{ bearerAuth: [] }],
      summary: "Create a customer role",
      description:
        "Creates a customer role of the caller's own tenant from a name and a set of catalog permission keys. Unknown permission keys are rejected with 400; a name that collides case-insensitively with an existing role of the same tenant, or with any system role, is rejected with 409.",
    },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const body = createRoleSchema.parse(req.body);
      const tenantId = req.user.tenantId;
      const permissions = normalizeRolePermissions(body.permissions);
      const nameKey = roleNameKey(body.name);

      try {
        const created = await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          if (await nameTaken(tx, tenantId, nameKey, null)) {
            return null;
          }
          const source = await tx.accessRole.create({
            data: { tenantId, name: body.name, nameKey, permissions },
          });
          await app.audit({
            tx,
            userId: req.user.sub,
            action: "CREATE",
            entity: "AccessRole",
            entityId: source.id,
            newValue: {
              name: source.name,
              permissions: source.permissions,
              tenantId: source.tenantId,
            },
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
          return source;
        });

        if (!created) {
          return reply.code(409).send({ error: ROLE_NAME_CONFLICT_MESSAGE });
        }
        return reply.code(201).send(toRoleResponse(created));
      } catch (err: unknown) {
        if (isPrismaErrorCode(err, "P2002")) {
          return reply.code(409).send({ error: ROLE_NAME_CONFLICT_MESSAGE });
        }
        throw err;
      }
    },
  });
}
