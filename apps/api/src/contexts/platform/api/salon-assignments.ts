/**
 * Phase 67b Plan 01 (issue #67) — Unterbau's admin `EmployeeSalonAssignment` routes, registered
 * under the employees namespace (`prefix: "/api/v1/employees"`).
 *
 * Plan 01 registers the read path only (`GET /:id/salon-assignments`). Plan 02 adds the write
 * surface (create DEPLOYMENT, change HOME, end an assignment) — see `67b-CONTEXT.md` D-05..D-15.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  employeeExistsInForeignTenant,
  findEmployeeInTenant,
  listSalonAssignments,
} from "../facade/salon-assignments";
import { toAssignmentDto } from "../salon-assignment-rules";
import { auditSalonAssignmentEvent } from "../salon-assignment-audit";
import { requireRole } from "../../../middleware/auth";

const idParamSchema = z.object({ id: z.string().uuid() });

const EMPLOYEE_NOT_FOUND = "Mitarbeiter nicht gefunden";

/**
 * D-19: the shared T-100-09 guard for every route below with an `:id` (employee) path parameter. A
 * foreign tenant's real employee and a nonexistent id both end up here and get the IDENTICAL
 * 404 — the only difference is whether a `CROSS_TENANT_ACCESS_DENIED` row is written first, and
 * that row's existence never reaches the client. Same shape as `rejectUnknownSalon`
 * (`api/salons.ts`).
 */
async function rejectUnknownEmployee(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  employeeId: string,
) {
  if (await employeeExistsInForeignTenant(app.prisma, req.user.tenantId, employeeId)) {
    await auditSalonAssignmentEvent(app, req, {
      entity: "Employee",
      action: "CROSS_TENANT_ACCESS_DENIED",
      entityId: employeeId,
    });
  }
  return reply.code(404).send({ error: EMPLOYEE_NOT_FOUND });
}

export async function salonAssignmentRoutes(app: FastifyInstance) {
  // GET /api/v1/employees/:id/salon-assignments — full history (D-17, D-18, D-19)
  app.get("/:id/salon-assignments", {
    schema: {
      tags: ["Mitarbeiter"],
      summary: "List an employee's full salon assignment history (HOME + DEPLOYMENT)",
      security: [{ bearerAuth: [] }],
    },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const tenantId = req.user.tenantId;

      const employee = await findEmployeeInTenant(app.prisma, tenantId, id);
      if (!employee) return rejectUnknownEmployee(app, req, reply, id);

      const rows = await listSalonAssignments(app.prisma, tenantId, id);
      return { assignments: rows.map(toAssignmentDto) };
    },
  });
}
