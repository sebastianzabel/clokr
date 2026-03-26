import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
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

const breakSlotSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
});

const manualEntrySchema = z.object({
  employeeId: z.string().uuid().optional(), // optional: fällt auf eigene ID zurück
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional().nullable(),
  breakMinutes: z.number().int().min(0).default(0),
  note: z.string().optional().nullable(),
  source: z.nativeEnum(TimeEntrySource).default("MANUAL"),
  breaks: z.array(breakSlotSchema).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const updateEntrySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum")
    .optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional().nullable(),
  breakMinutes: z.number().int().min(0).optional(),
  note: z.string().optional().nullable(),
  type: z.string().optional(),
  breaks: z.array(breakSlotSchema).optional(),
});

// ── Pausen-Minuten aus Break-Slots berechnen ──────────────────────────────────
function calcBreakMinutes(breaks: { startTime: Date; endTime: Date }[]): number {
  return breaks.reduce((sum, b) => sum + (b.endTime.getTime() - b.startTime.getTime()) / 60000, 0);
}

// ── Break-Slot-Validierung ──────────────────────────────────────────────────
function validateBreakSlots(
  breakSlots: { startTime: Date; endTime: Date }[],
  workStart: Date,
  workEnd: Date | null,
): string | null {
  for (const b of breakSlots) {
    if (b.endTime <= b.startTime) {
      return "Pausenende muss nach Pausenbeginn liegen";
    }
    if (workEnd) {
      if (b.startTime < workStart || b.endTime > workEnd) {
        return "Pausen müssen innerhalb der Arbeitszeit liegen";
      }
    } else {
      if (b.startTime < workStart) {
        return "Pausenbeginn darf nicht vor der Startzeit liegen";
      }
    }
  }
  // Check for overlapping breaks
  const sorted = [...breakSlots].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startTime < sorted[i - 1].endTime) {
      return "Pausen dürfen sich nicht überschneiden";
    }
  }
  return null;
}

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

/** § 8 BUrlG: Prüft ob genehmigter Urlaub oder Abwesenheit an dem Tag vorliegt */
async function hasApprovedLeaveOnDate(
  prisma: any,
  employeeId: string,
  dateStr: string,
): Promise<string | null> {
  const leave = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      status: "APPROVED",
      startDate: { lte: new Date(dateStr + "T23:59:59Z") },
      endDate: { gte: new Date(dateStr + "T00:00:00Z") },
    },
    include: { leaveType: { select: { name: true } } },
  });
  if (leave) return leave.leaveType.name;

  const absence = await prisma.absence.findFirst({
    where: {
      employeeId,
      startDate: { lte: new Date(dateStr + "T23:59:59Z") },
      endDate: { gte: new Date(dateStr + "T00:00:00Z") },
      type: { in: ["MATERNITY", "PARENTAL"] },
    },
  });
  if (absence) return absence.type === "MATERNITY" ? "Mutterschutz" : "Elternzeit";

  return null;
}

