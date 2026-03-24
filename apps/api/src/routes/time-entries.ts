import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { TimeEntrySource } from "@clokr/db";
import { checkArbZG } from "../utils/arbzg";
import {
  getTenantTimezone,
  todayInTz,
  dateStrInTz,
  monthRangeUtc,
  calcExpectedMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "../utils/timezone";

const nfcPunchSchema = z.object({
  nfcCardId: z.string().min(1),
  terminalSecret: z.string().optional(),
});

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
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
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
  excludeId?: string,
): Promise<string | null> {
  // Kein endTime = offener Eintrag → als "läuft noch" behandeln
  const effectiveEnd = endTime ?? new Date("9999-12-31");

  const overlapping = await app.prisma.timeEntry.findFirst({
    where: {
      employeeId,
      id: excludeId ? { not: excludeId } : undefined,
      startTime: { lt: effectiveEnd },
      OR: [
        { endTime: null }, // aktiver Eintrag läuft noch
        { endTime: { gt: startTime } }, // abgeschlossener Eintrag endet nach neuem Start
      ],
    },
  });

  if (!overlapping) return null;

  const fmt = (d: Date | null) =>
    d ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "läuft";
  return `Überschneidung mit bestehendem Eintrag (${fmt(overlapping.startTime)} – ${fmt(overlapping.endTime)})`;
}

