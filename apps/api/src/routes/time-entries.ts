import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { TimeEntrySource } from "@clokr/db";
import { checkArbZG } from "../utils/arbzg";

const clockInSchema = z.object({
  employeeId: z.string().uuid().optional(), // optional: Manager kann für andere stempeln
  nfcCardId: z.string().optional(),
  source: z.nativeEnum(TimeEntrySource).default("MANUAL"),
  note: z.string().optional(),
});

const clockOutSchema = z.object({
  breakMinutes: z.number().int().min(0).default(0),
  note: z.string().optional(),
});

const manualEntrySchema = z.object({
  employeeId: z.string().uuid().optional(), // optional: fällt auf eigene ID zurück
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional().nullable(),
  breakMinutes: z.number().int().min(0).default(0),
  note: z.string().optional().nullable(),
  source: z.nativeEnum(TimeEntrySource).default("MANUAL"),
});

const updateEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional().nullable(),
  breakMinutes: z.number().int().min(0).optional(),
  note: z.string().optional().nullable(),
  type: z.string().optional(),
});

// ── Überlappungsprüfung ────────────────────────────────────────────────────────
async function checkOverlap(
  app: FastifyInstance,
  employeeId: string,
  startTime: Date,
  endTime: Date | null,
  excludeId?: string
): Promise<string | null> {
  // Kein endTime = offener Eintrag → als "läuft noch" behandeln
  const effectiveEnd = endTime ?? new Date("9999-12-31");

  const overlapping = await app.prisma.timeEntry.findFirst({
    where: {
      employeeId,
      id: excludeId ? { not: excludeId } : undefined,
      startTime: { lt: effectiveEnd },
      OR: [
        { endTime: null },                        // aktiver Eintrag läuft noch
        { endTime: { gt: startTime } },           // abgeschlossener Eintrag endet nach neuem Start
      ],
    },
  });

  if (!overlapping) return null;

  const fmt = (d: Date | null) =>
    d ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "läuft";
  return `Überschneidung mit bestehendem Eintrag (${fmt(overlapping.startTime)} – ${fmt(overlapping.endTime)})`;
}

