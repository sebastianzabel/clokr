import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";

const templateSchema = z.object({
  name: z.string().min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  color: z.string().default("#3B82F6"),
});

const shiftSchema = z.object({
  employeeId: z.string(),
  templateId: z.string().optional(),
  date: z.string(), // YYYY-MM-DD
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  label: z.string().optional(),
  note: z.string().optional(),
});

const bulkShiftSchema = z.object({
  shifts: z.array(shiftSchema),
});

export async function shiftRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ── Templates ──────────────────────────────────────────────

  // GET /templates
  app.get("/templates", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    handler: async (req) => {
      return app.prisma.shiftTemplate.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: { startTime: "asc" },
      });
    },
  });

  // POST /templates (ADMIN/MANAGER)
  app.post("/templates", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = templateSchema.parse(req.body);
      const template = await app.prisma.shiftTemplate.create({
        data: { ...body, tenantId: req.user.tenantId },
      });
      return reply.code(201).send(template);
    },
  });

  // DELETE /templates/:id
  app.delete("/templates/:id", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      await app.prisma.shiftTemplate.delete({ where: { id } });
      return reply.code(204).send();
    },
  });

  // ── Shifts ─────────────────────────────────────────────────

  // GET /week?date=YYYY-MM-DD — get all shifts for the week containing the date
  app.get("/week", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    handler: async (req) => {
      const { date } = req.query as { date?: string };
      const refDate = date ? new Date(date + "T00:00:00Z") : new Date();

      // Calculate Monday of the week
      const dow = refDate.getUTCDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(refDate);
      monday.setUTCDate(monday.getUTCDate() + mondayOffset);
      monday.setUTCHours(0, 0, 0, 0);

      const sunday = new Date(monday);
      sunday.setUTCDate(sunday.getUTCDate() + 6);
      sunday.setUTCHours(23, 59, 59, 999);

      const shifts = await app.prisma.shift.findMany({
        where: {
          employee: { tenantId: req.user.tenantId },
          date: { gte: monday, lte: sunday },
        },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
          template: { select: { name: true, color: true } },
        },
        orderBy: [{ date: "asc" }, { startTime: "asc" }],
      });

      const employees = await app.prisma.employee.findMany({
        where: { tenantId: req.user.tenantId },
        select: { id: true, firstName: true, lastName: true, employeeNumber: true },
        orderBy: { lastName: "asc" },
      });

      // Generate weekDays array
      const weekDays: string[] = [];
      const cur = new Date(monday);
      for (let i = 0; i < 7; i++) {
        weekDays.push(cur.toISOString().split("T")[0]);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      return { weekDays, employees, shifts };
    },
  });

  // POST / — create single shift
  app.post("/", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = shiftSchema.parse(req.body);

      // If templateId provided, get template defaults
      let label = body.label;
      if (body.templateId && !label) {
        const tpl = await app.prisma.shiftTemplate.findUnique({ where: { id: body.templateId } });
        if (tpl) label = tpl.name;
      }

      const shift = await app.prisma.shift.create({
        data: {
          employeeId: body.employeeId,
          templateId: body.templateId,
          date: new Date(body.date),
          startTime: body.startTime,
          endTime: body.endTime,
          label,
          note: body.note,
          createdBy: req.user.sub,
        },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true } },
          template: { select: { name: true, color: true } },
        },
      });

      return reply.code(201).send(shift);
    },
  });

  // POST /bulk — create multiple shifts at once
  app.post("/bulk", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { shifts: shiftDefs } = bulkShiftSchema.parse(req.body);

      const created = await app.prisma.$transaction(
        shiftDefs.map(s =>
          app.prisma.shift.create({
            data: {
              employeeId: s.employeeId,
              templateId: s.templateId,
              date: new Date(s.date),
              startTime: s.startTime,
              endTime: s.endTime,
              label: s.label,
              note: s.note,
              createdBy: req.user.sub,
            },
          })
        )
      );

      return reply.code(201).send({ created: created.length });
    },
  });

  // DELETE /:id
  app.delete("/:id", {
    schema: { tags: ["Schichtplanung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      await app.prisma.shift.delete({ where: { id } });
      return reply.code(204).send();
    },
  });
}
