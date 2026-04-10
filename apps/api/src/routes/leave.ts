import { FastifyInstance } from "fastify";
import { z } from "zod";
import { LeaveRequestStatus, Prisma } from "@clokr/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { getTenantTimezone, monthRangeUtc } from "../utils/timezone";
import { generateICal, addOneDay, type ICalEvent } from "../utils/ical";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";
import { splitDaysAcrossYears } from "../utils/vacation-calc";

// ── Feste Abwesenheitstypen ──────────────────────────────────────────────────
const TYPE_CODES = [
  "VACATION",
  "OVERTIME_COMP",
  "SPECIAL",
  "UNPAID",
  "SICK",
  "SICK_CHILD",
  "EDUCATION",
  "MATERNITY",
  "PARENTAL",
] as const;
type TypeCode = (typeof TYPE_CODES)[number];

const LEAVE_TYPE_DEFS: Record<
  TypeCode,
  { name: string; isPaid: boolean; requiresApproval: boolean }
> = {
  VACATION: { name: "Urlaub", isPaid: true, requiresApproval: true },
  OVERTIME_COMP: { name: "Überstundenausgleich", isPaid: true, requiresApproval: true },
  SPECIAL: { name: "Sonderurlaub", isPaid: true, requiresApproval: true },
  UNPAID: { name: "Unbezahlter Urlaub", isPaid: false, requiresApproval: true },
  SICK: { name: "Krankmeldung", isPaid: true, requiresApproval: false },
  SICK_CHILD: { name: "Kinderkrank", isPaid: true, requiresApproval: false },
  EDUCATION: { name: "Bildungsurlaub", isPaid: true, requiresApproval: true },
  MATERNITY: { name: "Mutterschutz", isPaid: true, requiresApproval: false },
  PARENTAL: { name: "Elternzeit", isPaid: false, requiresApproval: true },
};

// Legacy-Namen aus alten Seed-Skripten → werden beim ersten Zugriff umbenannt
const LEGACY_ALIASES: Partial<Record<TypeCode, string[]>> = {
  VACATION: ["Jahresurlaub", "Urlaub (Jahresurlaub)"],
};

/** Stellt sicher, dass ein LeaveType-Eintrag für den Tenant existiert – gibt seine ID zurück.
 *  Migriert automatisch alte Seed-Namen (z.B. "Jahresurlaub" → "Urlaub"). */
async function ensureLeaveType(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  code: TypeCode,
): Promise<string> {
  const def = LEAVE_TYPE_DEFS[code];
  // 1. Kanonischer Name
  const existing = await prisma.leaveType.findFirst({ where: { tenantId, name: def.name } });
  if (existing) return existing.id;
  // 2. Legacy-Alias → umbenennen + zurückgeben
  const aliases = LEGACY_ALIASES[code] ?? [];
  for (const alias of aliases) {
    const legacy = await prisma.leaveType.findFirst({ where: { tenantId, name: alias } });
    if (legacy) {
      await prisma.leaveType.update({ where: { id: legacy.id }, data: { name: def.name } });
      return legacy.id;
    }
  }
  // 3. Neu anlegen
  const created = await prisma.leaveType.create({ data: { tenantId, ...def } });
  return created.id;
}

const createSchema = z
  .object({
    type: z.enum(TYPE_CODES),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    halfDay: z.boolean().default(false),
    note: z.string().optional().nullable(),
    specialLeaveRuleId: z.string().uuid().optional().nullable(),
  })
  .refine((data) => new Date(data.startDate) <= new Date(data.endDate), {
    message: "Enddatum muss nach Startdatum liegen",
    path: ["endDate"],
  });

const reviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  reviewNote: z.string().optional().nullable(),
});

const updateSchema = z
  .object({
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum"),
    halfDay: z.boolean().default(false),
    note: z.string().optional().nullable(),
  })
  .refine((data) => new Date(data.startDate) <= new Date(data.endDate), {
    message: "Enddatum muss nach Startdatum liegen",
    path: ["endDate"],
  });

const attestSchema = z.object({
  attestPresent: z.boolean(),
  attestValidFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum")
    .nullable()
    .optional(),
  attestValidTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !isNaN(new Date(s).getTime()), "Ungültiges Datum")
    .nullable()
    .optional(),
});

