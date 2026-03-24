import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";

const shutdownBodySchema = z.object({
  name:                z.string().min(1).max(100),
  startDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deductsFromVacation: z.boolean().default(true),
  notes:               z.string().optional(),
});

export async function companyShutdownRoutes(app: FastifyInstance) {
  // ── GET /company-shutdowns ──────────────────────────────────────────────────
  app.get("/", { preHandler: requireAuth }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string;
    const { year } = req.query as { year?: string };

    const where: any = { tenantId };
    if (year) {
      const y = parseInt(year);
      where.OR = [
        { startDate: { gte: new Date(`${y}-01-01`), lte: new Date(`${y}-12-31`) } },
        { endDate:   { gte: new Date(`${y}-01-01`), lte: new Date(`${y}-12-31`) } },
      ];
    }

    const shutdowns = await app.prisma.companyShutdown.findMany({
      where,
      orderBy: { startDate: "asc" },
      include: {
        exceptions: {
          include: {
            employee: {
              select: { id: true, firstName: true, lastName: true, employeeNumber: true },
            },
          },
        },
      },
    });

    return shutdowns;
  });

  // ── POST /company-shutdowns ─────────────────────────────────────────────────
  app.post("/", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string;
    const body = shutdownBodySchema.parse(req.body);

    if (body.startDate > body.endDate) {
      return reply.status(400).send({ message: "startDate muss vor endDate liegen" });
    }

    const shutdown = await app.prisma.companyShutdown.create({
      data: {
        tenantId,
        name:                body.name,
        startDate:           new Date(body.startDate),
        endDate:             new Date(body.endDate),
        deductsFromVacation: body.deductsFromVacation,
        notes:               body.notes ?? null,
      },
      include: { exceptions: true },
    });

    return reply.status(201).send(shutdown);
  });

  // ── PATCH /company-shutdowns/:id ────────────────────────────────────────────
  app.patch("/:id", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string;
    const { id }   = req.params as { id: string };
    const body     = shutdownBodySchema.partial().parse(req.body);

    const existing = await app.prisma.companyShutdown.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ message: "Nicht gefunden" });

    const updated = await app.prisma.companyShutdown.update({
      where: { id },
      data: {
        ...(body.name                !== undefined && { name:                body.name }),
        ...(body.startDate           !== undefined && { startDate:           new Date(body.startDate) }),
        ...(body.endDate             !== undefined && { endDate:             new Date(body.endDate) }),
        ...(body.deductsFromVacation !== undefined && { deductsFromVacation: body.deductsFromVacation }),
        ...(body.notes               !== undefined && { notes:               body.notes }),
      },
      include: { exceptions: { include: { employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } } } } },
    });

    return updated;
  });

  // ── DELETE /company-shutdowns/:id ───────────────────────────────────────────
  app.delete("/:id", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string;
    const { id }   = req.params as { id: string };

    const existing = await app.prisma.companyShutdown.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.status(404).send({ message: "Nicht gefunden" });

    await app.prisma.companyShutdown.delete({ where: { id } });
    return reply.status(204).send();
  });

  // ── POST /company-shutdowns/:id/exceptions ──────────────────────────────────
  // Mitarbeiter zur Ausnahmeliste hinzufügen
  app.post("/:id/exceptions", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const tenantId   = (req as any).tenantId as string;
    const { id }     = req.params as { id: string };
    const { employeeId, reason } = req.body as { employeeId: string; reason?: string };

    const shutdown = await app.prisma.companyShutdown.findFirst({ where: { id, tenantId } });
    if (!shutdown) return reply.status(404).send({ message: "Betriebsurlaub nicht gefunden" });

    const employee = await app.prisma.employee.findFirst({ where: { id: employeeId, tenantId } });
    if (!employee) return reply.status(404).send({ message: "Mitarbeiter nicht gefunden" });

    const exception = await app.prisma.companyShutdownException.upsert({
      where:  { shutdownId_employeeId: { shutdownId: id, employeeId } },
      create: { shutdownId: id, employeeId, reason: reason ?? null },
      update: { reason: reason ?? null },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
      },
    });

    return reply.status(201).send(exception);
  });

  // ── DELETE /company-shutdowns/:id/exceptions/:employeeId ────────────────────
  // Ausnahme entfernen
  app.delete("/:id/exceptions/:employeeId", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const tenantId   = (req as any).tenantId as string;
    const { id, employeeId } = req.params as { id: string; employeeId: string };

    const shutdown = await app.prisma.companyShutdown.findFirst({ where: { id, tenantId } });
    if (!shutdown) return reply.status(404).send({ message: "Betriebsurlaub nicht gefunden" });

    await app.prisma.companyShutdownException.deleteMany({
      where: { shutdownId: id, employeeId },
    });

    return reply.status(204).send();
  });
}
