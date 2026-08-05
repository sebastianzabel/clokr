import { FastifyInstance } from "fastify";
import { z } from "zod";
import { LeaveRequestStatus, Prisma } from "@clokr/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { getTenantTimezone, monthRangeUtc } from "../utils/timezone";
import { generateICal, addOneDay, type ICalEvent } from "../utils/ical";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";
import { splitDaysAcrossYears, calculateProRataVacation } from "../utils/vacation-calc";
import { selfHealUsedDays, loadVacationTypeMeta } from "../utils/leave-self-heal";
import { calculateWorkDays } from "../utils/calculate-work-days";
import { computeAffectedMonths } from "../utils/correction-lock";
import { periodStartWindow } from "../utils/snapshot-period";
import { updateOvertimeAccount } from "./time-entries";

/**
 * A Prisma client that may be either the top-level app.prisma or an interactive
 * transaction client (Prisma.TransactionClient). Entitlement/overtime helpers accept
 * this union so the leave-correction handler can run them inside a single
 * $transaction (Phase 94 CR-01: atomic reverse-OLD → apply-NEW booking).
 */
type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

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
    // Manager-on-behalf-of: when set, the caller (must be MANAGER or ADMIN) creates
    // the request for this employee instead of themselves. Tenant isolation is enforced.
    employeeId: z.string().uuid().optional(),
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