export async function leaveRoutes(app: FastifyInstance) {
  // ── POST /requests  – Antrag stellen ────────────────────────────────────
  app.post("/requests", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const body = createSchema.parse(req.body);
      const employeeId = req.user.employeeId;
      if (!employeeId) return reply.code(400).send({ error: "Kein Mitarbeiter-Profil" });

      const start = new Date(body.startDate);
      const end = new Date(body.endDate);
      if (start > end)
        return reply.code(400).send({ error: "Startdatum muss vor Enddatum liegen" });

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, start, end);
      const holidays = new Set(holidayMap.keys());
      const days = calculateWorkDays(start, end, body.halfDay, holidays);

      // Überschneidung mit eigenem Antrag prüfen
      const overlap = await app.prisma.leaveRequest.findFirst({
        where: {
          employeeId,
          deletedAt: null,
          status: { in: ["PENDING", "APPROVED"] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
      });
      if (overlap) return reply.code(409).send({ error: "Überschneidung mit bestehendem Antrag" });

      // Load tenant config for leave rules
      const tenantConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });

      const leaveTypeId = await ensureLeaveType(app.prisma, tenantId, body.type);
      const leaveType = await app.prisma.leaveType.findUnique({ where: { id: leaveTypeId } });

      // ── Half-day check ──
      if (body.halfDay) {
        const globalHalfDay = tenantConfig?.halfDayAllowed ?? true;
        const typeHalfDay = leaveType?.allowHalfDay ?? true;
        if (!globalHalfDay || !typeHalfDay) {
          return reply
            .code(400)
            .send({ error: "Halbe Tage sind für diesen Abwesenheitstyp nicht erlaubt" });
        }
      }

      // ── Lead time check (not for sick types) ──
      const isSickType = ["SICK", "SICK_CHILD"].includes(body.type);
      if (!isSickType) {
        const leadTimeDays = leaveType?.leadTimeDays ?? tenantConfig?.vacationLeadTimeDays ?? 0;
        if (leadTimeDays > 0) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const diffMs = start.getTime() - today.getTime();
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          if (diffDays < leadTimeDays) {
            return reply.code(400).send({
              error: `Abwesenheit muss mindestens ${leadTimeDays} Tage im Voraus beantragt werden`,
            });
          }
        }

        // ── Max advance months check ──
        const maxAdvanceMonths = tenantConfig?.vacationMaxAdvanceMonths ?? 0;
        if (maxAdvanceMonths > 0) {
          const maxDate = new Date();
          maxDate.setMonth(maxDate.getMonth() + maxAdvanceMonths);
          if (end > maxDate) {
            return reply.code(400).send({
              error: `Abwesenheit darf maximal ${maxAdvanceMonths} Monate im Voraus beantragt werden`,
            });
          }
        }
      }

      // ── Max days per year check ──
      if (leaveType?.maxDaysPerYear) {
        const yearStart = new Date(start.getFullYear(), 0, 1);
        const yearEnd = new Date(start.getFullYear(), 11, 31);
        const usedThisYear = await app.prisma.leaveRequest.aggregate({
          where: {
            employeeId,
            leaveTypeId,
            deletedAt: null,
            status: { in: ["PENDING", "APPROVED"] },
            startDate: { gte: yearStart, lte: yearEnd },
          },
          _sum: { days: true },
        });
        const used = Number(usedThisYear._sum.days ?? 0);
        if (used + days > leaveType.maxDaysPerYear) {
          return reply.code(400).send({
            error: `Max. ${leaveType.maxDaysPerYear} Tage/Jahr für diesen Typ (bereits ${used} genutzt)`,
          });
        }
      }

      // Für VACATION: Resturlaub auto-übertragen (lazy) + verfügbare Tage prüfen
      if (body.type === "VACATION") {
        const year1 = start.getFullYear();
        const year2 = end.getFullYear();
        const isCrossYear = year1 !== year2;

        // Split days across years if cross-year
        const split = isCrossYear
          ? splitDaysAcrossYears(start, end, body.halfDay, holidays)
          : { year1Days: days, year2Days: 0, year1, year2 };

        // ── Year 1: check entitlement ──
        await autoCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year1);
        const ent1 = await app.prisma.leaveEntitlement.findUnique({
          where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: year1 } },
        });
        if (ent1 && split.year1Days > 0) {
          const co1 = getEffectiveCarryOver(ent1, start);
          const avail1 = Number(ent1.totalDays) + co1 - Number(ent1.usedDays);
          if (split.year1Days > avail1) {
            return reply.code(400).send({
              error: `Nicht genug Urlaubstage in ${year1}`,
              available: avail1,
              requested: split.year1Days,
            });
          }
        }

        // ── Year 2: check entitlement (cross-year only) ──
        if (isCrossYear && split.year2Days > 0) {
          await autoCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year2);

          // Recalculate projected carry-over for year 2
          // (remaining from year 1 after this booking)
          await recalculateCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year2);

          const ent2 = await app.prisma.leaveEntitlement.findUnique({
            where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: year2 } },
          });
          if (ent2) {
            const co2 = getEffectiveCarryOver(ent2, end);
            const avail2 = Number(ent2.totalDays) + co2 - Number(ent2.usedDays);
            if (split.year2Days > avail2) {
              return reply.code(400).send({
                error: `Nicht genug Urlaubstage in ${year2}`,
                available: avail2,
                requested: split.year2Days,
              });
            }
          }
        }
      }

      // Für OVERTIME_COMP: Überstundensaldo prüfen (basierend auf echtem Stundenplan)
      if (body.type === "OVERTIME_COMP") {
        const [account, hoursNeeded] = await Promise.all([
          app.prisma.overtimeAccount.findUnique({ where: { employeeId } }),
          getScheduledHours(app.prisma, employeeId, start, end, body.halfDay, holidays),
        ]);
        const balance = account ? Number(account.balanceHours) : 0;
        if (hoursNeeded > balance) {
          return reply.code(400).send({
            error: "Nicht genug Überstunden",
            available: +balance.toFixed(2),
            requested: +hoursNeeded.toFixed(2),
          });
        }
      }

      // Für SPECIAL: specialLeaveRuleId required, validate days against rule
      if (body.type === "SPECIAL") {
        if (!body.specialLeaveRuleId) {
          return reply
            .code(400)
            .send({ error: "Sonderurlaub erfordert einen Anlass (specialLeaveRuleId)" });
        }
        const rule = await app.prisma.specialLeaveRule.findUnique({
          where: { id: body.specialLeaveRuleId },
        });
        if (!rule || !rule.isActive) {
          return reply
            .code(400)
            .send({ error: "Ungültiger oder deaktivierter Sonderurlaubs-Anlass" });
        }
        if (days > Number(rule.defaultDays)) {
          return reply.code(400).send({
            error: `Max. ${Number(rule.defaultDays)} Tage für "${rule.name}" (beantragt: ${days})`,
          });
        }
      }

      const request = await app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId,
          specialLeaveRuleId: body.specialLeaveRuleId ?? null,
          startDate: start,
          endDate: end,
          days,
          halfDay: body.halfDay,
          note: body.note,
        },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true } },
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "CREATE",
        entity: "LeaveRequest",
        entityId: request.id,
        newValue: { type: body.type, startDate: body.startDate, endDate: body.endDate, days },
      });

      // ── Benachrichtigung: Manager über neuen Antrag informieren ──
      const typeDef = LEAVE_TYPE_DEFS[body.type];
      const managers = await app.prisma.user.findMany({
        where: {
          role: { in: ["ADMIN", "MANAGER"] },
          isActive: true,
          employee: { tenantId: req.user.tenantId },
        },
        select: { id: true },
      });
      for (const mgr of managers) {
        await app.notify({
          userId: mgr.id,
          type: "LEAVE_REQUEST",
          title: "Neuer Urlaubsantrag",
          message: `${request.employee.firstName} ${request.employee.lastName} hat einen ${typeDef.name}-Antrag gestellt (${body.startDate} – ${body.endDate})`,
          link: `/leave?request=${request.id}`,
          tenantId,
        });
      }

      return reply.code(201).send({
        ...request,
        typeCode: body.type,
        startDate: request.startDate.toISOString().split("T")[0],
        endDate: request.endDate.toISOString().split("T")[0],
      });
    },
  });

  // ── GET /requests  – Anträge abrufen ────────────────────────────────────
  app.get("/requests", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const user = req.user;
      const isManager = ["ADMIN", "MANAGER"].includes(user.role);
      const { status, employeeId, year, upcoming } = req.query as {
        status?: string;
        employeeId?: string;
        year?: string;
        upcoming?: string;
      };

      // Für Manager: PENDING-Filter schließt CANCELLATION_REQUESTED immer ein
      const statusFilter: Prisma.LeaveRequestWhereInput["status"] = status
        ? isManager && status === "PENDING"
          ? { in: ["PENDING", "CANCELLATION_REQUESTED"] }
          : (status as LeaveRequestStatus)
        : undefined;

      const rows = await app.prisma.leaveRequest.findMany({
        where: {
          deletedAt: null,
          ...(isManager
            ? {
                employee: { tenantId: user.tenantId },
                ...(employeeId ? { employeeId } : {}),
              }
            : { employeeId: user.employeeId ?? "" }),
          ...(statusFilter !== undefined ? { status: statusFilter } : {}),
          ...(upcoming === "true"
            ? {
                endDate: { gte: new Date() },
              }
            : year
              ? {
                  startDate: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) },
                }
              : {}),
        },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
        },
        orderBy: upcoming === "true" ? { startDate: "asc" } : { createdAt: "desc" },
      });

      return rows.map((r) => ({
        ...r,
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name) ?? "VACATION",
        startDate: r.startDate.toISOString().split("T")[0],
        endDate: r.endDate.toISOString().split("T")[0],
        attestValidFrom: r.attestValidFrom?.toISOString().split("T")[0] ?? null,
        attestValidTo: r.attestValidTo?.toISOString().split("T")[0] ?? null,
      }));
    },
  });

  // ── GET /overlap  – wer ist parallel abwesend? ──────────────────────────
  app.get("/overlap", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      if (!startDate || !endDate) {
        return reply.code(400).send({ error: "startDate und endDate erforderlich" });
      }

      const start = new Date(startDate);
      const end = new Date(endDate);

      const rows = await app.prisma.leaveRequest.findMany({
        where: {
          deletedAt: null,
          employee: { tenantId: req.user.tenantId },
          employeeId: { not: req.user.employeeId ?? "" },
          status: { in: ["PENDING", "APPROVED"] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true } },
        },
        orderBy: { startDate: "asc" },
      });

      return rows.map((r) => ({
        id: r.id,
        employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name) ?? "VACATION",
        typeName: r.leaveType.name,
        startDate: r.startDate.toISOString().split("T")[0],
        endDate: r.endDate.toISOString().split("T")[0],
        status: r.status,
      }));
    },
  });

  // ── PATCH /requests/:id/review  – Genehmigen / Ablehnen ─────────────────
  app.patch("/requests/:id/review", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = reviewSchema.parse(req.body);

      const existing = await app.prisma.leaveRequest.findUnique({
        where: { id },
        include: { leaveType: true },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      if (!["PENDING", "CANCELLATION_REQUESTED"].includes(existing.status)) {
        return reply.code(409).send({ error: "Antrag kann nicht mehr geändert werden" });
      }

      // Block self-approval — managers cannot approve their own requests
      const reviewerEmployee = await app.prisma.employee.findFirst({
        where: { userId: req.user.sub },
        select: { id: true },
      });
      if (reviewerEmployee && existing.employeeId === reviewerEmployee.id) {
        return reply
          .code(403)
          .send({ error: "Eigene Anträge können nicht selbst genehmigt werden" });
      }

      // ── Stornierungsantrag prüfen ────────────────────────────────────────────
      if (existing.status === "CANCELLATION_REQUESTED") {
        if (body.status === "APPROVED") {
          // Stornierung genehmigen → CANCELLED + Rückbuchung
          await app.prisma.leaveRequest.update({
            where: { id },
            data: {
              status: "CANCELLED",
              reviewedBy: req.user.sub,
              reviewedAt: new Date(),
              reviewNote: body.reviewNote,
            },
          });

          // Revalidate time entries that were created during CANCELLATION_REQUESTED
          await app.prisma.timeEntry.updateMany({
            where: {
              employeeId: existing.employeeId,
              date: { gte: existing.startDate, lte: existing.endDate },
              isInvalid: true,
              invalidReason: "Urlaubsstornierung ausstehend",
            },
            data: { isInvalid: false, invalidReason: null },
          });

          const typeCode = TYPE_CODES.find(
            (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
          );
          if (typeCode === "VACATION") {
            await app.prisma.leaveEntitlement.updateMany({
              where: {
                employeeId: existing.employeeId,
                leaveTypeId: existing.leaveTypeId,
                year: existing.startDate.getFullYear(),
              },
              data: { usedDays: { decrement: Number(existing.days) } },
            });
          }
          if (typeCode === "OVERTIME_COMP") {
            const empT = await app.prisma.employee.findUnique({
              where: { id: existing.employeeId },
              select: { tenantId: true },
            });
            const hMap = await getHolidayMap(
              app.prisma,
              empT?.tenantId ?? "",
              existing.startDate,
              existing.endDate,
            );
            const [acct, hrs] = await Promise.all([
              app.prisma.overtimeAccount.findUnique({ where: { employeeId: existing.employeeId } }),
              getScheduledHours(
                app.prisma,
                existing.employeeId,
                existing.startDate,
                existing.endDate,
                existing.halfDay,
                new Set(hMap.keys()),
              ),
            ]);
            if (acct && hrs > 0) {
              await app.prisma.overtimeAccount.update({
                where: { id: acct.id },
                data: { balanceHours: { increment: hrs } },
              });
              await app.prisma.overtimeTransaction.create({
                data: {
                  overtimeAccountId: acct.id,
                  hours: hrs,
                  type: "CORRECTION",
                  description: `Stornierung Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]}`,
                },
              });
            }
          }
        } else {
          // Stornierung ablehnen → zurück auf APPROVED
          await app.prisma.leaveRequest.update({
            where: { id },
            data: {
              status: "APPROVED",
              reviewedBy: req.user.sub,
              reviewedAt: new Date(),
              reviewNote: body.reviewNote,
            },
          });
        }

        await app.audit({
          userId: req.user.sub,
          action: body.status === "APPROVED" ? "CANCEL" : "REJECT",
          entity: "LeaveRequest",
          entityId: id,
          newValue: { cancellationDecision: body.status, reviewNote: body.reviewNote },
        });

        // Retroactive recalculation: cancellation approved (CANCELLED) affects snapshots
        if (body.status === "APPROVED") {
          await recalculateSnapshots(app, existing.employeeId, existing.startDate).catch((err) =>
            app.log.error(
              { err, employeeId: existing.employeeId },
              "Failed to recalculate snapshots after leave cancellation",
            ),
          );
        }

        const refreshed = await app.prisma.leaveRequest.findUnique({
          where: { id },
          include: { employee: { select: { firstName: true, lastName: true } }, leaveType: true },
        });
        return {
          ...refreshed,
          typeCode:
            TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === refreshed!.leaveType.name) ??
            "VACATION",
          startDate: refreshed!.startDate.toISOString().split("T")[0],
          endDate: refreshed!.endDate.toISOString().split("T")[0],
        };
      }

      // ── Normaler Antrag (PENDING) ────────────────────────────────────────────
      const updated = await app.prisma.leaveRequest.update({
        where: { id },
        data: {
          status: body.status,
          reviewedBy: req.user.sub,
          reviewedAt: new Date(),
          reviewNote: body.reviewNote,
        },
        include: {
          employee: { select: { firstName: true, lastName: true } },
          leaveType: true,
        },
      });

      if (body.status === "APPROVED") {
        const typeCode = TYPE_CODES.find(
          (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
        );

        if (typeCode === "VACATION") {
          const empForDeduct = await app.prisma.employee.findUnique({
            where: { id: existing.employeeId },
          });
          const holidayMapForDeduct = await getHolidayMap(
            app.prisma,
            empForDeduct?.tenantId ?? "",
            existing.startDate,
            existing.endDate,
          );
          await deductVacationDays(
            app.prisma,
            existing.employeeId,
            existing.leaveTypeId,
            existing.startDate,
            existing.endDate,
            Number(existing.days),
            new Set(holidayMapForDeduct.keys()),
            empForDeduct?.tenantId ?? "",
          );
        }

        if (typeCode === "OVERTIME_COMP") {
          const empTenant = await app.prisma.employee.findUnique({
            where: { id: existing.employeeId },
            select: { tenantId: true },
          });
          const hMap = await getHolidayMap(
            app.prisma,
            empTenant?.tenantId ?? "",
            existing.startDate,
            existing.endDate,
          );
          const [account, hours] = await Promise.all([
            app.prisma.overtimeAccount.findUnique({ where: { employeeId: existing.employeeId } }),
            getScheduledHours(
              app.prisma,
              existing.employeeId,
              existing.startDate,
              existing.endDate,
              existing.halfDay,
              new Set(hMap.keys()),
            ),
          ]);
          if (account && hours > 0) {
            await app.prisma.overtimeAccount.update({
              where: { id: account.id },
              data: { balanceHours: { decrement: hours } },
            });
            await app.prisma.overtimeTransaction.create({
              data: {
                overtimeAccountId: account.id,
                hours: -hours,
                type: "REDUCTION",
                description: `Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]} – ${existing.endDate.toISOString().split("T")[0]}`,
              },
            });
          }
        }
      }

      await app.audit({
        userId: req.user.sub,
        action: body.status === "APPROVED" ? "APPROVE" : "REJECT",
        entity: "LeaveRequest",
        entityId: id,
        newValue: { status: body.status, reviewNote: body.reviewNote },
      });

      // Retroactive recalculation: leave approval affects snapshots
      if (body.status === "APPROVED") {
        await recalculateSnapshots(app, existing.employeeId, existing.startDate).catch((err) =>
          app.log.error(
            { err, employeeId: existing.employeeId },
            "Failed to recalculate snapshots after leave approval",
          ),
        );
      }

      // ── Benachrichtigung: Mitarbeiter über Entscheidung informieren ──
      const requestEmployee = await app.prisma.employee.findUnique({
        where: { id: existing.employeeId },
      });
      if (requestEmployee) {
        await app.notify({
          userId: requestEmployee.userId,
          type: body.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
          title: body.status === "APPROVED" ? "Antrag genehmigt" : "Antrag abgelehnt",
          message: `Ihr ${existing.leaveType.name}-Antrag wurde ${body.status === "APPROVED" ? "genehmigt" : "abgelehnt"}.`,
          link: `/leave?request=${existing.id}`,
          tenantId: requestEmployee.tenantId,
        });
      }

      return {
        ...updated,
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === updated.leaveType.name) ?? "VACATION",
        startDate: updated.startDate.toISOString().split("T")[0],
        endDate: updated.endDate.toISOString().split("T")[0],
      };
    },
  });

  // ── PATCH /requests/:id  – Ausstehenden Antrag bearbeiten ──────────────────
  app.patch("/requests/:id", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = updateSchema.parse(req.body);

      const existing = await app.prisma.leaveRequest.findUnique({
        where: { id },
        include: { leaveType: true },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      if (existing.employeeId !== req.user.employeeId)
        return reply.code(403).send({ error: "Forbidden" });
      if (existing.status !== "PENDING")
        return reply.code(409).send({ error: "Nur ausstehende Anträge können bearbeitet werden" });

      const start = new Date(body.startDate);
      const end = new Date(body.endDate);
      if (start > end)
        return reply.code(400).send({ error: "Startdatum muss vor Enddatum liegen" });

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, start, end);
      const holidays = new Set(holidayMap.keys());
      const days = calculateWorkDays(start, end, body.halfDay, holidays);

      const updated = await app.prisma.leaveRequest.update({
        where: { id },
        data: { startDate: start, endDate: end, halfDay: body.halfDay, days, note: body.note },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveRequest",
        entityId: id,
        oldValue: existing,
        newValue: updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return {
        ...updated,
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === updated.leaveType.name) ?? "VACATION",
        startDate: updated.startDate.toISOString().split("T")[0],
        endDate: updated.endDate.toISOString().split("T")[0],
      };
    },
  });

  // ── DELETE /requests/:id  – Antrag zurückziehen ──────────────────────────
  app.delete("/requests/:id", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await app.prisma.leaveRequest.findUnique({
        where: { id },
        include: { leaveType: true },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });

      const isOwner = existing.employeeId === req.user.employeeId;
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);
      if (!isOwner && !isManager) return reply.code(403).send({ error: "Forbidden" });
      if (!["PENDING", "APPROVED"].includes(existing.status)) {
        return reply.code(409).send({ error: "Antrag kann nicht mehr zurückgezogen werden" });
      }

      if (existing.status === "APPROVED") {
        // Approved leave → request cancellation (needs another manager's approval)
        // Until approved, the leave remains active (blocks time tracking, shown in calendar)
        await app.prisma.leaveRequest.update({
          where: { id },
          data: { status: "CANCELLATION_REQUESTED" },
        });
        await app.audit({
          userId: req.user.sub,
          action: "UPDATE",
          entity: "LeaveRequest",
          entityId: id,
          oldValue: { status: existing.status },
          newValue: { status: "CANCELLATION_REQUESTED" },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(200).send({ status: "CANCELLATION_REQUESTED" });
      }

      // Ausstehender Antrag → sofort zurückziehen
      await app.prisma.leaveRequest.update({ where: { id }, data: { status: "CANCELLED" } });
      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveRequest",
        entityId: id,
        oldValue: { status: existing.status },
        newValue: { status: "CANCELLED" },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return reply.code(204).send();
    },
  });

  // ── PATCH /requests/:id/attest  – Attest-Daten setzen (nur Manager/Admin) ─
  app.patch("/requests/:id/attest", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = attestSchema.parse(req.body);

      const existing = await app.prisma.leaveRequest.findUnique({
        where: { id },
        include: { leaveType: true },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });

      const typeCode = TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name);
      if (typeCode !== "SICK" && typeCode !== "SICK_CHILD") {
        return reply.code(400).send({ error: "Attest kann nur für Krankmeldungen gesetzt werden" });
      }

      const updated = await app.prisma.leaveRequest.update({
        where: { id },
        data: {
          attestPresent: body.attestPresent,
          attestValidFrom:
            body.attestPresent && body.attestValidFrom ? new Date(body.attestValidFrom) : null,
          attestValidTo:
            body.attestPresent && body.attestValidTo ? new Date(body.attestValidTo) : null,
        },
        include: {
          leaveType: true,
          employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
        },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveRequest",
        entityId: id,
        newValue: { attest: body },
      });

      return {
        ...updated,
        typeCode: typeCode,
        startDate: updated.startDate.toISOString().split("T")[0],
        endDate: updated.endDate.toISOString().split("T")[0],
        attestValidFrom: updated.attestValidFrom?.toISOString().split("T")[0] ?? null,
        attestValidTo: updated.attestValidTo?.toISOString().split("T")[0] ?? null,
      };
    },
  });

  // ── GET /calendar  – Kalenderansicht für einen Monat ────────────────────
  app.get("/calendar", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const { year, month } = req.query as { year?: string; month?: string };
      const y = year ? parseInt(year) : new Date().getFullYear();
      const m = month ? parseInt(month) : new Date().getMonth() + 1;

      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const [rows, holidayMap] = await Promise.all([
        app.prisma.leaveRequest.findMany({
          where: {
            deletedAt: null,
            employee: { tenantId: req.user.tenantId },
            status: { in: ["PENDING", "APPROVED", "CANCELLATION_REQUESTED"] },
            startDate: { lte: end },
            endDate: { gte: start },
          },
          include: {
            leaveType: true,
            employee: { select: { firstName: true, lastName: true, userId: true } },
          },
          orderBy: { startDate: "asc" },
        }),
        getHolidayMap(app.prisma, req.user.tenantId, start, end),
      ]);

      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);

      const leaveEntries = rows.map((r) => {
        const isOwn = r.employee.userId === req.user.sub;
        const showDetails = isOwn || isManager;
        return {
          id: r.id,
          isOwn,
          firstName: r.employee.firstName,
          lastName: r.employee.lastName,
          typeCode: showDetails
            ? (TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name) ?? "VACATION")
            : null,
          typeName: showDetails ? r.leaveType.name : null,
          startDate: r.startDate.toISOString().split("T")[0],
          endDate: r.endDate.toISOString().split("T")[0],
          halfDay: r.halfDay,
          status: r.status,
          isHoliday: false,
        };
      });

      // Feiertage als eigene Einträge hinzufügen
      const holidayEntries = Array.from(holidayMap.entries()).map(([date, name]) => ({
        id: `holiday-${date}`,
        isOwn: false,
        firstName: name,
        lastName: "",
        typeCode: "HOLIDAY" as const,
        typeName: name,
        startDate: date,
        endDate: date,
        halfDay: false,
        status: "APPROVED" as const,
        isHoliday: true,
      }));

      return [...leaveEntries, ...holidayEntries];
    },
  });

  // ── GET /hours-preview  – geplante Stunden für einen Zeitraum ───────────
  app.get("/hours-preview", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { startDate, endDate, halfDay } = req.query as {
        startDate?: string;
        endDate?: string;
        halfDay?: string;
      };
      if (!startDate || !endDate) {
        return reply.code(400).send({ error: "startDate und endDate erforderlich" });
      }
      const employeeId = req.user.employeeId;
      if (!employeeId) return { hours: 0, days: 0 };

      const start = new Date(startDate);
      const end = new Date(endDate);
      const isHalf = halfDay === "true";

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, start, end);
      const holidays = new Set(holidayMap.keys());

      const [hours, days] = await Promise.all([
        getScheduledHours(app.prisma, employeeId, start, end, isHalf, holidays),
        Promise.resolve(calculateWorkDays(start, end, isHalf, holidays)),
      ]);

      return { hours: +hours.toFixed(2), days };
    },
  });

  // ── GET /overtime-balance  – eigenes Überstundensaldo ───────────────────
  app.get("/overtime-balance", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) return { balanceHours: 0 };
      const account = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
      return { balanceHours: account ? Number(account.balanceHours) : 0 };
    },
  });

  // ── GET /ical/personal  – iCal-Export eigener Abwesenheiten ─────────────
  app.get("/ical/personal", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) return reply.code(400).send({ error: "Kein Mitarbeiter-Profil" });

      const [requests, absences] = await Promise.all([
        app.prisma.leaveRequest.findMany({
          where: { employeeId, deletedAt: null, status: "APPROVED" },
          include: { leaveType: true, employee: { select: { firstName: true, lastName: true } } },
        }),
        app.prisma.absence.findMany({
          where: { employeeId, deletedAt: null },
          include: { employee: { select: { firstName: true, lastName: true } } },
        }),
      ]);

      const events: ICalEvent[] = requests.map((r) => {
        const typeCode = TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name);
        const summary = LEAVE_TYPE_DEFS[typeCode as TypeCode]?.name ?? r.leaveType.name;
        return {
          uid: `leave-${r.id}@clokr`,
          summary,
          dtstart: r.startDate.toISOString().split("T")[0],
          dtend: addOneDay(r.endDate.toISOString().split("T")[0]),
          description: r.note ?? undefined,
          status: "CONFIRMED",
          categories: typeCode ?? "VACATION",
        };
      });

      for (const a of absences) {
        const summary =
          a.type === "SICK"
            ? "Krankmeldung"
            : a.type === "SICK_CHILD"
              ? "Kinderkrank"
              : a.type === "MATERNITY"
                ? "Mutterschutz"
                : a.type === "PARENTAL"
                  ? "Elternzeit"
                  : a.type === "SPECIAL_LEAVE"
                    ? "Sonderurlaub"
                    : a.type === "UNPAID_LEAVE"
                      ? "Unbezahlter Urlaub"
                      : "Abwesenheit";
        events.push({
          uid: `absence-${a.id}@clokr`,
          summary,
          dtstart: a.startDate.toISOString().split("T")[0],
          dtend: addOneDay(a.endDate.toISOString().split("T")[0]),
          description: a.note ?? undefined,
          status: "CONFIRMED",
          categories: a.type,
        });
      }

      const ical = generateICal("Clokr – Meine Abwesenheiten", events);
      reply
        .header("Content-Type", "text/calendar; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="clokr-abwesenheiten.ics"')
        .send(ical);
    },
  });

  // ── GET /ical/team  – iCal-Export aller Team-Abwesenheiten ─────────────
  app.get("/ical/team", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const tenantId = req.user.tenantId;

      const [requests, absences] = await Promise.all([
        app.prisma.leaveRequest.findMany({
          where: { deletedAt: null, employee: { tenantId }, status: "APPROVED" },
          include: { leaveType: true, employee: { select: { firstName: true, lastName: true } } },
        }),
        app.prisma.absence.findMany({
          where: { deletedAt: null, employee: { tenantId } },
          include: { employee: { select: { firstName: true, lastName: true } } },
        }),
      ]);

      const events: ICalEvent[] = requests.map((r) => {
        const name = `${r.employee.firstName} ${r.employee.lastName}`;
        const typeCode = TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name);
        const typeName = LEAVE_TYPE_DEFS[typeCode as TypeCode]?.name ?? r.leaveType.name;
        return {
          uid: `leave-${r.id}@clokr`,
          summary: `${name} \u2014 ${typeName}`,
          dtstart: r.startDate.toISOString().split("T")[0],
          dtend: addOneDay(r.endDate.toISOString().split("T")[0]),
          description: r.note ?? undefined,
          status: "CONFIRMED",
          categories: typeCode ?? "VACATION",
        };
      });

      for (const a of absences) {
        const name = `${a.employee.firstName} ${a.employee.lastName}`;
        const summary =
          a.type === "SICK"
            ? "Krankmeldung"
            : a.type === "SICK_CHILD"
              ? "Kinderkrank"
              : a.type === "MATERNITY"
                ? "Mutterschutz"
                : a.type === "PARENTAL"
                  ? "Elternzeit"
                  : a.type === "SPECIAL_LEAVE"
                    ? "Sonderurlaub"
                    : a.type === "UNPAID_LEAVE"
                      ? "Unbezahlter Urlaub"
                      : "Abwesenheit";
        events.push({
          uid: `absence-${a.id}@clokr`,
          summary: `${name} \u2014 ${summary}`,
          dtstart: a.startDate.toISOString().split("T")[0],
          dtend: addOneDay(a.endDate.toISOString().split("T")[0]),
          description: a.note ?? undefined,
          status: "CONFIRMED",
          categories: a.type,
        });
      }

      const ical = generateICal("Clokr – Team-Abwesenheiten", events);
      reply
        .header("Content-Type", "text/calendar; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="clokr-team-abwesenheiten.ics"')
        .send(ical);
    },
  });

  // ── GET /entitlements/:employeeId ─────────────────────────────────────────
  app.get("/entitlements/:employeeId", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const { employeeId } = req.params as { employeeId: string };
      const { year } = req.query as { year?: string };
      const targetYear = year ? parseInt(year) : new Date().getFullYear();
      const tenantId = req.user.tenantId;

      // Resturlaub auto-übertragen falls nötig
      const vacTypeId = await ensureLeaveType(app.prisma, tenantId, "VACATION");
      await autoCarryOver(app.prisma, tenantId, employeeId, vacTypeId, targetYear);

      const rows = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId, ...(year ? { year: targetYear } : {}) },
        include: { leaveType: true },
      });

      // Alle LeaveType-IDs die zu VACATION gehören (inkl. Legacy "Jahresurlaub")
      const vacationNames = [LEAVE_TYPE_DEFS.VACATION.name, ...(LEGACY_ALIASES.VACATION ?? [])];
      const allVacTypeIds = (
        await app.prisma.leaveType.findMany({
          where: { tenantId, name: { in: vacationNames } },
          select: { id: true },
        })
      ).map((t) => t.id);

      // usedDays aus tatsächlich genehmigten Anträgen neu berechnen
      for (const row of rows) {
        const isVacation = vacationNames.includes(row.leaveType.name);
        const typeIds = isVacation ? allVacTypeIds : [row.leaveTypeId];
        const yearStart = new Date(`${row.year}-01-01T00:00:00Z`);
        const yearEnd = new Date(`${row.year}-12-31T23:59:59Z`);
        const approved = await app.prisma.leaveRequest.findMany({
          where: {
            employeeId,
            deletedAt: null,
            leaveTypeId: { in: typeIds },
            status: "APPROVED",
            startDate: { gte: yearStart },
            endDate: { lte: yearEnd },
          },
        });
        const actualUsed = approved.reduce((s, r) => s + Number(r.days), 0);
        if (Number(row.usedDays) !== actualUsed) {
          await app.prisma.leaveEntitlement.update({
            where: { id: row.id },
            data: { usedDays: actualUsed },
          });
          (row as unknown as { usedDays: number }).usedDays = actualUsed;
        }
      }

      // typeCode + effektiven Resturlaub im Response markieren
      return rows.map((r) => ({
        ...r,
        typeCode: (Object.entries(LEAVE_TYPE_DEFS).find(
          ([, d]) => d.name === r.leaveType.name,
        )?.[0] ?? "VACATION") as TypeCode,
        effectiveCarryOverDays: getEffectiveCarryOver(r, new Date()),
        carryOverDeadline: r.carryOverDeadline?.toISOString().split("T")[0] ?? null,
      }));
    },
  });
}