export async function timeEntryRoutes(app: FastifyInstance) {
  // POST /api/v1/time-entries/clock-in
  app.post("/clock-in", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = clockInSchema.parse(req.body);
      const user = req.user;

      // NFC: Mitarbeiter anhand Karten-ID ermitteln
      let employeeId = body.employeeId ?? user.employeeId;
      if (body.nfcCardId) {
        const emp = await app.prisma.employee.findUnique({
          where: { nfcCardId: body.nfcCardId },
        });
        if (!emp) return reply.code(404).send({ error: "NFC Karte nicht gefunden" });
        employeeId = emp.id;
      }

      if (!employeeId) return reply.code(400).send({ error: "Mitarbeiter nicht gefunden" });

      // Prüfen ob bereits eingestempelt
      const activeEntry = await app.prisma.timeEntry.findFirst({
        where: { employeeId, endTime: null },
      });
      if (activeEntry) {
        return reply.code(409).send({ error: "Bereits eingestempelt", entryId: activeEntry.id });
      }

      const now = new Date();
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(now.toISOString().split("T")[0]),
          startTime: now,
          source: body.source,
          note: body.note,
        },
      });

      await app.audit({
        userId: user.sub,
        action: "CLOCK_IN",
        entity: "TimeEntry",
        entityId: entry.id,
        newValue: entry,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true, entry };
    },
  });

  // POST /api/v1/time-entries/:id/clock-out
  app.post("/:id/clock-out", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = clockOutSchema.parse(req.body);

      const entry = await app.prisma.timeEntry.findUnique({ where: { id } });
      if (!entry) return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      if (entry.endTime) return reply.code(409).send({ error: "Bereits ausgestempelt" });

      const now = new Date();
      const updated = await app.prisma.timeEntry.update({
        where: { id },
        data: {
          endTime: now,
          breakMinutes: body.breakMinutes,
          note: body.note,
        },
      });

      await updateOvertimeAccount(app, entry.employeeId);

      const warnings = await checkArbZG(app.prisma, entry.employeeId, entry.date);

      await app.audit({
        userId: req.user.sub,
        action: "CLOCK_OUT",
        entity: "TimeEntry",
        entityId: id,
        oldValue: entry,
        newValue: updated,
      });

      return { success: true, entry: updated, warnings };
    },
  });

  // GET /api/v1/time-entries  (eigene oder alle für Manager)
  app.get("/", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const { from, to, employeeId } = req.query as {
        from?: string;
        to?: string;
        employeeId?: string;
      };

      const user = req.user;
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);

      const entries = await app.prisma.timeEntry.findMany({
        where: {
          employeeId: isManager && employeeId ? employeeId : (user.employeeId ?? undefined),
          date: {
            gte: from ? new Date(from) : undefined,
            lte: to ? new Date(to) : undefined,
          },
        },
        include: { employee: { select: { firstName: true, lastName: true } } },
        orderBy: { date: "desc" },
      });

      return entries;
    },
  });

  // POST /api/v1/time-entries  (manuelle Erfassung)
  app.post("/", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = manualEntrySchema.parse(req.body);
      const user = req.user;
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);

      // Mitarbeiter ID ermitteln
      const employeeId = body.employeeId && isManager
        ? body.employeeId
        : (user.employeeId ?? undefined);

      if (!employeeId) return reply.code(400).send({ error: "Mitarbeiter nicht ermittelbar" });

      const newStart = new Date(body.startTime);
      const newEnd   = body.endTime ? new Date(body.endTime) : null;

      // Zeitvalidierung
      if (newEnd && newEnd <= newStart) {
        return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
      }

      // Überlappungsprüfung
      const overlap = await checkOverlap(app, employeeId, newStart, newEnd);
      if (overlap) return reply.code(409).send({ error: overlap });

      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(body.date),
          startTime: newStart,
          endTime: newEnd,
          breakMinutes: body.breakMinutes,
          note: body.note,
          source: "MANUAL",
          createdBy: user.sub,
        },
      });

      await updateOvertimeAccount(app, employeeId);

      const warnings = await checkArbZG(app.prisma, employeeId, new Date(body.date));

      await app.audit({
        userId: user.sub,
        action: "CREATE",
        entity: "TimeEntry",
        entityId: entry.id,
        newValue: entry,
      });

      return reply.code(201).send({ entry, warnings });
    },
  });

  // PUT /api/v1/time-entries/:id  (Eintrag bearbeiten)
  app.put("/:id", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = updateEntrySchema.parse(req.body);
      const user = req.user;
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);

      const existing = await app.prisma.timeEntry.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      // Nur eigene Einträge für normale Mitarbeiter
      if (!isManager && existing.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Überlappungsprüfung für geänderte Zeiten
      const updatedStart = body.startTime ? new Date(body.startTime) : existing.startTime;
      const updatedEnd   = "endTime" in body
        ? (body.endTime ? new Date(body.endTime as string) : null)
        : existing.endTime;

      if (updatedEnd && updatedEnd <= updatedStart) {
        return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
      }

      const overlap = await checkOverlap(app, existing.employeeId, updatedStart, updatedEnd, id);
      if (overlap) return reply.code(409).send({ error: overlap });

      // Patch-Objekt explizit aufbauen um TS-Spread-Probleme zu vermeiden
      const patch: Record<string, unknown> = { source: "CORRECTION" };
      if (body.date)                        patch.date         = new Date(body.date);
      if (body.startTime)                   patch.startTime    = new Date(body.startTime);
      if ("endTime" in body)                patch.endTime      = body.endTime ? new Date(body.endTime as string) : null;
      if (body.breakMinutes !== undefined)  patch.breakMinutes = body.breakMinutes;
      if ("note" in body)                   patch.note         = body.note ?? null;

      const updated = await app.prisma.timeEntry.update({
        where: { id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: patch as any,
      });

      await updateOvertimeAccount(app, existing.employeeId);

      const warnings = await checkArbZG(app.prisma, existing.employeeId, existing.date);

      await app.audit({
        userId: user.sub,
        action: "UPDATE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: existing,
        newValue: updated,
      });

      return { entry: updated, warnings };
    },
  });

  // DELETE /api/v1/time-entries/:id
  app.delete("/:id", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = req.user;
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);

      const existing = await app.prisma.timeEntry.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      if (!isManager && existing.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      await app.prisma.timeEntry.delete({ where: { id } });
      await updateOvertimeAccount(app, existing.employeeId);

      await app.audit({
        userId: user.sub,
        action: "DELETE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: existing,
      });

      return reply.code(204).send();
    },
  });
}

