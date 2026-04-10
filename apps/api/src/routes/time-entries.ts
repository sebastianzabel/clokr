import { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
import { requireAuth, requireRole } from "../middleware/auth";
import { TimeEntrySource, Prisma } from "@clokr/db";
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
      deletedAt: null,
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

/** § 8 BUrlG: Prüft ob aktiver Urlaub an dem Tag vorliegt */
async function hasApprovedLeaveOnDate(
  prisma: Prisma.TransactionClient,
  employeeId: string,
  dateStr: string,
): Promise<{ type: string; status: "APPROVED" | "CANCELLATION_REQUESTED" } | null> {
  const leave = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      status: { in: ["APPROVED", "CANCELLATION_REQUESTED"] },
      startDate: { lte: new Date(dateStr + "T23:59:59Z") },
      endDate: { gte: new Date(dateStr + "T00:00:00Z") },
    },
    include: { leaveType: { select: { name: true } } },
  });
  if (leave) return { type: leave.leaveType.name, status: leave.status as "APPROVED" | "CANCELLATION_REQUESTED" };

  const absence = await prisma.absence.findFirst({
    where: {
      employeeId,
      deletedAt: null,
      startDate: { lte: new Date(dateStr + "T23:59:59Z") },
      endDate: { gte: new Date(dateStr + "T00:00:00Z") },
      type: { in: ["MATERNITY", "PARENTAL"] },
    },
  });
  if (absence)
    return {
      type: absence.type === "MATERNITY" ? "Mutterschutz" : "Elternzeit",
      status: "APPROVED" as const,
    };

  return null;
}