/**
 * Überträgt automatisch nicht genommene Urlaubstage des Vorjahres als Resturlaub
 * ins aktuelle Jahr — sofern das noch nicht passiert ist.
 * Wird lazy bei jedem Urlaubsantrag und Kontoabruf aufgerufen.
 */
async function autoCarryOver(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  year: number,
): Promise<void> {
  const prevYear = year - 1;

  // Vorjahres-Entitlement holen
  const prev = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: prevYear } },
  });
  if (!prev) return;

  const remaining = Number(prev.totalDays) + Number(prev.carriedOverDays) - Number(prev.usedDays);
  if (remaining <= 0) return;

  // Bereits übertragen? → abbrechen
  const cur = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });
  if (cur && Number(cur.carriedOverDays) > 0) return;

  // Verfallsdatum aus TenantConfig
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId } });
  const deadlineDay = config?.carryOverDeadlineDay ?? 31;
  const deadlineMonth = config?.carryOverDeadlineMonth ?? 3;
  const deadline = new Date(year, deadlineMonth - 1, deadlineDay, 23, 59, 59);

  if (cur) {
    await prisma.leaveEntitlement.update({
      where: { id: cur.id },
      data: { carriedOverDays: remaining, carryOverDeadline: deadline },
    });
  } else {
    await prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId,
        year,
        totalDays: 0,
        usedDays: 0,
        carriedOverDays: remaining,
        carryOverDeadline: deadline,
      },
    });
  }
}