// Phase 94-01: Manager/Admin DIRECT-correction of an already-APPROVED request.
// Mirrors updateSchema but adds an optional `type` switch (type-specific recalc
// split lands in 94-02 — stored uniformly here).
const correctSchema = z
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
    type: z.enum(TYPE_CODES).optional(),
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

      // Manager-on-behalf-of: caller must be MANAGER or ADMIN, target employee must
      // belong to the caller's tenant. Otherwise fall back to self-create.
      let employeeId: string | null | undefined;
      let isOnBehalfOf = false;
      if (body.employeeId && body.employeeId !== req.user.employeeId) {
        if (req.user.role !== "MANAGER" && req.user.role !== "ADMIN") {
          return reply.code(403).send({ error: "Nur Manager dürfen Anträge für andere stellen" });
        }
        const target = await app.prisma.employee.findFirst({
          where: { id: body.employeeId, tenantId: req.user.tenantId },
          select: { id: true },
        });
        if (!target) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
        employeeId = body.employeeId;
        isOnBehalfOf = true;
      } else {
        employeeId = req.user.employeeId;
      }
      if (!employeeId) return reply.code(400).send({ error: "Kein Mitarbeiter-Profil" });

      const start = new Date(body.startDate);
      const end = new Date(body.endDate);
      if (start > end)
        return reply.code(400).send({ error: "Startdatum muss vor Enddatum liegen" });

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, start, end);
      const holidays = new Set(holidayMap.keys());
      const workDays = await resolveWorkDays(app.prisma, employeeId, tenantId);
      const days = calculateWorkDays(start, end, body.halfDay, workDays, holidays);

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

      // ── Half-day sick rejection ──
      // Legal: teilweise Arbeitsunfähigkeit gibt es nicht; Krankheit wird immer
      // ganztägig gutgeschrieben (EFZG §3/§4). Half-day only applies to vacation.
      if (body.halfDay && ["SICK", "SICK_CHILD"].includes(body.type)) {
        return reply.code(400).send({
          error:
            "Halbe Kranktage sind nicht zulässig — Krankheit wird immer ganztägig gutgeschrieben.",
        });
      }

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
          ? splitDaysAcrossYears(start, end, body.halfDay, workDays, holidays)
          : { year1Days: days, year2Days: 0, year1, year2 };

        // § 5 Abs. 2 BUrlG: fetch exit date once so both year-1 and year-2 blocks can use it.
        // Hoisted out of the year-1 guard so cross-year bookings can apply the H1 cap to year 2.
        const empForExit = await app.prisma.employee.findUnique({
          where: { id: employeeId, tenantId },
          select: { exitDate: true },
        });
        const exitDate = empForExit?.exitDate ?? null;

        // ── Year 1: check entitlement ──
        await autoCarryOver(app.prisma, tenantId, employeeId, leaveTypeId, year1);
        const ent1 = await app.prisma.leaveEntitlement.findUnique({
          where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: year1 } },
        });
        if (ent1 && split.year1Days > 0) {
          // EuGH C-684/16: pre-fetch whether a warning was issued for this entitlement
          const hinweis1 =
            (await app.prisma.auditLog.count({
              where: { action: "CARRYOVER_WARNED", entity: "LeaveEntitlement", entityId: ent1.id },
            })) > 0;
          const co1 = getEffectiveCarryOver(ent1, start, hinweis1);
          const avail1 = Number(ent1.totalDays) + co1 - Number(ent1.usedDays);

          // § 5 Abs. 2 BUrlG: H1 exits are capped at pro-rata entitlement.
          // Carry-over days are prior-year entitlement already accrued and are not subject to
          // § 5 Abs. 2 BUrlG pro-ration (which applies only to the current-year "Urlaubsanspruch").
          // Therefore only `totalDays` (current-year entitlement) is passed to calculateProRataVacation,
          // and the cap comparison uses `usedDays` directly (carry-over usage already deducted by
          // the normal avail1 path; the H1 path caps new-year days independently).
          if (exitDate && exitDate.getFullYear() === year1 && exitDate.getMonth() < 6) {
            const proRata = calculateProRataVacation(Number(ent1.totalDays), year1, exitDate);
            const used = Number(ent1.usedDays);
            if (split.year1Days > proRata - used) {
              return reply.code(400).send({
                error: `Anteiliger Urlaub bei Austritt in H1 überschritten (${proRata} Tage anteilig)`,
                available: proRata - used,
                requested: split.year1Days,
              });
            }
          } else if (split.year1Days > avail1) {
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
            // EuGH C-684/16: pre-fetch whether a warning was issued for this entitlement
            const hinweis2 =
              (await app.prisma.auditLog.count({
                where: {
                  action: "CARRYOVER_WARNED",
                  entity: "LeaveEntitlement",
                  entityId: ent2.id,
                },
              })) > 0;
            const co2 = getEffectiveCarryOver(ent2, end, hinweis2);
            let avail2 = Number(ent2.totalDays) + co2 - Number(ent2.usedDays);

            // § 5 Abs. 2 BUrlG: apply H1 cap symmetrically to year 2 when employee exits in H1
            // of year 2 (mirrors the year-1 check above for cross-year bookings).
            // Carry-over is excluded from the cap base for the same reason as year 1.
            if (exitDate && exitDate.getFullYear() === year2 && exitDate.getMonth() < 6) {
              const proRata2 = calculateProRataVacation(Number(ent2.totalDays), year2, exitDate);
              avail2 = Math.min(avail2, proRata2 - Number(ent2.usedDays));
            }

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
        newValue: {
          type: body.type,
          startDate: body.startDate,
          endDate: body.endDate,
          days,
          ...(isOnBehalfOf && {
            source: "MANAGER_CREATED",
            actorRole: req.user.role,
            targetEmployeeId: employeeId,
          }),
        },
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
          relatedType: "LeaveRequest",
          relatedId: request.id,
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

      const existing = await app.prisma.leaveRequest.findFirst({
        where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
        include: { leaveType: true, employee: { select: { tenantId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      // Tenant isolation check (SEC-V1814-03 / D-02): fetch-then-compare via employee.tenantId
      if (existing.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }
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

      // 4-eyes: block cancellation-approval by the person who requested the cancellation (COMP-V1814-02)
      if (existing.cancellationRequestedBy && req.user.sub === existing.cancellationRequestedBy) {
        return reply
          .code(403)
          .send({ error: "Stornierung kann nicht vom Antragsteller genehmigt werden" });
      }
      // 4-eyes: block cancellation-approval by the manager who originally approved the leave (COMP-V1814-02)
      if (existing.reviewedBy && req.user.sub === existing.reviewedBy) {
        return reply
          .code(403)
          .send({ error: "Stornierung kann nicht vom ursprünglichen Genehmiger genehmigt werden" });
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
              deletedAt: null, // D-08: never touch soft-deleted entries
              isLocked: false, // D-08: never mutate locked-month entries (Revisionssicherheit)
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
          // WR-02: do NOT overwrite reviewedBy here — it must keep pointing to the
          // original leave approver so the 4-eyes check (line 608) still blocks that
          // person from approving a subsequent cancellation request.  The rejection
          // reviewer is captured in the AuditLog REJECT entry below.
          await app.prisma.leaveRequest.update({
            where: { id },
            data: {
              status: "APPROVED",
              // reviewedBy intentionally NOT updated — preserves original approver identity
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
          await updateOvertimeAccount(app, existing.employeeId).catch((err) =>
            app.log.error(
              { err, employeeId: existing.employeeId },
              "Failed to update overtime account after leave cancellation",
            ),
          );
        }

        // Auto-dismiss manager LEAVE_REQUEST notifications for this request
        try {
          await app.dismissByRelated("LeaveRequest", existing.id);
        } catch (err) {
          app.log.warn(
            { err, leaveRequestId: existing.id },
            "Failed to auto-dismiss LEAVE_REQUEST notifications on cancellation review",
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
        await updateOvertimeAccount(app, existing.employeeId).catch((err) =>
          app.log.error(
            { err, employeeId: existing.employeeId },
            "Failed to update overtime account after leave approval",
          ),
        );

        // Phase 43-04: reverse-hook — when a leave is APPROVED, mark any
        // existing shifts for this employee on overlapping dates as
        // conflictsWithLeave=true (audit-proof: never silent-delete shifts).
        // Best-effort: never roll back the approval if marking fails.
        try {
          const conflictingShifts = await app.prisma.shift.findMany({
            where: {
              employeeId: existing.employeeId,
              date: { gte: existing.startDate, lte: existing.endDate },
              conflictsWithLeave: false,
              deletedAt: null, // Phase 67.2 — leave-approval hook only flags ACTIVE shifts
            },
            select: { id: true, date: true, startTime: true, endTime: true, label: true },
          });

          if (conflictingShifts.length > 0) {
            await app.prisma.shift.updateMany({
              where: { id: { in: conflictingShifts.map((s) => s.id) } },
              data: { conflictsWithLeave: true },
            });

            for (const s of conflictingShifts) {
              await app
                .audit({
                  userId: req.user.sub,
                  action: "SHIFT_MARKED_CONFLICTING",
                  entity: "Shift",
                  entityId: s.id,
                  newValue: {
                    leaveRequestId: existing.id,
                    leaveStart: existing.startDate.toISOString().slice(0, 10),
                    leaveEnd: existing.endDate.toISOString().slice(0, 10),
                    shiftDate: s.date.toISOString().slice(0, 10),
                    shiftLabel: s.label,
                  },
                  request: { ip: req.ip, headers: req.headers as Record<string, string> },
                })
                .catch((err) =>
                  app.log.warn({ err, shiftId: s.id }, "Failed to audit SHIFT_MARKED_CONFLICTING"),
                );
            }

            // Notify managers — find all MANAGER + ADMIN users in the tenant
            try {
              const empName = await app.prisma.employee.findUnique({
                where: { id: existing.employeeId },
                select: { firstName: true, lastName: true, tenantId: true },
              });
              if (empName) {
                const managers = await app.prisma.user.findMany({
                  where: {
                    isActive: true,
                    role: { in: ["MANAGER", "ADMIN"] },
                    employee: { tenantId: empName.tenantId },
                  },
                  select: { id: true },
                });
                const dStart = existing.startDate.toLocaleDateString("de-DE");
                const dEnd = existing.endDate.toLocaleDateString("de-DE");
                for (const mgr of managers) {
                  await app
                    .notify({
                      userId: mgr.id,
                      type: "SHIFT_LEAVE_CONFLICT",
                      title: `Schicht-Konflikt: ${empName.firstName} ${empName.lastName}`,
                      message: `Genehmigter Urlaub vom ${dStart} bis ${dEnd} überschneidet sich mit ${conflictingShifts.length} Schicht(en). Bitte überprüfen Sie /shifts.`,
                      link: "/shifts",
                      tenantId: empName.tenantId,
                      relatedType: "LeaveRequest",
                      relatedId: existing.id,
                    })
                    .catch((err) =>
                      app.log.warn(
                        { err, managerId: mgr.id },
                        "Failed to notify manager of SHIFT_LEAVE_CONFLICT",
                      ),
                    );
                }
              }
            } catch (err) {
              app.log.warn({ err }, "SHIFT_LEAVE_CONFLICT manager-notify pass failed");
            }
          }
        } catch (err) {
          // Reverse-hook is best-effort — never undo the approval on failure
          app.log.error(
            { err, leaveRequestId: existing.id },
            "Phase 43-04 reverse-hook (mark-conflicting shifts) failed",
          );
        }
      }

      // ── Pro-rata Urlaubswarnung bei Genehmigung (nur VACATION, nur bei exitDate) ──
      let proRataWarning: { used: number; entitlement: number; message: string } | undefined =
        undefined;
      if (body.status === "APPROVED") {
        const typeCodeForWarning = TYPE_CODES.find(
          (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
        );
        if (typeCodeForWarning === "VACATION") {
          try {
            const empWithExit = await app.prisma.employee.findUnique({
              where: { id: existing.employeeId },
              select: { exitDate: true, tenantId: true },
            });
            if (empWithExit?.exitDate) {
              const exitYear = empWithExit.exitDate.getFullYear();
              // § 5 Abs. 2 BUrlG: H2 exits (July–December) receive full entitlement — no pro-rata
              // cap applies, so no warning is possible. Guard against false-positive warnings.
              if (empWithExit.exitDate.getMonth() < 6) {
                const vacLeaveType = await app.prisma.leaveType.findFirst({
                  where: { tenantId: empWithExit.tenantId, name: "Urlaub" },
                });
                if (vacLeaveType) {
                  const entitlement = await app.prisma.leaveEntitlement.findFirst({
                    where: {
                      employeeId: existing.employeeId,
                      leaveTypeId: vacLeaveType.id,
                      year: exitYear,
                    },
                  });
                  if (entitlement) {
                    const proRata = calculateProRataVacation(
                      Number(entitlement.totalDays),
                      exitYear,
                      empWithExit.exitDate,
                    );
                    const used = Number(entitlement.usedDays);
                    if (used > proRata) {
                      proRataWarning = {
                        used,
                        entitlement: proRata,
                        message: `Achtung: Der Mitarbeiter hat mehr Urlaub genommen oder genehmigt (${used} Tage) als ihm anteilig zusteht (${proRata} Tage). Bitte prüfen Sie, ob eine Rückforderung nötig ist.`,
                      };
                    }
                  }
                }
              }
            }
          } catch (err) {
            app.log.warn({ err }, "Pro-rata warning calculation failed silently in leave review");
          }
        }
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

      // Auto-dismiss manager LEAVE_REQUEST notifications for this request
      try {
        await app.dismissByRelated("LeaveRequest", existing.id);
      } catch (err) {
        app.log.warn(
          { err, leaveRequestId: existing.id },
          "Failed to auto-dismiss LEAVE_REQUEST notifications on review",
        );
      }

      return {
        ...updated,
        typeCode:
          TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === updated.leaveType.name) ?? "VACATION",
        startDate: updated.startDate.toISOString().split("T")[0],
        endDate: updated.endDate.toISOString().split("T")[0],
        ...(proRataWarning ? { proRataWarning } : {}),
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

      const existing = await app.prisma.leaveRequest.findFirst({
        where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
        include: { leaveType: true },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      if (existing.employeeId !== req.user.employeeId)
        return reply.code(403).send({ error: "Forbidden" });
      if (existing.status !== "PENDING")
        return reply.code(409).send({ error: "Nur ausstehende Anträge können bearbeitet werden" });

      // ── Half-day sick rejection (legal: teilweise AU gibt es nicht) ──
      const existingTypeCode = TYPE_CODES.find(
        (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
      );
      if (body.halfDay && (existingTypeCode === "SICK" || existingTypeCode === "SICK_CHILD")) {
        return reply.code(400).send({
          error:
            "Halbe Kranktage sind nicht zulässig — Krankheit wird immer ganztägig gutgeschrieben.",
        });
      }

      const start = new Date(body.startDate);
      const end = new Date(body.endDate);
      if (start > end)
        return reply.code(400).send({ error: "Startdatum muss vor Enddatum liegen" });

      const tenantId = req.user.tenantId;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, start, end);
      const holidays = new Set(holidayMap.keys());
      const workDays = await resolveWorkDays(app.prisma, existing.employeeId, tenantId);
      const days = calculateWorkDays(start, end, body.halfDay, workDays, holidays);

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

  // ── PATCH .../correct  – Manager DIRECT-Korrektur eines
  //    bereits GENEHMIGTEN Antrags (EDIT-01/02/03) ─────────────────────────
  // Erlaubt es einer Führungskraft, einen genehmigten Antrag (z.B. eine lange
  // Elternzeit) direkt zu verkürzen/anzupassen — ohne den heutigen Stornierungs-
  // Roundtrip. Guard-Reihenfolge (CONTEXT): tenant(404+Audit) → authz(requireRole)
  // → Status APPROVED(409) → Delta-Lock(409) → Domänen-Validierung(400).
  app.patch("/requests/:id/correct", {
    schema: { tags: ["Abwesenheiten"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = correctSchema.parse(req.body);

      const existing = await app.prisma.leaveRequest.findFirst({
        where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
        include: { leaveType: true, employee: { select: { tenantId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });

      // Tenant isolation (SEC-V1814-03 / D-02): fetch-then-compare via employee.tenantId
      if (existing.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }

      // Nur GENEHMIGTE Anträge sind direkt korrigierbar (EDIT-01, per CONTEXT).
      if (existing.status !== "APPROVED") {
        return reply.code(409).send({ error: "Nur genehmigte Anträge können korrigiert werden" });
      }

      // start <= end ist bereits durch correctSchema.refine (Zod → 400) garantiert.
      const start = new Date(body.startDate);
      const end = new Date(body.endDate);

      // ── Delta-Lock guard (EDIT-03 / T-94-01) ───────────────────────────────
      // Blocks (409) any correction whose CHANGED days (symmetric date diff; plus
      // retained days when type/halfDay changed) touch a finalized (locked) month.
      // The retained overlap of a shortened leave stays untouched, so shortening a
      // long Elternzeit at its unlocked tail is allowed even if early months closed.
      const existingTypeCode = TYPE_CODES.find(
        (c) => LEAVE_TYPE_DEFS[c].name === existing.leaveType.name,
      );
      const typeChanged = body.type != null && body.type !== existingTypeCode;
      const halfDayChanged = body.halfDay !== existing.halfDay;
      const affectedMonths = computeAffectedMonths({
        oldStart: existing.startDate,
        oldEnd: existing.endDate,
        newStart: start,
        newEnd: end,
        typeChanged,
        halfDayChanged,
      });
      if (affectedMonths.length > 0) {
        const tz = await getTenantTimezone(app.prisma, existing.employee.tenantId);
        for (const { year, month } of affectedMonths) {
          const { start: monthStart } = monthRangeUtc(year, month, tz);
          // MONTHLY SaldoSnapshot(superseded:false) = the canonical Monatsabschluss
          // signal (convention-robust window, see utils/snapshot-period.ts).
          const locked = await app.prisma.saldoSnapshot.findFirst({
            where: {
              employeeId: existing.employeeId,
              periodType: "MONTHLY",
              periodStart: periodStartWindow(monthStart),
              superseded: false,
            },
          });
          if (locked) {
            return reply.code(409).send({ error: "Gesperrter Monat — Korrektur nicht möglich" });
          }
        }
      }

      // ── Recalc model (94-02): REVERSE the OLD booking (by the OLD leaveType),
      //    then APPLY the NEW booking (by the NEW leaveType). Never branches on
      //    the effective type alone — that would leave a VACATION/OVERTIME_COMP
      //    day consumed when corrected INTO a sick type. All domain guards run
      //    PRE-WRITE so a rejected correction never leaves a partial saldo write.
      const tenantId = req.user.tenantId;
      const oldTypeCode = existingTypeCode; // from existing.leaveType.name (delta-lock step)
      const newType = body.type ?? oldTypeCode;

      // ── Step 7a: half-day-sick reject (pre-write) — Krankheit ist immer ganztägig.
      if (body.halfDay && (newType === "SICK" || newType === "SICK_CHILD")) {
        return reply.code(400).send({
          error:
            "Halbe Kranktage sind nicht zulässig — Krankheit wird immer ganztägig gutgeschrieben.",
        });
      }

      // ── Step 7b: overlap guard (pre-write) for a CHANGED date range. Excludes
      //    the request itself (id:{not}). An identical-range correction (type/
      //    halfDay-only) introduces no new collision, so it is not re-checked.
      const dateChanged =
        start.getTime() !== existing.startDate.getTime() ||
        end.getTime() !== existing.endDate.getTime();
      if (dateChanged) {
        const overlap = await app.prisma.leaveRequest.findFirst({
          where: {
            employeeId: existing.employeeId,
            deletedAt: null,
            status: { in: ["PENDING", "APPROVED"] },
            startDate: { lte: end },
            endDate: { gte: start },
            id: { not: existing.id },
          },
        });
        if (overlap) {
          return reply.code(409).send({ error: "Überschneidung mit bestehendem Antrag" });
        }
      }

      // Holidays across the UNION of old+new range: the reverse needs the OLD
      // range, the apply + day recompute need the NEW range.
      const unionStart = existing.startDate < start ? existing.startDate : start;
      const unionEnd = existing.endDate > end ? existing.endDate : end;
      const holidayMap = await getHolidayMap(app.prisma, tenantId, unionStart, unionEnd);
      const holidays = new Set(holidayMap.keys());
      const workDays = await resolveWorkDays(app.prisma, existing.employeeId, tenantId);
      const days = calculateWorkDays(start, end, body.halfDay, workDays, holidays);

      // Resolve the NEW leaveTypeId when the type changed (ensureLeaveType migrates
      // legacy names / creates the canonical type on demand).
      const newLeaveTypeId =
        typeChanged && body.type != null
          ? await ensureLeaveType(app.prisma, tenantId, body.type)
          : existing.leaveTypeId;

      // ── Steps 8-11 run inside ONE interactive transaction (94 CR-01) ──────────
      //    The correction issues TWO authoritative ledger writes (reverse OLD +
      //    apply NEW). Without a transaction a mid-sequence failure would leave the
      //    OLD booking reversed but the NEW one unapplied — permanently corrupting
      //    the vacation Kontingent (usedDays is never self-healed by the recalc
      //    tail). All pre-write guards (half-day-sick 400, overlap 409, delta-lock
      //    409) already ran ABOVE, so a rejection never opens the transaction.
      const updated = await app.prisma.$transaction(async (tx) => {
        // ── Step 8: REVERSE the OLD booking (dispatch on the OLD typeCode) ──────
        if (oldTypeCode === "VACATION") {
          await reverseVacationDays(
            tx,
            existing.employeeId,
            existing.leaveTypeId,
            existing.startDate,
            existing.endDate,
            Number(existing.days),
            holidays,
            tenantId,
          );
        } else if (oldTypeCode === "OVERTIME_COMP") {
          const acct = await tx.overtimeAccount.findUnique({
            where: { employeeId: existing.employeeId },
          });
          const hrs = await getScheduledHours(
            tx,
            existing.employeeId,
            existing.startDate,
            existing.endDate,
            existing.halfDay,
            holidays,
          );
          if (acct && hrs > 0) {
            await tx.overtimeAccount.update({
              where: { id: acct.id },
              data: { balanceHours: { increment: hrs } },
            });
            await tx.overtimeTransaction.create({
              data: {
                overtimeAccountId: acct.id,
                hours: hrs,
                type: "CORRECTION",
                description: `Korrektur Überstundenausgleich ${existing.startDate.toISOString().split("T")[0]}`,
              },
            });
          }
        }
        // SICK / SICK_CHILD / PARENTAL / MATERNITY / SPECIAL / UNPAID / EDUCATION:
        // entitlement-neutral on the reverse side (no usedDays / balance booking).

        // ── Step 9: update the row (94-01 base + NEW leaveTypeId) ───────────────
        const updatedRow = await tx.leaveRequest.update({
          where: { id },
          data: {
            startDate: start,
            endDate: end,
            halfDay: body.halfDay,
            days,
            note: body.note,
            leaveTypeId: newLeaveTypeId,
          },
          include: {
            leaveType: true,
            employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
          },
        });

        // ── Step 10: APPLY the NEW booking (dispatch on the NEW typeCode) ───────
        //    "Light" for Krankheit = NO entitlement apply on the new side (it does
        //    NOT skip the OLD-side reversal nor the recalc tail).
        if (newType === "VACATION") {
          await deductVacationDays(
            tx,
            existing.employeeId,
            newLeaveTypeId,
            start,
            end,
            days,
            holidays,
            tenantId,
          );
        } else if (newType === "OVERTIME_COMP") {
          const acct = await tx.overtimeAccount.findUnique({
            where: { employeeId: existing.employeeId },
          });
          const hrs = await getScheduledHours(
            tx,
            existing.employeeId,
            start,
            end,
            body.halfDay,
            holidays,
          );
          if (acct && hrs > 0) {
            await tx.overtimeAccount.update({
              where: { id: acct.id },
              data: { balanceHours: { decrement: hrs } },
            });
            await tx.overtimeTransaction.create({
              data: {
                overtimeAccountId: acct.id,
                hours: -hrs,
                type: "REDUCTION",
                description: `Überstundenausgleich ${start.toISOString().split("T")[0]} – ${end.toISOString().split("T")[0]}`,
              },
            });
          }
        }
        // SICK / SICK_CHILD / PARENTAL / MATERNITY / SPECIAL / UNPAID / EDUCATION:
        // entitlement-neutral on the apply side (light).

        // ── Step 11: revalidate removed-day time entries (old range \ new range).
        //    A shortened/moved leave frees days whose leave-caused invalidation must
        //    be cleared. Delta-lock already guarantees these fall in unlocked months;
        //    locked / soft-deleted entries are never touched (Revisionssicherheit).
        const revalidateRemoved = async (from: Date, to: Date) => {
          if (from > to) return;
          await tx.timeEntry.updateMany({
            where: {
              employeeId: existing.employeeId,
              date: { gte: from, lte: to },
              isInvalid: true,
              invalidReason: "Urlaubsstornierung ausstehend",
              deletedAt: null,
              isLocked: false,
            },
            data: { isInvalid: false, invalidReason: null },
          });
        };
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        if (start > existing.startDate) {
          // head removed: [oldStart .. newStart-1]
          await revalidateRemoved(existing.startDate, new Date(start.getTime() - ONE_DAY_MS));
        }
        if (end < existing.endDate) {
          // tail removed: [newEnd+1 .. oldEnd]
          await revalidateRemoved(new Date(end.getTime() + ONE_DAY_MS), existing.endDate);
        }

        return updatedRow;
      });

      // Revisionssicherheit (EDIT-02): jede Korrektur wird LEAVE_CORRECTED-auditiert.
      await app.audit({
        userId: req.user.sub,
        action: "LEAVE_CORRECTED",
        entity: "LeaveRequest",
        entityId: id,
        oldValue: existing,
        newValue: updated,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Saldo-Recalc: ab dem FRÜHEREN von alt/neu Start, damit ein erweiterter
      // Bereich vom richtigen Monat an neu berechnet wird (EDIT / T-94-05).
      const recalcFrom = existing.startDate < start ? existing.startDate : start;
      await recalculateSnapshots(app, existing.employeeId, recalcFrom).catch((err) =>
        app.log.error(
          { err, employeeId: existing.employeeId },
          "Failed to recalculate snapshots after leave correction",
        ),
      );
      await updateOvertimeAccount(app, existing.employeeId).catch((err) =>
        app.log.error(
          { err, employeeId: existing.employeeId },
          "Failed to update overtime account after leave correction",
        ),
      );

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
      const existing = await app.prisma.leaveRequest.findFirst({
        where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
        include: { leaveType: true, employee: { select: { tenantId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      // Tenant isolation check (SEC-V1814-03 / D-02): tenant BEFORE isOwner/isManager (D-05)
      if (existing.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }

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
          data: { status: "CANCELLATION_REQUESTED", cancellationRequestedBy: req.user.sub },
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

      const existing = await app.prisma.leaveRequest.findFirst({
        where: { id, deletedAt: null }, // D-09: soft-deleted requests are not-found
        include: { leaveType: true, employee: { select: { tenantId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: "Antrag nicht gefunden" });
      // Tenant isolation check (SEC-V1814-03 / D-02): fetch-then-compare via employee.tenantId
      if (existing.employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "LeaveRequest",
          entityId: id,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Antrag nicht gefunden" });
      }

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
            employee: { select: { id: true, firstName: true, lastName: true, userId: true } },
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
          employeeId: r.employeeId,
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
      const workDays = await resolveWorkDays(app.prisma, employeeId, tenantId);

      const [hours, days] = await Promise.all([
        getScheduledHours(app.prisma, employeeId, start, end, isHalf, holidays),
        Promise.resolve(calculateWorkDays(start, end, isHalf, workDays, holidays)),
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
      // Plan 74-03 / D-05: respect the test-only X-Test-Now header so the
      // year-boundary E2E flows can pin "now" deterministically. The
      // testBootstrap plugin only registers the hook when
      // ALLOW_TEST_BOOTSTRAP=true; on int + prod `req.testNow` is always
      // undefined and we fall through to the real clock.
      const now = req.testNow ?? new Date();
      const targetYear = year ? parseInt(year) : now.getFullYear();
      const tenantId = req.user.tenantId;

      // Resturlaub auto-übertragen falls nötig
      const vacTypeId = await ensureLeaveType(app.prisma, tenantId, "VACATION");
      await autoCarryOver(app.prisma, tenantId, employeeId, vacTypeId, targetYear);

      const rows = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId, ...(year ? { year: targetYear } : {}) },
        include: { leaveType: true },
      });

      // Vacation type meta — shared with selfHealUsedDays AND the pro-rata mapping below
      const vacMeta = await loadVacationTypeMeta(app.prisma, tenantId);
      const { vacationNames } = vacMeta;

      // Fetch exitDate for pro-rata effective entitlement computation (§ 5 Abs. 2 BUrlG)
      const empForEntitlement = await app.prisma.employee.findUnique({
        where: { id: employeeId, tenantId },
        select: { exitDate: true },
      });
      const employeeExitDate = empForEntitlement?.exitDate ?? null;

      // Self-heal usedDays from Σ approved LeaveRequest.days.
      // Same logic the report endpoint now uses — see apps/api/src/utils/leave-self-heal.ts.
      await selfHealUsedDays(app.prisma, rows, vacMeta);

      // EuGH C-684/16: batch-fetch which entitlements have a documented warning so the
      // synchronous rows.map() can call getEffectiveCarryOver with the hinweisIssued flag.
      // A single query covers all entitlement ids — no N+1 (rows per employee+year are bounded).
      const warnedEntitlementIds = new Set(
        (
          await app.prisma.auditLog.findMany({
            where: {
              action: "CARRYOVER_WARNED",
              entity: "LeaveEntitlement",
              entityId: { in: rows.map((r) => r.id) },
            },
            select: { entityId: true },
            distinct: ["entityId"],
          })
        ).map((al) => al.entityId!),
      );

      // typeCode + effektiven Resturlaub + anteiligen Urlaubsanspruch im Response markieren
      return rows.map((r) => {
        const isVacationRow = vacationNames.includes(r.leaveType.name);
        const effectiveEntitlementDays =
          isVacationRow && employeeExitDate
            ? calculateProRataVacation(Number(r.totalDays), r.year, employeeExitDate)
            : Number(r.totalDays);
        return {
          ...r,
          typeCode: (Object.entries(LEAVE_TYPE_DEFS).find(
            ([, d]) => d.name === r.leaveType.name,
          )?.[0] ?? "VACATION") as TypeCode,
          effectiveCarryOverDays: getEffectiveCarryOver(r, now, warnedEntitlementIds.has(r.id)),
          carryOverDeadline: r.carryOverDeadline?.toISOString().split("T")[0] ?? null,
          effectiveEntitlementDays,
        };
      });
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
  prisma: DbClient,
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
 * Gibt den effektiven Resturlaub zurück.
 *
 * EuGH C-684/16 (Hinweispflicht, docs/burlg-carryover.md): Resturlaub verfällt am
 * Stichtag nur dann, wenn der Arbeitgeber den Arbeitnehmer zuvor ausdrücklich auf
 * den bevorstehenden Verfall hingewiesen hat (CARRYOVER_WARNED AuditLog-Eintrag).
 * Ohne dokumentierten Hinweis bleibt der Anspruch erhalten.
 *
 * @param hinweisIssued - true wenn ein CARRYOVER_WARNED-AuditLog für dieses
 *   LeaveEntitlement existiert (vor dem Aufruf per count-Query zu ermitteln).
 */
function getEffectiveCarryOver(
  entitlement: { carriedOverDays: Prisma.Decimal | number; carryOverDeadline: Date | null },
  referenceDate: Date,
  hinweisIssued: boolean,
): number {
  const carryOver = Number(entitlement.carriedOverDays);
  if (carryOver <= 0) return 0;
  if (!entitlement.carryOverDeadline) return carryOver; // kein Verfall konfiguriert
  if (referenceDate <= entitlement.carryOverDeadline) return carryOver; // Stichtag noch nicht erreicht
  if (!hinweisIssued) return carryOver; // EuGH C-684/16: kein Verfall ohne dokumentierten Hinweis
  return 0;
}

/**
 * Zieht Urlaubstage vom Entitlement ab: Resturlaub (sofern nicht verfallen) zuerst,
 * danach reguläre Tage.
 */
async function deductVacationDays(
  prisma: DbClient,
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
    // Split days across years — using the employee's own workDays
    const workDays = await resolveWorkDays(prisma, employeeId, tenantId);
    const split = splitDaysAcrossYears(startDate, endDate, false, workDays, holidays);

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
 * Symmetrischer Gegenpart zu deductVacationDays (Phase 94-02): bucht Urlaubstage
 * wieder ZURÜCK, wenn eine genehmigte Urlaubskorrektur den alten Buchungsstand
 * rückgängig macht. DECREMENTIERT usedDays pro Jahr (cross-year via
 * splitDaysAcrossYears) und rechnet den Folgejahres-Übertrag neu — NICHT der naive
 * Single-Year-Decrement, damit ein jahresübergreifender Urlaub korrekt zurückgebucht
 * wird (T-94-07).
 */
async function reverseVacationDays(
  prisma: DbClient,
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
    const workDays = await resolveWorkDays(prisma, employeeId, tenantId);
    const split = splitDaysAcrossYears(startDate, endDate, false, workDays, holidays);

    if (split.year1Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year1 },
        data: { usedDays: { decrement: split.year1Days } },
      });
    }
    if (split.year2Days > 0) {
      await prisma.leaveEntitlement.updateMany({
        where: { employeeId, leaveTypeId, year: year2 },
        data: { usedDays: { decrement: split.year2Days } },
      });
    }

    // Year 1 remaining changed → recompute year 2 carry-over
    await recalculateCarryOver(prisma, tenantId, employeeId, leaveTypeId, year2);
  } else {
    await prisma.leaveEntitlement.updateMany({
      where: { employeeId, leaveTypeId, year: year1 },
      data: { usedDays: { decrement: totalDays } },
    });

    // Current year usage changed → recompute next year's carry-over
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

// calculateWorkDays moved to ../utils/calculate-work-days (Phase 61).

/**
 * Lädt das aktuell gültige workDays-Set für einen Mitarbeiter.
 *
 * Reihenfolge:
 * 1. Für FIXED_SCHEDULE: aus per-Tag-Soll abgeleitet (Stunden > 0 = Arbeitstag).
 *    Das erlaubt individuelle Verteilung wie Frisör Di-Sa ohne separate UI.
 * 2. Sonst: WorkSchedule.workDays (Pro-MA-Override aus /admin/vacation).
 * 3. Sonst: TenantConfig.defaultWorkDays.
 * 4. Sonst: Mo-Fr.
 */
async function resolveWorkDays(
  prisma: DbClient,
  employeeId: string,
  tenantId: string,
): Promise<number[]> {
  const [ws, cfg] = await Promise.all([
    prisma.workSchedule.findFirst({
      where: { employeeId },
      orderBy: { validFrom: "desc" },
    }),
    prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { defaultWorkDays: true },
    }),
  ]);
  if (ws) {
    // FIXED_SCHEDULE: per-Tag-Soll ist die präziseste Quelle (Frisör Di-Sa wird hier sichtbar)
    if (ws.type === "FIXED_SCHEDULE") {
      const fields: Array<[number, number]> = [
        [0, Number(ws.sundayHours)],
        [1, Number(ws.mondayHours)],
        [2, Number(ws.tuesdayHours)],
        [3, Number(ws.wednesdayHours)],
        [4, Number(ws.thursdayHours)],
        [5, Number(ws.fridayHours)],
        [6, Number(ws.saturdayHours)],
      ];
      const derived = fields
        .filter(([, h]) => h > 0)
        .map(([d]) => d)
        .sort((a, b) => a - b);
      if (derived.length > 0) return derived;
    }
    if (ws.workDays && ws.workDays.length > 0) return ws.workDays;
  }
  if (cfg?.defaultWorkDays && cfg.defaultWorkDays.length > 0) return cfg.defaultWorkDays;
  return [1, 2, 3, 4, 5];
}

/**
 * Berechnet die tatsächlich geplanten Arbeitsstunden für einen Zeitraum
 * basierend auf dem individuellen WorkSchedule des Mitarbeiters (oder den
 * globalen Tenant-Defaults falls kein individueller Plan vorhanden).
 * Halbe Tage = halbe Stunden des ersten Arbeitstages.
 *
 * KNOWN GAP — SHIFT_BASED schedules (deferred from Phase 49.5):
 * For SHIFT_BASED employees this returns the wrong number because it reads
 * the per-Tag-Soll fields (mondayHours…sundayHours) on the WorkSchedule,
 * which are not authoritative for SHIFT_BASED — their real hours live in
 * the `Shift` table. OVERTIME_COMP saldo deductions are therefore inaccurate
 * for shift-based users.
 *
 * The correct fix is to detect `schedule.scheduleType === "SHIFT_BASED"` and
 * branch to `prisma.shift.findMany({ where: { employeeId, date: { gte: start, lte: end } } })`,
 * summing each shift's `(endTime - startTime - breakMinutes)` in hours.
 *
 * Acceptance trigger: only implement once UAT reports a concrete OVERTIME_COMP
 * saldo mismatch for a SHIFT_BASED employee. See the v1.6 milestone audit
 * (`.planning/milestones/v1.6-MILESTONE-AUDIT.md`) tech_debt entry for
 * `49.5-arbeitstage-woche-config` and the phase SUMMARY's "Known Stubs"
 * section for the original deferral rationale.
 */
async function getScheduledHours(
  prisma: DbClient,
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
    0: ws ? Number(ws.sundayHours) : Number(cfg?.defaultSundayHours ?? 0), // D-07: was hardcoded 0 (Sunday workers)
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