export async function timeEntryRoutes(app: FastifyInstance) {
  // POST /api/v1/time-entries/nfc-punch  (kein JWT – Terminal-Gerät)
  const isTest = process.env.NODE_ENV === "test";
  app.post("/nfc-punch", {
    schema: { tags: ["Zeiterfassung"] },
    config: { rateLimit: { max: isTest ? 1000 : 10, timeWindow: "1 minute" } },
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
        .catch((err) => app.log.error({ err }, "Failed to update NFC card lastUsedAt"));

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
            deletedAt: null,
            date: today,
            endTime: null,
            isInvalid: false,
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
              deletedAt: null,
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

              // Soft delete the current (short) entry (merged into previous)
              await tx.timeEntry.update({
                where: { id: openEntry.id },
                data: { deletedAt: new Date() },
              });

              return {
                action: "OUT" as const,
                merged: true as const,
                auditEntityId: previousEntry.id,
                auditOldValue: previousEntry,
                auditNewValue: { ...previousEntry, endTime: now, breakMinutes: totalBreakMins },
                auditDeletedEntryId: openEntry.id,
                auditDeletedEntry: openEntry,
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

        // § 8 BUrlG: Check for active leave on this day
        const leaveCheck = await hasApprovedLeaveOnDate(tx, employee.id, todayStr);
        if (leaveCheck?.status === "APPROVED") {
          return { action: "BLOCKED" as const, leaveReason: leaveCheck.type };
        }

        // Einstempeln — if CANCELLATION_REQUESTED, mark as invalid until cancellation approved
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: employee.id,
            date: today,
            startTime: now,
            source: "NFC",
            isInvalid: leaveCheck?.status === "CANCELLATION_REQUESTED",
            invalidReason: leaveCheck ? "Urlaubsstornierung ausstehend" : null,
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
        // Auto-break after NFC clock-out (if no breaks exist)
        const clockedOutEntryId = txResult.merged ? txResult.auditEntityId : txResult.updated.id;
        const existingBreaks = await app.prisma.break.findMany({
          where: { timeEntryId: clockedOutEntryId },
        });
        const manualBreakMin = existingBreaks.reduce(
          (s, b) => s + Math.round((b.endTime.getTime() - b.startTime.getTime()) / 60000),
          0,
        );

        if (manualBreakMin === 0) {
          const tenantConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
          if (tenantConfig?.autoBreakEnabled) {
            const entryForBreak = await app.prisma.timeEntry.findUnique({
              where: { id: clockedOutEntryId },
            });
            if (entryForBreak?.startTime && entryForBreak?.endTime) {
              const workDurationMin =
                (entryForBreak.endTime.getTime() - entryForBreak.startTime.getTime()) / 60000;
              let autoBreakMin = 0;
              if (workDurationMin > 9 * 60) autoBreakMin = 45;
              else if (workDurationMin > 6 * 60) autoBreakMin = 30;

              if (autoBreakMin > 0) {
                let breakStartTime: Date;
                if (tenantConfig.defaultBreakStart) {
                  const [hh, mm] = tenantConfig.defaultBreakStart.split(":").map(Number);
                  breakStartTime = new Date(entryForBreak.startTime);
                  breakStartTime.setHours(hh, mm, 0, 0);
                  if (
                    breakStartTime <= entryForBreak.startTime ||
                    breakStartTime >= entryForBreak.endTime
                  ) {
                    const midMs =
                      entryForBreak.startTime.getTime() +
                      (entryForBreak.endTime.getTime() - entryForBreak.startTime.getTime()) / 2;
                    breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
                  }
                } else {
                  const midMs =
                    entryForBreak.startTime.getTime() +
                    (entryForBreak.endTime.getTime() - entryForBreak.startTime.getTime()) / 2;
                  breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
                }
                const breakEndTime = new Date(breakStartTime.getTime() + autoBreakMin * 60000);

                await app.prisma.break.create({
                  data: {
                    timeEntryId: clockedOutEntryId,
                    startTime: breakStartTime,
                    endTime: breakEndTime,
                  },
                });
                await app.prisma.timeEntry.update({
                  where: { id: clockedOutEntryId },
                  data: { breakMinutes: autoBreakMin },
                });
              }
            }
          }
        }

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
          // Audit the soft-deleted merged entry separately
          await app.audit({
            action: "DELETE",
            entity: "TimeEntry",
            entityId: txResult.auditDeletedEntryId,
            oldValue: txResult.auditDeletedEntry,
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

      // § 8 BUrlG: Check for active leave
      let clockLeaveCheck: { type: string; status: "APPROVED" | "CANCELLATION_REQUESTED" } | null =
        null;
      const empTenantId = employeeRecord?.tenantId;
      if (empTenantId) {
        const clockTz = await getTenantTimezone(app.prisma, empTenantId);
        const clockTodayStr = dateStrInTz(new Date(), clockTz);
        clockLeaveCheck = await hasApprovedLeaveOnDate(app.prisma, employeeId, clockTodayStr);
        if (clockLeaveCheck?.status === "APPROVED") {
          return reply.code(409).send({
            error: `§ 8 BUrlG: Heute ist ${clockLeaveCheck.type} genehmigt. Bitte zuerst stornieren.`,
          });
        }
      }

      // Prüfen ob bereits eingestempelt + erstellen in einer Transaktion (Race-Condition vermeiden)
      const now = new Date();
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);

      const txResult = await app.prisma.$transaction(async (tx) => {
        const activeEntry = await tx.timeEntry.findFirst({
          where: { employeeId, deletedAt: null, endTime: null, isInvalid: false },
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
            isInvalid: clockLeaveCheck?.status === "CANCELLATION_REQUESTED",
            invalidReason: clockLeaveCheck ? "Urlaubsstornierung ausstehend" : null,
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
      if (!entry || entry.deletedAt)
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      if (entry.endTime) return reply.code(409).send({ error: "Bereits ausgestempelt" });

      const now = new Date();
      const initialBreakMinutes = body.breakMinutes ?? 0;

      await app.prisma.timeEntry.update({
        where: { id },
        data: {
          endTime: now,
          breakMinutes: initialBreakMinutes,
          note: body.note,
        },
      });

      // Auto-break on clock-out if no manual breaks provided
      if (initialBreakMinutes === 0) {
        const targetEmployee = await app.prisma.employee.findUnique({
          where: { id: entry.employeeId },
        });
        const tenantConfig = targetEmployee
          ? await app.prisma.tenantConfig.findUnique({
              where: { tenantId: targetEmployee.tenantId },
            })
          : null;

        if (tenantConfig?.autoBreakEnabled) {
          const workDurationMin = (now.getTime() - entry.startTime.getTime()) / 60000;
          let autoBreakMin = 0;
          if (workDurationMin > 9 * 60) autoBreakMin = 45;
          else if (workDurationMin > 6 * 60) autoBreakMin = 30;

          if (autoBreakMin > 0) {
            let breakStartTime: Date;
            if (tenantConfig.defaultBreakStart) {
              const [hh, mm] = tenantConfig.defaultBreakStart.split(":").map(Number);
              breakStartTime = new Date(entry.startTime);
              breakStartTime.setHours(hh, mm, 0, 0);
              if (breakStartTime <= entry.startTime || breakStartTime >= now) {
                const midMs =
                  entry.startTime.getTime() + (now.getTime() - entry.startTime.getTime()) / 2;
                breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
              }
            } else {
              const midMs =
                entry.startTime.getTime() + (now.getTime() - entry.startTime.getTime()) / 2;
              breakStartTime = new Date(midMs - (autoBreakMin / 2) * 60000);
            }
            const breakEndTime = new Date(breakStartTime.getTime() + autoBreakMin * 60000);

            await app.prisma.break.create({
              data: { timeEntryId: id, startTime: breakStartTime, endTime: breakEndTime },
            });
            await app.prisma.timeEntry.update({
              where: { id },
              data: { breakMinutes: autoBreakMin },
            });
            // breakMinutes updated in DB above
          }
        }
      }

      await updateOvertimeAccount(app, entry.employeeId);

      const warnings = await checkArbZG(app.prisma, entry.employeeId, entry.date);

      // Re-fetch with breaks for response
      const entryWithBreaks = await app.prisma.timeEntry.findUnique({
        where: { id },
        include: { breaks: { orderBy: { startTime: "asc" } } },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CLOCK_OUT",
        entity: "TimeEntry",
        entityId: id,
        oldValue: entry,
        newValue: entryWithBreaks,
      });

      return { success: true, entry: entryWithBreaks, warnings };
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
          // Tenant isolation: always scope to the requesting user's tenant via employee.tenantId
          employee: { tenantId: user.tenantId },
          employeeId: isManager && employeeId ? employeeId : (user.employeeId ?? undefined),
          deletedAt: null,
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

      // Prüfen ob Mitarbeiter existiert, zum Tenant gehört und aktiv ist
      const targetEmployee = await app.prisma.employee.findFirst({
        where: { id: employeeId, tenantId: req.user.tenantId },
        include: { user: true },
      });
      if (!targetEmployee) {
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }
      if (!targetEmployee.user.isActive) {
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

      // § 8 BUrlG: Check for active leave
      const manualEmployeeId = body.employeeId ?? req.user.employeeId ?? "";
      const manualLeave = await hasApprovedLeaveOnDate(app.prisma, manualEmployeeId, entryDateStr);
      if (manualLeave?.status === "APPROVED") {
        return reply.code(409).send({
          error: `§ 8 BUrlG: An diesem Tag ist ${manualLeave.type} genehmigt. Bitte zuerst stornieren.`,
        });
      }

      // Zeitvalidierung
      if (newEnd && newEnd <= newStart) {
        return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
      }

      // Nur ein Eintrag pro Tag erlaubt
      const existingEntry = await app.prisma.timeEntry.findFirst({
        where: { employeeId, deletedAt: null, date: new Date(body.date) },
      });
      if (existingEntry) {
        return reply.code(409).send({
          error:
            "Es existiert bereits ein Eintrag für diesen Tag. Bitte den bestehenden Eintrag bearbeiten.",
        });
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
          isInvalid: manualLeave?.status === "CANCELLATION_REQUESTED",
          invalidReason: manualLeave ? "Urlaubsstornierung ausstehend" : null,
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
            entry.breakMinutes = autoBreakMin;
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

      const existing = await app.prisma.timeEntry.findUnique({
        where: { id },
        include: { employee: { select: { tenantId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      // Tenant isolation
      if (existing.employee.tenantId !== user.tenantId) {
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      // Nur eigene Einträge für normale Mitarbeiter
      if (!isManager && existing.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Gesperrte Einträge dürfen nicht bearbeitet werden
      if (existing.isLocked) {
        return reply
          .code(403)
          .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" });
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
      // Only set source to CORRECTION when a manager edits another employee's entry
      const isCorrectionByManager = isManager && existing.employeeId !== user.employeeId;
      const patch: Record<string, unknown> = isCorrectionByManager ? { source: "CORRECTION" } : {};
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
        action: isCorrectionByManager ? "MANAGER_CORRECTION" : "UPDATE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: existing,
        newValue: updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { entry: updated, warnings };
    },
  });

  // PATCH /api/v1/time-entries/:id/revalidate  (Admin/Manager setzt isInvalid zurück)
  // Optionally accepts startTime, endTime, breakMinutes to correct the entry in one step
  const revalidateSchema = z.object({
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional().nullable(),
    breakMinutes: z.number().int().min(0).optional(),
    note: z.string().optional().nullable(),
  });

  app.patch("/:id/revalidate", {
    schema: { tags: ["Zeiterfassung"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = revalidateSchema.parse(req.body ?? {});
      const user = req.user;

      const existing = await app.prisma.timeEntry.findUnique({
        where: { id },
        include: { employee: { select: { tenantId: true } } },
      });
      if (!existing || existing.deletedAt)
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      // Tenant isolation
      if (existing.employee.tenantId !== user.tenantId) {
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      if (!existing.isInvalid)
        return reply.code(400).send({ error: "Eintrag ist nicht invalidiert" });

      // Gesperrte Einträge dürfen nicht revalidiert werden
      if (existing.isLocked) {
        return reply
          .code(403)
          .send({ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" });
      }

      // Build update data: always revalidate, optionally correct times
      const updateData: Prisma.TimeEntryUpdateInput = {
        isInvalid: false,
        invalidReason: null,
      };

      const hasCorrection =
        body.startTime || body.endTime !== undefined || body.breakMinutes !== undefined;
      if (hasCorrection) {
        updateData.source = "CORRECTION";
        if (body.startTime) updateData.startTime = new Date(body.startTime);
        if (body.endTime !== undefined) {
          updateData.endTime = body.endTime ? new Date(body.endTime) : null;
        }
        if (body.breakMinutes !== undefined) updateData.breakMinutes = body.breakMinutes;

        // Validate times
        const newStart = body.startTime ? new Date(body.startTime) : existing.startTime;
        const newEnd =
          body.endTime !== undefined
            ? body.endTime
              ? new Date(body.endTime)
              : null
            : existing.endTime;

        if (newEnd && newEnd <= newStart) {
          return reply.code(400).send({ error: "Endzeit muss nach der Startzeit liegen" });
        }

        // Overlap check
        const overlap = await checkOverlap(app, existing.employeeId, newStart, newEnd, id);
        if (overlap) return reply.code(409).send({ error: overlap });
      }
      if ("note" in body) updateData.note = body.note ?? null;

      const updated = await app.prisma.timeEntry.update({
        where: { id },
        data: updateData,
        include: { breaks: { orderBy: { startTime: "asc" } } },
      });

      await updateOvertimeAccount(app, existing.employeeId);

      await app.audit({
        userId: user.sub,
        action: hasCorrection ? "MANAGER_CORRECTION" : "REVALIDATE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: existing,
        newValue: updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
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

      const existing = await app.prisma.timeEntry.findUnique({
        where: { id },
        include: { employee: { select: { tenantId: true } } },
      });
      if (!existing || existing.deletedAt)
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });

      // Tenant isolation: reject cross-tenant deletes
      if (existing.employee.tenantId !== user.tenantId) {
        return reply.code(404).send({ error: "Eintrag nicht gefunden" });
      }

      if (!isManager && existing.employeeId !== user.employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      if (existing.isLocked) {
        return reply
          .code(403)
          .send({ error: "Eintrag ist gesperrt und kann nicht gelöscht werden" });
      }

      // Soft delete instead of hard delete
      await app.prisma.timeEntry.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await updateOvertimeAccount(app, existing.employeeId);

      await app.audit({
        userId: user.sub,
        action: "DELETE",
        entity: "TimeEntry",
        entityId: id,
        oldValue: existing,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return reply.code(204).send();
    },
  });
}

// ── Hilfsfunktion: Überstundensaldo berechnen (snapshot-basiert, TZ-aware) ────
// Nutzt den letzten SaldoSnapshot als Basis und rechnet nur den offenen Zeitraum
// seit dem Snapshot neu. Ohne Snapshot: Fallback auf den aktuellen Monat.
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

  // Letzten Snapshot suchen (Basis für die Berechnung)
  const lastSnapshot = await app.prisma.saldoSnapshot.findFirst({
    where: { employeeId, periodType: "MONTHLY" },
    orderBy: { periodStart: "desc" },
  });

  const now = new Date();
  const todayStr = dateStrInTz(now, tz);
  const todayDate = new Date(todayStr + "T00:00:00Z");
  const yesterdayDate = new Date(todayDate.getTime() - 86400000);

  // Berechne den offenen Zeitraum: ab Tag nach Snapshot-Ende bis heute
  // Ohne Snapshot: ab Monatsanfang (oder Eintrittsdatum)
  let rangeStart: Date;
  let snapshotCarryOver = 0;

  if (lastSnapshot) {
    // Start: Tag nach dem Snapshot-Ende
    rangeStart = new Date(lastSnapshot.periodEnd.getTime() + 86400000);
    snapshotCarryOver = lastSnapshot.carryOver;
  } else {
    // Kein Snapshot: ab Monatsanfang oder Eintrittsdatum
    const zonedNow = new Date(dateStrInTz(now, tz) + "T12:00:00Z");
    const { start: monthStart } = monthRangeUtc(
      zonedNow.getUTCFullYear(),
      zonedNow.getUTCMonth() + 1,
      tz,
    );
    const hireDateNorm = employee?.hireDate
      ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
      : null;
    rangeStart = hireDateNorm && hireDateNorm > monthStart ? hireDateNorm : monthStart;
  }

  // Determine cutoff: include today only if entries exist
  const hasTodayEntries = await app.prisma.timeEntry.count({
    where: {
      employeeId,
      deletedAt: null,
      date: todayDate,
      endTime: { not: null },
      type: "WORK",
      isInvalid: false,
    },
  });
  const cutoffDate = hasTodayEntries > 0 ? todayDate : yesterdayDate;
  const effectiveEnd = cutoffDate < rangeStart ? rangeStart : cutoffDate;

  // Worked minutes since snapshot (or month start)
  const entries = await app.prisma.timeEntry.findMany({
    where: {
      employeeId,
      deletedAt: null,
      date: { gte: rangeStart, lte: effectiveEnd },
      endTime: { not: null },
      type: "WORK",
      isInvalid: false,
    },
  });

  const workedMinutes = entries.reduce((sum, e) => {
    if (!e.endTime) return sum;
    return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
  }, 0);

  // Expected minutes for same range
  const expectedMinutes =
    effectiveEnd < rangeStart ? 0 : calcExpectedMinutesTz(schedule, rangeStart, effectiveEnd, tz);

  // Öffentliche Feiertage abziehen
  const holidays = await app.prisma.publicHoliday.findMany({
    where: {
      tenant: { employees: { some: { id: employeeId } } },
      date: { gte: rangeStart, lte: effectiveEnd },
    },
  });
  const holidayMinutes = holidays.reduce((sum, h) => {
    const dow = getDayOfWeekInTz(h.date, tz);
    return sum + getDayHoursFromSchedule(schedule, dow) * 60;
  }, 0);

  // Genehmigte Abwesenheiten abziehen
  const approvedLeave = await app.prisma.leaveRequest.findMany({
    where: {
      employeeId,
      status: "APPROVED",
      startDate: { lte: effectiveEnd },
      endDate: { gte: rangeStart },
    },
  });
  const leaveMinutes = approvedLeave.reduce((sum, lr) => {
    const leaveStart = lr.startDate < rangeStart ? rangeStart : lr.startDate;
    const leaveEnd = lr.endDate > effectiveEnd ? effectiveEnd : lr.endDate;
    if (leaveStart > leaveEnd) return sum;
    return sum + calcExpectedMinutesTz(schedule, leaveStart, leaveEnd, tz);
  }, 0);

  // Saldo = Snapshot-CarryOver + offener Zeitraum
  const openPeriodBalance =
    workedMinutes - Math.max(0, expectedMinutes - holidayMinutes - leaveMinutes);
  const totalBalanceHours = (snapshotCarryOver + openPeriodBalance) / 60;

  const account = await app.prisma.overtimeAccount.upsert({
    where: { employeeId },
    create: { employeeId, balanceHours: totalBalanceHours },
    update: { balanceHours: totalBalanceHours },
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