/**
 * Recalculates carry-over for a given year based on the previous year's current state.
 * Called after every booking/cancellation to keep projected carry-over accurate.
 */
async function recalculateCarryOver(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  year: number,
): Promise<void> {
  const prevYear = year - 1;
  const prev = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: prevYear } },
  });
  if (!prev) return;

  const remaining = Math.max(
    0,
    Number(prev.totalDays) + Number(prev.carriedOverDays) - Number(prev.usedDays),
  );

  const config = await prisma.tenantConfig.findUnique({ where: { tenantId } });
  const deadlineDay = config?.carryOverDeadlineDay ?? 31;
  const deadlineMonth = config?.carryOverDeadlineMonth ?? 3;
  const deadline = new Date(year, deadlineMonth - 1, deadlineDay, 23, 59, 59);

  const cur = await prisma.leaveEntitlement.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  });

  if (cur) {
    await prisma.leaveEntitlement.update({
      where: { id: cur.id },
      data: { carriedOverDays: remaining, carryOverDeadline: deadline },
    });
  } else {
    await prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId,
        year,
        totalDays: 0,
        usedDays: 0,
        carriedOverDays: remaining,
        carryOverDeadline: deadline,
      },
    });
  }
}

/**
 * Gibt den effektiven Resturlaub zurück — 0 wenn der Verfall bereits eingetreten ist.
 */
