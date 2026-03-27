import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { getHolidays, FederalStateCode, STATE_MAP } from "../utils/holidays";

export async function holidayRoutes(app: FastifyInstance) {
  // GET /api/v1/holidays?year=2026
  // Berechnet Feiertage on-the-fly für das konfigurierte Bundesland des Tenants,
  // mergt zusätzlich manuell hinzugefügte Einträge aus der DB.
  app.get("/", {
    schema: { tags: ["Feiertage"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const { year } = req.query as { year?: string };
      const y = year ? parseInt(year) : new Date().getFullYear();

      // Bundesland des Tenants ermitteln
      const tenant =
        (await app.prisma.tenant.findFirst({
          where: { employees: { some: { userId: req.user.sub } } },
        })) ?? (await app.prisma.tenant.findFirst());

      const stateCode: FederalStateCode = tenant ? (STATE_MAP[tenant.federalState] ?? "NI") : "NI";

      // Berechnete Feiertage
      const computed = getHolidays(y, stateCode).map((h) => ({
        id: `computed-${h.date}`,
        tenantId: tenant?.id ?? "",
        date: h.date,
        name: h.name,
        federalState: tenant?.federalState ?? "NIEDERSACHSEN",
        year: y,
        isManual: false,
      }));

      // Manuelle Einträge aus der DB (vom Admin hinzugefügt)
      const start = new Date(y, 0, 1);
      const end = new Date(y, 11, 31);
      const manual = await app.prisma.publicHoliday.findMany({
        where: {
          tenantId: tenant?.id ?? req.user.tenantId,
          date: { gte: start, lte: end },
        },
        orderBy: { date: "asc" },
      });

      // Merge: manuelle überschreiben berechnete am selben Tag
      const manualDates = new Set(manual.map((m) => m.date.toISOString().split("T")[0]));
      const merged = [
        ...computed.filter((c) => !manualDates.has(c.date)),
        ...manual.map((m) => ({
          id: m.id,
          tenantId: m.tenantId,
          date: m.date.toISOString().split("T")[0],
          name: m.name,
          federalState: m.federalState,
          year: m.year,
          isManual: true,
        })),
      ].sort((a, b) => a.date.localeCompare(b.date));

      return merged;
    },
  });

  // POST /api/v1/holidays  – manuellen Feiertag hinzufügen
  app.post("/", {
    schema: { tags: ["Feiertage"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const schema = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        name: z.string().min(1).max(100),
      });
      const body = schema.parse(req.body);

      const tenant =
        (await app.prisma.tenant.findFirst({
          where: { employees: { some: { userId: req.user.sub } } },
        })) ?? (await app.prisma.tenant.findFirst());

      const holiday = await app.prisma.publicHoliday.create({
        data: {
          tenantId: req.user.tenantId,
          date: new Date(body.date),
          name: body.name,
          year: parseInt(body.date.slice(0, 4)),
          federalState: tenant?.federalState ?? "NIEDERSACHSEN",
        },
      });
      return reply.code(201).send({
        ...holiday,
        date: holiday.date.toISOString().split("T")[0],
        isManual: true,
      });
    },
  });

  // DELETE /api/v1/holidays/:id  – nur manuelle Einträge löschbar
  app.delete("/:id", {
    schema: { tags: ["Feiertage"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await app.prisma.publicHoliday.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      await app.prisma.publicHoliday.deleteMany({
        where: { id, tenantId: req.user.tenantId },
      });
      await app.audit({
        userId: req.user.sub,
        action: "DELETE",
        entity: "PublicHoliday",
        entityId: id,
        oldValue: existing,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return reply.code(204).send();
    },
  });
}