export async function timeEntryRoutes(app: FastifyInstance) {
  // POST /api/v1/time-entries/nfc-punch  (kein JWT – Terminal-Gerät)
  app.post("/nfc-punch", {
    schema: { tags: ["Zeiterfassung"] },
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      const body = nfcPunchSchema.parse(req.body);

      // Extract API key from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "Terminal API Key erforderlich" });
      }
      const rawKey = authHeader.slice(7);
      const keyHash = createHash("sha256").update(rawKey).digest("hex");

      const apiKey = await app.prisma.terminalApiKey.findUnique({
        where: { keyHash },
      });
      if (!apiKey || apiKey.revokedAt) {
        return reply.code(401).send({ error: "Ungültiger oder widerrufener API Key" });
      }

      const tenantId = apiKey.tenantId;

      // Update lastUsedAt (fire and forget)
      app.prisma.terminalApiKey
        .update({
          where: { id: apiKey.id },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => {});

      // Mitarbeiter anhand NFC-Karten-ID ermitteln
      const employee = await app.prisma.employee.findFirst({
        where: { nfcCardId: body.nfcCardId, tenantId },
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
      const todayStr = dateStrInTz(now, tz);

      // Offenen Eintrag suchen + clock-in/out in einer Transaktion (Race-Condition vermeiden)
      const txResult = await app.prisma.$transaction(async (tx) => {
        const openEntry = await tx.timeEntry.findFirst({
          where: {
            employeeId: employee.id,
            date: today,
            endTime: null,
          },
        });

        if (openEntry) {
          // Ausstempeln
          const updated = await tx.timeEntry.update({
            where: { id: openEntry.id },
            data: { endTime: now },
            include: { breaks: { orderBy: { startTime: "asc" } } },
          });

          // Check for break gap: if there was a previous completed entry today
          // that ended within 2h of when this open entry started, treat the gap as a break
          const previousEntry = await tx.timeEntry.findFirst({
            where: {
              employeeId: employee.id,
              date: today,
              id: { not: openEntry.id },
              endTime: { not: null },
            },
            orderBy: { endTime: "desc" },
          });

          if (previousEntry && previousEntry.endTime) {
            const gapMs = openEntry.startTime.getTime() - previousEntry.endTime.getTime();
            const gapHours = gapMs / 3600000;
            if (gapHours > 0 && gapHours <= 2) {
              // Merge: extend the previous entry to cover the current one,
              // create a break for the gap, and delete the current entry
              const breakStart = previousEntry.endTime;
              const breakEnd = openEntry.startTime;

              await tx.break.create({
                data: {
                  timeEntryId: previousEntry.id,
                  startTime: breakStart,
                  endTime: breakEnd,
                },
              });

              // Update previous entry to extend endTime to current entry's endTime
              const allBreaks = await tx.break.findMany({
                where: { timeEntryId: previousEntry.id },
              });
              const totalBreakMins = Math.round(calcBreakMinutes(allBreaks));

              await tx.timeEntry.update({
                where: { id: previousEntry.id },
                data: {
                  endTime: now,
                  breakMinutes: totalBreakMins,
                },
              });

              // Delete the current (short) entry
              await tx.timeEntry.delete({ where: { id: openEntry.id } });

              return {
                action: "OUT" as const,
                merged: true as const,
                auditEntityId: previousEntry.id,
                auditOldValue: previousEntry,
                auditNewValue: { ...previousEntry, endTime: now, breakMinutes: totalBreakMins },
              };
            }
          }

          return {
            action: "OUT" as const,
            merged: false as const,
            updated,
            openEntry,
          };
        }

        // § 8 BUrlG: Keine Arbeit während genehmigtem Urlaub
        const leaveReason = await hasApprovedLeaveOnDate(tx, employee.id, todayStr);
        if (leaveReason) {
          return { action: "BLOCKED" as const, leaveReason };
        }

        // Einstempeln
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: employee.id,
            date: today,
            startTime: now,
            source: "NFC",
          },
        });

        return { action: "IN" as const, entry };
      });

      if (txResult.action === "BLOCKED") {
        return reply.code(409).send({
          error: `§ 8 BUrlG: Heute ist ${txResult.leaveReason} genehmigt. Bitte zuerst stornieren.`,
          action: "BLOCKED",
        });
      }

      // Load overtime balance for response
      const getBalance = async () => {
        const account = await app.prisma.overtimeAccount.findFirst({
          where: { employeeId: employee.id },
        });
        return account ? Number(account.balanceHours) : 0;
      };

      if (txResult.action === "OUT") {
        await updateOvertimeAccount(app, employee.id);

        if (txResult.merged) {
          await app.audit({
            action: "NFC_CLOCK_OUT",
            entity: "TimeEntry",
            entityId: txResult.auditEntityId,
            oldValue: txResult.auditOldValue,
            newValue: txResult.auditNewValue,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        } else {
          await app.audit({
            action: "NFC_CLOCK_OUT",
            entity: "TimeEntry",
            entityId: txResult.updated.id,
            oldValue: txResult.openEntry,
            newValue: txResult.updated,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }

        const balanceHours = await getBalance();
        return {
          action: "OUT" as const,
          employee: {
            firstName: employee.firstName,
            lastName: employee.lastName,
            employeeNumber: employee.employeeNumber,
          },
          time: now.toISOString(),
          balanceHours,
        };
      }

      // action === "IN"
      await app.audit({
        action: "NFC_CLOCK_IN",
        entity: "TimeEntry",
        entityId: txResult.entry.id,
        newValue: txResult.entry,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      const balanceHours = await getBalance();
      return {
        action: "IN" as const,
        employee: {
          firstName: employee.firstName,
          lastName: employee.lastName,
          employeeNumber: employee.employeeNumber,
        },
        time: now.toISOString(),
        balanceHours,
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

      // § 8 BUrlG: Keine Arbeit während genehmigtem Urlaub
      const empTenantId = employeeRecord?.tenantId;
      if (empTenantId) {
        const clockTz = await getTenantTimezone(app.prisma, empTenantId);
        const clockTodayStr = dateStrInTz(new Date(), clockTz);
        const clockLeave = await hasApprovedLeaveOnDate(app.prisma, employeeId, clockTodayStr);
        if (clockLeave) {
          return reply.code(409).send({
            error: `§ 8 BUrlG: Heute ist ${clockLeave} genehmigt. Bitte zuerst stornieren.`,
          });
        }
      }

      // Prüfen ob bereits eingestempelt + erstellen in einer Transaktion (Race-Condition vermeiden)
      const now = new Date();
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);

      const txResult = await app.prisma.$transaction(async (tx) => {
        const activeEntry = await tx.timeEntry.findFirst({
          where: { employeeId, endTime: null },
        });
        if (activeEntry) {
          return { conflict: true as const, entryId: activeEntry.id };
        }

        const entry = await tx.timeEntry.create({
          data: {
            employeeId,
            date: todayInTz(tz),
            startTime: now,
            source: body.source,
            note: body.note,
          },
        });
        return { conflict: false as const, entry };
      });

      if (txResult.conflict) {
        return reply.code(409).send({ error: "Bereits eingestempelt", entryId: txResult.entryId });
      }

      const entry = txResult.entry;

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
        include: {
          employee: { select: { firstName: true, lastName: true } },
          breaks: { orderBy: { startTime: "asc" } },
        },
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

      // Zukunfts-Validierung: Datum max heute, Endzeit max now+30min
      const now = new Date();
      const tz = await getTenantTimezone(app.prisma, targetEmployee?.tenantId ?? req.user.tenantId);
      const todayStr = dateStrInTz(now, tz);
      const entryDateStr = dateStrInTz(new Date(body.date ?? body.startTime), tz);
      if (entryDateStr > todayStr) {
        return reply.code(400).send({ error: "Zeiteinträge in der Zukunft sind nicht erlaubt" });
      }
      if (newEnd) {
        const maxEnd = new Date(now.getTime() + 30 * 60 * 1000);
        if (newEnd > maxEnd) {
          return reply
            .code(400)
            .send({ error: "Endzeit darf max. 30 Minuten in der Zukunft liegen" });
        }
      }

      // § 8 BUrlG: Keine Arbeit während genehmigtem Urlaub
      const manualEmployeeId = body.employeeId ?? req.user.employeeId ?? "";
      const manualLeave = await hasApprovedLeaveOnDate(app.prisma, manualEmployeeId, entryDateStr);
      if (manualLeave) {
        return reply.code(409).send({
          error: `§ 8 BUrlG: An diesem Tag ist ${manualLeave} genehmigt. Bitte zuerst stornieren.`,
        });
      }

      // Zeitvalidierung
      if (newEnd && newEnd <= newStart) {
        return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
      }

      // Überlappungsprüfung
      const overlap = await checkOverlap(app, employeeId, newStart, newEnd);
      if (overlap) return reply.code(409).send({ error: overlap });

      // Determine breakMinutes from break slots or body
      let finalBreakMinutes = body.breakMinutes;
      const breakSlots: { startTime: Date; endTime: Date }[] = [];

      if (body.breaks && body.breaks.length > 0) {
        for (const b of body.breaks) {
          breakSlots.push({ startTime: new Date(b.startTime), endTime: new Date(b.endTime) });
        }
        const breakError = validateBreakSlots(breakSlots, newStart, newEnd);
        if (breakError) return reply.code(400).send({ error: breakError });
        finalBreakMinutes = Math.round(calcBreakMinutes(breakSlots));
      }

      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(body.date),
          startTime: newStart,
          endTime: newEnd,
          breakMinutes: finalBreakMinutes,
          note: body.note,
          source: "MANUAL",
          createdBy: user.sub,
        },
      });

      // Create break slot records
      if (breakSlots.length > 0) {
        await app.prisma.break.createMany({
          data: breakSlots.map((b) => ({
            timeEntryId: entry.id,
            startTime: b.startTime,
            endTime: b.endTime,
          })),
        });
      } else if (newEnd && finalBreakMinutes === 0) {
        // Auto-break: check tenant config
        const tenantConfig = targetEmployee
          ? await app.prisma.tenantConfig.findUnique({
              where: { tenantId: targetEmployee.tenantId },
            })
          : null;

        if (tenantConfig?.autoBreakEnabled) {
          const workDurationMin = (newEnd.getTime() - newStart.getTime()) / 60000;
          let autoBreakMin = 0;
          if (workDurationMin > 9 * 60) autoBreakMin = 45;
          else if (workDurationMin > 6 * 60) autoBreakMin = 30;

          if (autoBreakMin > 0) {
            // Determine break start time
            let breakStartTime: Date;
            if (tenantConfig.defaultBreakStart) {
              const [hh, mm] = tenantConfig.defaultBreakStart.split(":").map(Number);
              breakStartTime = new Date(newStart);
              breakStartTime.setHours(hh, mm, 0, 0);
              // If configured break start is outside work period, use middle
              if (breakStartTime <= newStart || breakStartTime >= newEnd) {
                const midMs = newStart.getTime() + (newEnd.getTime() - newStart.getTime()) / 2;
                breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
              }
            } else {
              const midMs = newStart.getTime() + (newEnd.getTime() - newStart.getTime()) / 2;
              breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
            }
            const breakEndTime = new Date(breakStartTime.getTime() + autoBreakMin * 60000);

            await app.prisma.break.create({
              data: {
                timeEntryId: entry.id,
                startTime: breakStartTime,
                endTime: breakEndTime,
              },
            });

            await app.prisma.timeEntry.update({
              where: { id: entry.id },
              data: { breakMinutes: autoBreakMin },
            });
            // Update entry object for response
            (entry as any).breakMinutes = autoBreakMin;
          }
        }
      }

      await updateOvertimeAccount(app, employeeId);

      const warnings = await checkArbZG(app.prisma, employeeId, new Date(body.date));

      // Re-fetch entry with breaks for response
      const entryWithBreaks = await app.prisma.timeEntry.findUnique({
        where: { id: entry.id },
        include: { breaks: { orderBy: { startTime: "asc" } } },
      });

      await app.audit({
        userId: user.sub,
        action: "CREATE",
        entity: "TimeEntry",
        entityId: entry.id,
        newValue: entryWithBreaks,
      });

      return reply.code(201).send({ entry: entryWithBreaks, warnings });
    },
  });

  // PUT /api/v1/time-entries/:id  (Eintrag bearbeiten)
  app.put("/:id", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
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

      // Zukunfts-Validierung
      const nowEdit = new Date();
      if (body.date) {
        const emp = await app.prisma.employee.findUnique({
          where: { id: existing.employeeId },
          select: { tenantId: true },
        });
        const editTz = await getTenantTimezone(app.prisma, emp!.tenantId);
        const editTodayStr = dateStrInTz(nowEdit, editTz);
        const editDateStr = dateStrInTz(new Date(body.date), editTz);
        if (editDateStr > editTodayStr) {
          return reply.code(400).send({ error: "Zeiteinträge in der Zukunft sind nicht erlaubt" });
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

      if (updatedEnd) {
        const maxEndEdit = new Date(nowEdit.getTime() + 30 * 60 * 1000);
        if (updatedEnd > maxEndEdit) {
          return reply
            .code(400)
            .send({ error: "Endzeit darf max. 30 Minuten in der Zukunft liegen" });
        }
      }

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
      if (body.breakMinutes !== undefined && !body.breaks) patch.breakMinutes = body.breakMinutes;
      if ("note" in body) patch.note = body.note ?? null;

      // Handle break slots update
      if (body.breaks) {
        const newBreakSlots = body.breaks.map((b) => ({
          timeEntryId: id,
          startTime: new Date(b.startTime),
          endTime: new Date(b.endTime),
        }));
        // Validate break slots before persisting
        const breakError = validateBreakSlots(
          newBreakSlots.map((b) => ({ startTime: b.startTime, endTime: b.endTime })),
          updatedStart,
          updatedEnd,
        );
        if (breakError) return reply.code(400).send({ error: breakError });
        // Delete existing breaks and create new ones
        await app.prisma.break.deleteMany({ where: { timeEntryId: id } });
        if (newBreakSlots.length > 0) {
          await app.prisma.break.createMany({ data: newBreakSlots });
        }
        // Recalculate breakMinutes from the new break slots
        patch.breakMinutes = Math.round(
          calcBreakMinutes(
            newBreakSlots.map((b) => ({ startTime: b.startTime, endTime: b.endTime })),
          ),
        );
      }

      const updated = await app.prisma.timeEntry.update({
        where: { id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: patch as any,
        include: { breaks: { orderBy: { startTime: "asc" } } },
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

  // PATCH /api/v1/time-entries/:id/revalidate  (Admin/Manager setzt isInvalid zurück)
  app.patch("/:id/revalidate", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = req.user;

      const existing = await app.prisma.timeEntry.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      if (!existing.isInvalid)
        return reply.code(400).send({ error: "Eintrag ist nicht invalidiert" });

      const updated = await app.prisma.timeEntry.update({
        where: { id },
        data: { isInvalid: false, invalidReason: null },
        include: { breaks: { orderBy: { startTime: "asc" } } },
      });

      await updateOvertimeAccount(app, existing.employeeId);

      await app.audit({
        userId: user.sub,
        action: "UPDATE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: { isInvalid: true, invalidReason: existing.invalidReason },
        newValue: { isInvalid: false, invalidReason: null },
      });

      return updated;
    },
  });

  // DELETE /api/v1/time-entries/:id
  app.delete("/:id", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
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

  // MONTHLY_HOURS with 0 hours = pure tracking, no overtime calculation
  if (
    schedule.type === "MONTHLY_HOURS" &&
    (!schedule.monthlyHours || Number(schedule.monthlyHours) === 0)
  ) {
    await app.prisma.overtimeAccount.upsert({
      where: { employeeId },
      create: { employeeId, balanceHours: 0 },
      update: { balanceHours: 0 },
    });
    return;
  }

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

  // Tatsächlich gearbeitete Minuten dieses Monats (nur valide Einträge)
  const entries = await app.prisma.timeEntry.findMany({
    where: {
      employeeId,
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

  // Soll-Minuten (TZ-aware Wochentag-Zuordnung), nur bis heute, Tage vor hireDate überspringen
  const effectiveStart =
    employee?.hireDate && employee.hireDate > monthStart ? employee.hireDate : monthStart;
  const todayStr = dateStrInTz(now, tz);
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const effectiveEnd = todayDate < monthEnd ? todayDate : monthEnd;
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
export async function getEffectiveSchedule(
  app: FastifyInstance,
  employeeId: string,
  forDate?: Date,
) {
  const targetDate = forDate ?? new Date();
  const schedule = await app.prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: targetDate } },
    orderBy: { validFrom: "desc" },
  });
  if (schedule) return schedule;

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const tenantConfig = employee
    ? await app.prisma.tenantConfig.findUnique({ where: { tenantId: employee.tenantId } })
    : null;

  return {
    type: "FIXED_WEEKLY" as const,
    weeklyHours: tenantConfig?.defaultWeeklyHours ?? 40,
    monthlyHours: null,
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
