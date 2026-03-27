import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { updateOvertimeAccount } from "./time-entries";

const createPlanSchema = z.object({
  employeeId: z.string().uuid(),
  hoursToReduce: z.number().positive(),
  deadline: z.string().datetime(),
  note: z.string().optional(),
});

const payoutSchema = z.object({
  employeeId: z.string().uuid(),
  hours: z.number().positive(),
  note: z.string().optional(),
});

export async function overtimeRoutes(app: FastifyInstance) {
  // GET /api/v1/overtime/:employeeId  – Kontostand
  app.get("/:employeeId", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };

      // Recalculate balance on every read to ensure fresh data
      await updateOvertimeAccount(app, employeeId).catch(() => {});

      const account = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId },
        include: {
          transactions: { orderBy: { createdAt: "desc" }, take: 20 },
        },
      });

      if (!account) return reply.code(404).send({ error: "Konto nicht gefunden" });

      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId, validFrom: { lte: new Date() } },
        orderBy: { validFrom: "desc" },
      });
      const threshold = Number(schedule?.overtimeThreshold ?? 60);
      const balance = Number(account.balanceHours);

      return {
        ...account,
        status:
          balance >= threshold ? "CRITICAL" : balance >= threshold * 0.67 ? "ELEVATED" : "NORMAL",
        threshold,
      };
    },
  });

  // POST /api/v1/overtime/plans  – Abbauplan erstellen
  app.post("/plans", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = createPlanSchema.parse(req.body);

      const plan = await app.prisma.overtimePlan.create({
        data: {
          employeeId: body.employeeId,
          hoursToReduce: body.hoursToReduce,
          deadline: new Date(body.deadline),
          note: body.note,
          createdBy: req.user.sub,
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "OvertimePlan",
        entityId: plan.id,
        newValue: plan,
      });

      return reply.code(201).send(plan);
    },
  });

  // POST /api/v1/overtime/payout  – Auszahlung beantragen
  app.post("/payout", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const body = payoutSchema.parse(req.body);

      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId: body.employeeId, validFrom: { lte: new Date() } },
        orderBy: { validFrom: "desc" },
      });

      if (!schedule?.allowOvertimePayout) {
        return reply.code(400).send({ error: "Auszahlung für diesen Mitarbeiter nicht erlaubt" });
      }

      const account = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: body.employeeId },
      });

      if (!account || Number(account.balanceHours) < body.hours) {
        return reply.code(400).send({ error: "Nicht genug Überstunden auf dem Konto" });
      }

      const [updatedAccount, transaction] = await app.prisma.$transaction([
        app.prisma.overtimeAccount.update({
          where: { employeeId: body.employeeId },
          data: { balanceHours: { decrement: body.hours } },
        }),
        app.prisma.overtimeTransaction.create({
          data: {
            overtimeAccountId: account.id,
            hours: -body.hours,
            type: "PAYOUT",
            description: body.note ?? `Auszahlung ${body.hours}h`,
            createdBy: req.user.sub,
          },
        }),
      ]);

      await app.audit({
        userId: req.user.sub,
        action: "PAYOUT",
        entity: "OvertimeAccount",
        entityId: account.id,
        newValue: { hours: body.hours, transaction },
      });

      return { success: true, newBalance: Number(updatedAccount.balanceHours) };
    },
  });
}