// ── Hilfsfunktion: Überstundensaldo berechnen (kalenderbasiert) ───────────────
export async function updateOvertimeAccount(app: FastifyInstance, employeeId: string) {
  // Arbeitsplan laden (mit Fallback auf Tenant-Defaults)
  const schedule = await getEffectiveSchedule(app, employeeId);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  // Tatsächlich gearbeitete Minuten dieses Monats
  const entries = await app.prisma.timeEntry.findMany({
    where: {
      employeeId,
      date:    { gte: monthStart, lte: monthEnd },
      endTime: { not: null },
      type:    "WORK",
    },
  });

  const workedMinutes = entries.reduce((sum, e) => {
    if (!e.endTime) return sum;
    return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
  }, 0);

  // Soll-Minuten: pro Kalendertag die jeweilige Tages-Soll-Zeit summieren
  const expectedMinutes = calcExpectedMinutes(schedule, monthStart, monthEnd);

  // Öffentliche Feiertage abziehen (als "freie Tage" gelten)
  const holidays = await app.prisma.publicHoliday.findMany({
    where: {
      tenant: { employees: { some: { id: employeeId } } },
      date: { gte: monthStart, lte: monthEnd },
    },
  });
  const holidayMinutes = holidays.reduce((sum, h) => {
    const dow = h.date.getDay();
    return sum + getDayHours(schedule, dow) * 60;
  }, 0);

  // Genehmigte Abwesenheiten abziehen (Urlaub, Krank, etc. reduzieren das Soll)
  const approvedLeave = await app.prisma.leaveRequest.findMany({
    where: {
      employeeId,
      status:    "APPROVED",
      startDate: { lte: monthEnd },
      endDate:   { gte: monthStart },
    },
  });
  const leaveMinutes = approvedLeave.reduce((sum, lr) => {
    return sum + calcExpectedMinutes(schedule,
      lr.startDate < monthStart ? monthStart : lr.startDate,
      lr.endDate   > monthEnd   ? monthEnd   : lr.endDate,
    );
  }, 0);

  const diffHours = (workedMinutes - Math.max(0, expectedMinutes - holidayMinutes - leaveMinutes)) / 60;

  // Saldo direkt setzen (nicht kumulieren – das passiert beim Monatsabschluss)
  const account = await app.prisma.overtimeAccount.upsert({
    where:  { employeeId },
    create: { employeeId, balanceHours: diffHours },
    update: { balanceHours: diffHours },
  });

  const threshold = Number(schedule.overtimeThreshold);
  if (Number(account.balanceHours) >= threshold) {
    app.log.warn(
      `⚠️  Mitarbeiter ${employeeId} hat ${account.balanceHours}h Überstunden (Threshold: ${threshold}h)`
    );
  }
}

// ── Effektiven Arbeitsplan ermitteln (Employee > TenantConfig > Hardcoded) ────
async function getEffectiveSchedule(app: FastifyInstance, employeeId: string) {
  const schedule = await app.prisma.workSchedule.findUnique({ where: { employeeId } });
  if (schedule) return schedule;

  // Fallback: Tenant-Config
  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const tenantConfig = employee
    ? await app.prisma.tenantConfig.findUnique({ where: { tenantId: employee.tenantId } })
    : null;

  // Synthetisches Schedule-Objekt aus Tenant-Defaults
  return {
    weeklyHours:    tenantConfig?.defaultWeeklyHours    ?? 40,
    mondayHours:    tenantConfig?.defaultMondayHours    ?? 8,
    tuesdayHours:   tenantConfig?.defaultTuesdayHours   ?? 8,
    wednesdayHours: tenantConfig?.defaultWednesdayHours ?? 8,
    thursdayHours:  tenantConfig?.defaultThursdayHours  ?? 8,
    fridayHours:    tenantConfig?.defaultFridayHours    ?? 8,
    saturdayHours:  tenantConfig?.defaultSaturdayHours  ?? 0,
    sundayHours:    tenantConfig?.defaultSundayHours    ?? 0,
    overtimeThreshold:   tenantConfig?.overtimeThreshold   ?? 60,
    allowOvertimePayout: tenantConfig?.allowOvertimePayout ?? false,
  };
}

// ── Soll-Minuten für einen Zeitraum berechnen (je Wochentag) ─────────────────
function calcExpectedMinutes(
  schedule: { mondayHours: unknown; tuesdayHours: unknown; wednesdayHours: unknown;
              thursdayHours: unknown; fridayHours: unknown; saturdayHours: unknown; sundayHours: unknown },
  from: Date,
  to: Date
): number {
  let total = 0;
  const current = new Date(from);
  while (current <= to) {
    total += getDayHours(schedule, current.getDay()) * 60;
    current.setDate(current.getDate() + 1);
  }
  return total;
}

function getDayHours(schedule: Record<string, unknown>, dow: number): number {
  const keys = ["sundayHours","mondayHours","tuesdayHours","wednesdayHours",
                "thursdayHours","fridayHours","saturdayHours"];
  return Number(schedule[keys[dow]] ?? 0);
}