function getEffectiveCarryOver(
  entitlement: { carriedOverDays: Prisma.Decimal | number; carryOverDeadline: Date | null },
  referenceDate: Date,
): number {
  const carryOver = Number(entitlement.carriedOverDays);
  if (carryOver <= 0) return 0;
  if (!entitlement.carryOverDeadline) return carryOver; // kein Verfall konfiguriert
  return referenceDate <= entitlement.carryOverDeadline ? carryOver : 0;
}

/**
 * Zieht Urlaubstage vom Entitlement ab: Resturlaub (sofern nicht verfallen) zuerst,
 * danach reguläre Tage.
 */
async function deductVacationDays(
  prisma: FastifyInstance["prisma"],
  employeeId: string,
  leaveTypeId: string,
  startDate: Date,
  endDate: Date,
  totalDays: number,
  holidays: Set<string>,
  tenantId: string,
): Promise<void> {
  const year1 = startDate.getFullYear();
  const year2 = endDate.getFullYear();
  const isCrossYear = year1 !== year2;

  if (isCrossYear) {
    // Split days across years
    const split = splitDaysAcrossYears(startDate, endDate, false, holidays);

    // Deduct from year 1
    if (split.year1Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year1 },
        data: { usedDays: { increment: split.year1Days } },
      });
    }

    // Deduct from year 2
    if (split.year2Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year2 },
        data: { usedDays: { increment: split.year2Days } },
      });
    }

    // Recalculate carry-over for year 2 (year 1 remaining changed)
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year2);
  } else {
    // Single year: increment usedDays
    await prisma.leaveEntitlement.updateMany({
      where: { employeeId, leaveTypeId, year: year1 },
      data: { usedDays: { increment: totalDays } },
    });

    // Recalculate next year's carry-over (current year usage changed)
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year1 + 1);
  }
}

