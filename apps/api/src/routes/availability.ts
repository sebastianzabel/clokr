import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { isAvailabilityEnabled } from "../utils/tenant-availability";

// ── Schemas ──────────────────────────────────────────────────────────────────

const availabilityItemSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "date muss YYYY-MM-DD sein")
      .nullable()
      .optional(),
    status: z.enum(["AVAILABLE", "UNAVAILABLE", "PREFERRED"]),
    note: z.string().max(200).nullable().optional(),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validFrom muss YYYY-MM-DD sein"),
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "validUntil muss YYYY-MM-DD sein")
      .nullable()
      .optional(),
  })
  .refine(
    (v) =>
      (v.dayOfWeek !== null && v.dayOfWeek !== undefined) !==
      (v.date !== null && v.date !== undefined),
    { message: "Entweder dayOfWeek ODER date angeben, nicht beides" },
  )
  .refine((v) => !v.validUntil || v.validFrom <= v.validUntil, {
    message: "validUntil muss nach validFrom liegen",
    path: ["validUntil"],
  });

export const putAvailabilitySchema = z.object({
  entries: z.array(availabilityItemSchema),
});

export type AvailabilityEntryInput = z.infer<typeof availabilityItemSchema>;

const idParamSchema = z.object({ id: z.string().uuid() });

// ── Helpers ──────────────────────────────────────────────────────────────────

interface AvailabilityRow {
  id: string;
  employeeId: string;
  dayOfWeek: number | null;
  date: Date | null;
  status: "AVAILABLE" | "UNAVAILABLE" | "PREFERRED";
  note: string | null;
  validFrom: Date;
  validUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

export function formatEntry(e: AvailabilityRow) {
  return {
    ...e,
    date: e.date ? e.date.toISOString().slice(0, 10) : null,
    validFrom: e.validFrom.toISOString().slice(0, 10),
    validUntil: e.validUntil ? e.validUntil.toISOString().slice(0, 10) : null,
  };
}

/**
 * REPLACE-semantics helper: delete all current availability rows for the given
 * employee, then re-insert from the validated input array within a single
 * transaction. Returns the freshly-created rows.
 *
 * Caller is responsible for tenant scoping (lookup) + audit logging.
 */
export async function replaceAvailability(
  app: FastifyInstance,
  employeeId: string,
  entries: AvailabilityEntryInput[],
  createdBy: string,
): Promise<AvailabilityRow[]> {
  return app.prisma.$transaction(async (tx) => {
    await tx.employeeAvailability.deleteMany({ where: { employeeId } });
    const out: AvailabilityRow[] = [];
    for (const e of entries) {
      const row = await tx.employeeAvailability.create({
        data: {
          employeeId,
          dayOfWeek: e.dayOfWeek ?? null,
          date: e.date ? new Date(e.date) : null,
          status: e.status,
          note: e.note ?? null,
          validFrom: new Date(e.validFrom),
          validUntil: e.validUntil ? new Date(e.validUntil) : null,
          createdBy,
        },
      });
      out.push(row);
    }
    return out;
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function availabilityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/v1/employees/:id/availability
  // Returns the employee's availability entries (recurring + one-off).
  // Access: ADMIN/MANAGER may read any in their tenant. EMPLOYEE may only read own.
  app.get("/:id/availability", {
    schema: { tags: ["Verfügbarkeit"], security: [{ bearerAuth: [] }] },
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);

      // Tenant-scoped employee lookup
      const employee = await app.prisma.employee.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Permission: EMPLOYEE may only read own availability
      if (req.user.role === "EMPLOYEE" && req.user.employeeId !== id) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      // Phase 47.3 — Feature toggle: 410 Gone when disabled (truthful, not 404).
      const featureOn = await isAvailabilityEnabled(app.prisma, req.user.tenantId);
      if (!featureOn) {
        return reply.code(410).send({
          error: "Verfügbarkeits-System deaktiviert",
          code: "AVAILABILITY_FEATURE_DISABLED",
        });
      }

      const entries = await app.prisma.employeeAvailability.findMany({
        where: { employeeId: id },
        orderBy: [{ date: "asc" }, { dayOfWeek: "asc" }],
      });

      return reply.code(200).send({ entries: entries.map(formatEntry) });
    },
  });

  // PUT /api/v1/employees/:id/availability
  // REPLACE-semantics: delete all existing rows for this employee and re-insert
  // the supplied array. ADMIN/MANAGER may edit any employee in their tenant.
  // EMPLOYEE may edit ONLY their own availability (deviates from shift-patterns
  // intentionally — MA-Self-Service is the whole point of Phase 46).
  app.put("/:id/availability", {
    schema: { tags: ["Verfügbarkeit"], security: [{ bearerAuth: [] }] },
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = putAvailabilitySchema.parse(req.body);

      const employee = await app.prisma.employee.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Permission: EMPLOYEE may only PUT on OWN row
      if (req.user.role === "EMPLOYEE" && req.user.employeeId !== id) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      // Phase 47.3 — Feature toggle: 410 Gone when disabled (truthful, not 404).
      const featureOn = await isAvailabilityEnabled(app.prisma, req.user.tenantId);
      if (!featureOn) {
        return reply.code(410).send({
          error: "Verfügbarkeits-System deaktiviert",
          code: "AVAILABILITY_FEATURE_DISABLED",
        });
      }

      // Audit before-snapshot
      const oldEntries = await app.prisma.employeeAvailability.findMany({
        where: { employeeId: id },
      });

      // REPLACE inside a single transaction
      const created = await replaceAvailability(app, id, body.entries, req.user.sub);

      // ONE audit entry per REPLACE (not per-row)
      await app.audit({
        userId: req.user.sub,
        action: "REPLACE",
        entity: "EmployeeAvailability",
        entityId: id,
        oldValue: { entries: oldEntries.map(formatEntry) },
        newValue: { entries: created.map(formatEntry) },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(200).send({ entries: created.map(formatEntry) });
    },
  });
}
