import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { updateOvertimeAccount, getEffectiveSchedule } from "./time-entries";
import {
  getTenantTimezone,
  dateStrInTz,
  monthRangeUtc,
  calcExpectedMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "../utils/timezone";

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

  // ── Monatsabschluss ──────────────────────────────────────────────────────────

  const closeMonthSchema = z.object({
    employeeId: z.string().uuid(),
    year: z.number().int().min(2020).max(2099),
    month: z.number().int().min(1).max(12),
  });

  // POST /api/v1/overtime/close-month  – Monat abschließen (Snapshot erzeugen)
  app.post("/close-month", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId, year, month } = closeMonthSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true, hireDate: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const tz = await getTenantTimezone(app.prisma, employee.tenantId);
      const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);

      // Check if snapshot already exists
      const existing = await app.prisma.saldoSnapshot.findUnique({
        where: {
          employeeId_periodType_periodStart: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: monthStart,
          },
        },
      });
      if (existing) {
        return reply.code(409).send({ error: "Monat ist bereits abgeschlossen" });
      }

      // Don't allow closing future months
      const now = new Date();
      if (monthEnd > now) {
        return reply
          .code(400)
          .send({ error: "Zukünftige Monate können nicht abgeschlossen werden" });
      }

      const schedule = await getEffectiveSchedule(app, employeeId);

      // Calculate worked minutes for the month
      const entries = await app.prisma.timeEntry.findMany({
        where: {
          employeeId,
          deletedAt: null,
          date: { gte: monthStart, lte: monthEnd },
          endTime: { not: null },
          type: "WORK",
          isInvalid: false,
        },
      });

      const workedMinutes = entries.reduce((sum, e) => {
        if (!e.endTime) return sum;
        return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
      }, 0);

      // Calculate expected minutes
      const hireDateNorm = employee.hireDate
        ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
        : null;
      const effectiveStart = hireDateNorm && hireDateNorm > monthStart ? hireDateNorm : monthStart;
      const expectedMinutes = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);

      // Subtract holidays
      const holidays = await app.prisma.publicHoliday.findMany({
        where: {
          tenant: { employees: { some: { id: employeeId } } },
          date: { gte: effectiveStart, lte: monthEnd },
        },
      });
      const holidayMinutes = holidays.reduce((sum, h) => {
        const dow = getDayOfWeekInTz(h.date, tz);
        return sum + getDayHoursFromSchedule(schedule, dow) * 60;
      }, 0);

      // Subtract approved leave
      const approvedLeave = await app.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          status: "APPROVED",
          startDate: { lte: monthEnd },
          endDate: { gte: monthStart },
        },
      });
      const leaveMinutes = approvedLeave.reduce((sum, lr) => {
        const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
        const leaveEnd = lr.endDate > monthEnd ? monthEnd : lr.endDate;
        if (leaveStart > leaveEnd) return sum;
        return sum + calcExpectedMinutesTz(schedule, leaveStart, leaveEnd, tz);
      }, 0);

      const netExpected = Math.max(0, expectedMinutes - holidayMinutes - leaveMinutes);
      const balanceMinutes = Math.round(workedMinutes - netExpected);

      // Get previous month's carry-over
      const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
        where: { employeeId, periodType: "MONTHLY", periodStart: { lt: monthStart } },
        orderBy: { periodStart: "desc" },
      });
      const prevCarryOver = prevSnapshot?.carryOver ?? 0;
      const carryOver = prevCarryOver + balanceMinutes;

      // Create snapshot + lock entries
      const snapshot = await app.prisma.$transaction(async (tx) => {
        const snap = await tx.saldoSnapshot.create({
          data: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: monthStart,
            periodEnd: monthEnd,
            workedMinutes: Math.round(workedMinutes),
            expectedMinutes: Math.round(netExpected),
            balanceMinutes,
            carryOver,
            closedAt: new Date(),
            closedBy: req.user.sub,
          },
        });

        // Lock all time entries in this month
        await tx.timeEntry.updateMany({
          where: {
            employeeId,
            deletedAt: null,
            date: { gte: monthStart, lte: monthEnd },
          },
          data: { isLocked: true, lockedAt: new Date() },
        });

        return snap;
      });

      // Update overtime account with new carry-over
      await app.prisma.overtimeAccount.upsert({
        where: { employeeId },
        create: { employeeId, balanceHours: carryOver / 60 },
        update: { balanceHours: carryOver / 60 },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "SaldoSnapshot",
        entityId: snapshot.id,
        newValue: snapshot,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(201).send(snapshot);
    },
  });

  // GET /api/v1/overtime/snapshots/:employeeId  – Alle Snapshots abrufen
  app.get("/snapshots/:employeeId", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const { employeeId } = req.params as { employeeId: string };
      const snapshots = await app.prisma.saldoSnapshot.findMany({
        where: { employeeId },
        orderBy: { periodStart: "desc" },
      });
      return snapshots;
    },
  });

  // ── Jahresübertrag ───────────────────────────────────────────────────────────

  const closeYearSchema = z.object({
    employeeId: z.string().uuid(),
    year: z.number().int().min(2020).max(2099),
  });

  // POST /api/v1/overtime/close-year  – Jahresübertrag erstellen
  app.post("/close-year", {
    schema: { tags: ["Überstunden"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { employeeId, year } = closeYearSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const tz = await getTenantTimezone(app.prisma, employee.tenantId);

      // Year range
      const yearStart = new Date(`${year}-01-01T00:00:00Z`);
      const yearEnd = new Date(`${year}-12-31T23:59:59Z`);

      if (yearEnd > new Date()) {
        return reply.code(400).send({ error: "Laufendes Jahr kann nicht abgeschlossen werden" });
      }

      // Check if yearly snapshot already exists
      const existing = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId,
          periodType: "YEARLY",
          periodStart: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-01-02`) },
        },
      });
      if (existing) {
        return reply.code(409).send({ error: "Jahr ist bereits abgeschlossen" });
      }

      // Check all 12 months are closed
      const monthSnapshots = await app.prisma.saldoSnapshot.findMany({
        where: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: { gte: yearStart, lte: yearEnd },
        },
        orderBy: { periodStart: "asc" },
      });

      if (monthSnapshots.length < 12) {
        const closedMonths = monthSnapshots.map((s) => new Date(s.periodStart).getUTCMonth() + 1);
        const missing = Array.from({ length: 12 }, (_, i) => i + 1).filter(
          (m) => !closedMonths.includes(m),
        );
        return reply.code(400).send({
          error: `Nicht alle Monate abgeschlossen. Fehlend: ${missing.join(", ")}`,
        });
      }

      // Calculate yearly totals from monthly snapshots
      const yearWorked = monthSnapshots.reduce((s, m) => s + m.workedMinutes, 0);
      const yearExpected = monthSnapshots.reduce((s, m) => s + m.expectedMinutes, 0);
      const yearBalance = monthSnapshots.reduce((s, m) => s + m.balanceMinutes, 0);

      // Last month's carryOver = cumulative balance through year-end
      const decemberSnapshot = monthSnapshots[monthSnapshots.length - 1];
      const finalCarryOver = decemberSnapshot.carryOver;

      // Apply carry-over rules from tenant config
      const tenantConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: employee.tenantId },
      });
      const mode = tenantConfig?.overtimeCarryOverMode ?? "FULL";
      const cap = tenantConfig?.overtimeCarryOverCap;

      let appliedCarryOver = finalCarryOver;
      if (mode === "RESET") {
        appliedCarryOver = 0;
      } else if (mode === "CAPPED" && cap != null && finalCarryOver > cap) {
        appliedCarryOver = cap;
      }
      // FULL: keep everything

      const snapshot = await app.prisma.saldoSnapshot.create({
        data: {
          employeeId,
          periodType: "YEARLY",
          periodStart: yearStart,
          periodEnd: yearEnd,
          workedMinutes: yearWorked,
          expectedMinutes: yearExpected,
          balanceMinutes: yearBalance,
          carryOver: appliedCarryOver,
          closedAt: new Date(),
          closedBy: req.user.sub,
          note:
            mode === "RESET"
              ? "Jahresübertrag: Reset auf 0"
              : mode === "CAPPED" && cap != null && finalCarryOver > cap
                ? `Jahresübertrag: gedeckelt auf ${Math.round(cap / 60)}h (${Math.round(finalCarryOver / 60)}h verfallen)`
                : `Jahresübertrag: ${Math.round(appliedCarryOver / 60)}h`,
        },
      });

      // Update overtime account with the applied carry-over
      await app.prisma.overtimeAccount.upsert({
        where: { employeeId },
        create: { employeeId, balanceHours: appliedCarryOver / 60 },
        update: { balanceHours: appliedCarryOver / 60 },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "SaldoSnapshot",
        entityId: snapshot.id,
        newValue: { ...snapshot, mode, originalCarryOver: finalCarryOver },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(201).send(snapshot);
    },
  });
}