export async function timeEntryRoutes(app: FastifyInstance) {
  // POST /api/v1/time-entries/nfc-punch  (kein JWT – Terminal-Gerät)
  app.post("/nfc-punch", {
    schema: { tags: ["Zeiterfassung"] },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      const body = nfcPunchSchema.parse(req.body);

      // Optionale Terminal-Authentifizierung
      const secret = process.env.NFC_TERMINAL_SECRET;
      if (secret && body.terminalSecret !== secret) {
        return reply.code(403).send({ error: "Ungültiges Terminal-Secret" });
      }

      // Mitarbeiter anhand NFC-Karten-ID ermitteln
      const employee = await app.prisma.employee.findUnique({
        where: { nfcCardId: body.nfcCardId },
        include: { tenant: true, user: true },
      });
      if (!employee) {
        return reply.code(404).send({ error: "Unbekannte Karte" });
      }
      if (!employee.user.isActive) {
        return reply.code(403).send({ error: "Mitarbeiter ist deaktiviert" });
      }

      const now = new Date();
      const tz = await getTenantTimezone(app.prisma, employee.tenantId);
      const today = todayInTz(tz);

      // Offenen Eintrag von heute suchen
      const openEntry = await app.prisma.timeEntry.findFirst({
        where: {
          employeeId: employee.id,
          date: today,
          endTime: null,
        },
      });

      if (openEntry) {
        // Ausstempeln
        const updated = await app.prisma.timeEntry.update({
          where: { id: openEntry.id },
          data: { endTime: now },
        });

        await updateOvertimeAccount(app, employee.id);

        await app.audit({
          action: "NFC_CLOCK_OUT",
          entity: "TimeEntry",
          entityId: updated.id,
          oldValue: openEntry,
          newValue: updated,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });

        return {
          action: "OUT" as const,
          employee: {
            firstName: employee.firstName,
            lastName: employee.lastName,
            employeeNumber: employee.employeeNumber,
          },
          time: now.toISOString(),
        };
      }

      // Einstempeln
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: employee.id,
          date: today,
          startTime: now,
          source: "NFC",
        },
      });

      await app.audit({
        action: "NFC_CLOCK_IN",
        entity: "TimeEntry",
        entityId: entry.id,
        newValue: entry,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return {
        action: "IN" as const,
        employee: {
          firstName: employee.firstName,
          lastName: employee.lastName,
          employeeNumber: employee.employeeNumber,
        },
        time: now.toISOString(),
      };
    },
  });

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

      // Prüfen ob Mitarbeiter aktiv ist
      const employeeRecord = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        include: { user: true },
      });
      if (employeeRecord && !employeeRecord.user.isActive) {
        return reply.code(403).send({ error: "Mitarbeiter ist deaktiviert" });
      }

      // Prüfen ob bereits eingestempelt
      const activeEntry = await app.prisma.timeEntry.findFirst({
        where: { employeeId, endTime: null },
      });
      if (activeEntry) {
        return reply.code(409).send({ error: "Bereits eingestempelt", entryId: activeEntry.id });
      }

      const now = new Date();
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: todayInTz(tz),
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
      const employeeId =
        body.employeeId && isManager ? body.employeeId : (user.employeeId ?? undefined);

      if (!employeeId) return reply.code(400).send({ error: "Mitarbeiter nicht ermittelbar" });

      // Prüfen ob Mitarbeiter aktiv ist
      const targetEmployee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        include: { user: true },
      });
      if (targetEmployee && !targetEmployee.user.isActive) {
        return reply.code(403).send({ error: "Mitarbeiter ist deaktiviert" });
      }

      // Prüfen ob das Datum vor dem Eintrittsdatum liegt
      if (targetEmployee?.hireDate) {
        const entryDate = new Date(body.date);
        const hireDate = new Date(targetEmployee.hireDate);
        // Vergleich nur auf Tagesbasis (ohne Uhrzeit)
        const entryDay = new Date(
          entryDate.getFullYear(),
          entryDate.getMonth(),
          entryDate.getDate(),
        );
        const hireDay = new Date(hireDate.getFullYear(), hireDate.getMonth(), hireDate.getDate());
        if (entryDay < hireDay) {
          return reply
            .code(400)
            .send({ error: "Zeiteinträge vor dem Eintrittsdatum sind nicht erlaubt" });
        }
      }

      const newStart = new Date(body.startTime);
      const newEnd = body.endTime ? new Date(body.endTime) : null;

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

      // Prüfen ob das neue Datum vor dem Eintrittsdatum liegt
      if (body.date) {
        const targetEmployee = await app.prisma.employee.findUnique({
          where: { id: existing.employeeId },
          select: { hireDate: true },
        });
        if (targetEmployee?.hireDate) {
          const entryDate = new Date(body.date);
          const hireDate = new Date(targetEmployee.hireDate);
          const entryDay = new Date(
            entryDate.getFullYear(),
            entryDate.getMonth(),
            entryDate.getDate(),
          );
          const hireDay = new Date(hireDate.getFullYear(), hireDate.getMonth(), hireDate.getDate());
          if (entryDay < hireDay) {
            return reply
              .code(400)
              .send({ error: "Zeiteinträge vor dem Eintrittsdatum sind nicht erlaubt" });
          }
        }
      }

      // Überlappungsprüfung für geänderte Zeiten
      const updatedStart = body.startTime ? new Date(body.startTime) : existing.startTime;
      const updatedEnd =
        "endTime" in body
          ? body.endTime
            ? new Date(body.endTime as string)
            : null
          : existing.endTime;

      if (updatedEnd && updatedEnd <= updatedStart) {
        return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
      }

      const overlap = await checkOverlap(app, existing.employeeId, updatedStart, updatedEnd, id);
      if (overlap) return reply.code(409).send({ error: overlap });

      // Patch-Objekt explizit aufbauen um TS-Spread-Probleme zu vermeiden
      const patch: Record<string, unknown> = { source: "CORRECTION" };
      if (body.date) patch.date = new Date(body.date);
      if (body.startTime) patch.startTime = new Date(body.startTime);
      if ("endTime" in body) patch.endTime = body.endTime ? new Date(body.endTime as string) : null;
      if (body.breakMinutes !== undefined) patch.breakMinutes = body.breakMinutes;
      if ("note" in body) patch.note = body.note ?? null;

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