/**
 * Gibt eine Map<dateStr, holidayName> für den angegebenen Zeitraum zurück.
 * Berücksichtigt das Bundesland des Tenants sowie manuell eingetragene Feiertage.
 */
async function getHolidayMap(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  start: Date,
  end: Date,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!tenantId) return map;

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const stateCode = tenant?.federalState ? STATE_MAP[tenant.federalState] : undefined;

  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    for (const h of getHolidays(y, stateCode ?? null)) {
      if (h.date >= startStr && h.date <= endStr) map.set(h.date, h.name);
    }
  }

  // Manuelle Feiertage aus der DB
  const manual = await prisma.publicHoliday.findMany({
    where: { tenantId, date: { gte: start, lte: end } },
  });
  for (const h of manual) map.set(h.date.toISOString().split("T")[0], h.name);

  return map;
}

function calculateWorkDays(
  start: Date,
  end: Date,
  halfDay: boolean,
  holidays: Set<string> = new Set(),
): number {
  if (halfDay) return 0.5;
  let days = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    const ds = cur.toISOString().split("T")[0];
    if (dow !== 0 && dow !== 6 && !holidays.has(ds)) days++;
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

/**
 * Berechnet die tatsächlich geplanten Arbeitsstunden für einen Zeitraum
 * basierend auf dem individuellen WorkSchedule des Mitarbeiters (oder den
 * globalen Tenant-Defaults falls kein individueller Plan vorhanden).
 * Halbe Tage = halbe Stunden des ersten Arbeitstages.
 */
async function getScheduledHours(
  prisma: FastifyInstance["prisma"],
  employeeId: string,
  start: Date,
  end: Date,
  halfDay: boolean,
  holidays: Set<string> = new Set(),
): Promise<number> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: {
      workSchedules: {
        where: { validFrom: { lte: start } },
        orderBy: { validFrom: "desc" },
        take: 1,
      },
      tenant: { include: { config: true } },
    },
  });

  const ws = employee?.workSchedules[0] ?? null;
  const cfg = employee?.tenant?.config;

  // Stunden pro Wochentag (0=So, 1=Mo … 6=Sa)
  const h: Record<number, number> = {
    0: 0,
    1: ws ? Number(ws.mondayHours) : Number(cfg?.defaultMondayHours ?? 8),
    2: ws ? Number(ws.tuesdayHours) : Number(cfg?.defaultTuesdayHours ?? 8),
    3: ws ? Number(ws.wednesdayHours) : Number(cfg?.defaultWednesdayHours ?? 8),
    4: ws ? Number(ws.thursdayHours) : Number(cfg?.defaultThursdayHours ?? 8),
    5: ws ? Number(ws.fridayHours) : Number(cfg?.defaultFridayHours ?? 8),
    6: ws ? Number(ws.saturdayHours) : Number(cfg?.defaultSaturdayHours ?? 0),
  };

  if (halfDay) {
    // Halber erster Arbeitstag (Feiertage überspringen)
    const cur = new Date(start);
    while (cur <= end) {
      const dow = cur.getDay();
      const ds = cur.toISOString().split("T")[0];
      if (h[dow] > 0 && !holidays.has(ds)) return h[dow] / 2;
      cur.setDate(cur.getDate() + 1);
    }
    return 0;
  }

  let total = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const ds = cur.toISOString().split("T")[0];
    if (!holidays.has(ds)) total += h[cur.getDay()];
    cur.setDate(cur.getDate() + 1);
  }
  return total;
}