// ── Hilfsfunktion: Überstundensaldo berechnen (kalenderbasiert, TZ-aware) ────
export async function updateOvertimeAccount(app: FastifyInstance, employeeId: string) {
  const schedule = await getEffectiveSchedule(app, employeeId);

  // Tenant-Timezone laden + hireDate
  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true, hireDate: true },
  });
  const tz = await getTenantTimezone(app.prisma, employee?.tenantId ?? "");

  // Aktuellen Monat in Tenant-TZ berechnen
  const now = new Date();
  const zonedNow = new Date(dateStrInTz(now, tz) + "T12:00:00Z"); // Mitte des Tages für Monat-Bestimmung
  const { start: monthStart, end: monthEnd } = monthRangeUtc(
    zonedNow.getUTCFullYear(),
    zonedNow.getUTCMonth() + 1,
    tz,
  );

  // Tatsächlich gearbeitete Minuten dieses Monats
  const entries = await app.prisma.timeEntry.findMany({
    where: {
      employeeId,
      date: { gte: monthStart, lte: monthEnd },
      endTime: { not: null },
      type: "WORK",
    },
  });

  const workedMinutes = entries.reduce((sum, e) => {
    if (!e.endTime) return sum;
    return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
  }, 0);

  // Soll-Minuten (TZ-aware Wochentag-Zuordnung), nur bis heute, Tage vor hireDate überspringen
  const effectiveStart =
    employee?.hireDate && employee.hireDate > monthStart ? employee.hireDate : monthStart;
  const today = new Date(dateStrInTz(now, tz) + "T23:59:59Z");
  const effectiveEnd = today < monthEnd ? today : monthEnd;
  const expectedMinutes = calcExpectedMinutesTz(schedule, effectiveStart, effectiveEnd, tz);

  // Öffentliche Feiertage abziehen
  const holidays = await app.prisma.publicHoliday.findMany({
    where: {
      tenant: { employees: { some: { id: employeeId } } },
      date: { gte: monthStart, lte: effectiveEnd },
    },
  });
  const holidayMinutes = holidays.reduce((sum, h) => {
    if (employee?.hireDate && h.date < employee.hireDate) return sum;
    const dow = getDayOfWeekInTz(h.date, tz);
    return sum + getDayHoursFromSchedule(schedule, dow) * 60;
  }, 0);

  // Genehmigte Abwesenheiten abziehen
  const approvedLeave = await app.prisma.leaveRequest.findMany({
    where: {
      employeeId,
      status: "APPROVED",
      startDate: { lte: effectiveEnd },
      endDate: { gte: monthStart },
    },
  });
  const leaveMinutes = approvedLeave.reduce((sum, lr) => {
    return (
      sum +
      calcExpectedMinutesTz(
        schedule,
        lr.startDate < monthStart ? monthStart : lr.startDate,
        lr.endDate > effectiveEnd ? effectiveEnd : lr.endDate,
        tz,
      )
    );
  }, 0);

  const diffHours =
    (workedMinutes - Math.max(0, expectedMinutes - holidayMinutes - leaveMinutes)) / 60;

  const account = await app.prisma.overtimeAccount.upsert({
    where: { employeeId },
    create: { employeeId, balanceHours: diffHours },
    update: { balanceHours: diffHours },
  });

  const threshold = Number(schedule.overtimeThreshold);
  if (Number(account.balanceHours) >= threshold) {
    app.log.warn(
      `⚠️  Mitarbeiter ${employeeId} hat ${account.balanceHours}h Überstunden (Threshold: ${threshold}h)`,
    );
  }
}

// ── Effektiven Arbeitsplan ermitteln (Employee > TenantConfig > Hardcoded) ────
export async function getEffectiveSchedule(app: FastifyInstance, employeeId: string) {
  const schedule = await app.prisma.workSchedule.findUnique({ where: { employeeId } });
  if (schedule) return schedule;

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const tenantConfig = employee
    ? await app.prisma.tenantConfig.findUnique({ where: { tenantId: employee.tenantId } })
    : null;

  return {
    weeklyHours: tenantConfig?.defaultWeeklyHours ?? 40,
    mondayHours: tenantConfig?.defaultMondayHours ?? 8,
    tuesdayHours: tenantConfig?.defaultTuesdayHours ?? 8,
    wednesdayHours: tenantConfig?.defaultWednesdayHours ?? 8,
    thursdayHours: tenantConfig?.defaultThursdayHours ?? 8,
    fridayHours: tenantConfig?.defaultFridayHours ?? 8,
    saturdayHours: tenantConfig?.defaultSaturdayHours ?? 0,
    sundayHours: tenantConfig?.defaultSundayHours ?? 0,
    overtimeThreshold: tenantConfig?.overtimeThreshold ?? 60,
    allowOvertimePayout: tenantConfig?.allowOvertimePayout ?? false,
  };
}
