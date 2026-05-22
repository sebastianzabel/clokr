import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../middleware/auth";
import { FederalState } from "@clokr/db";
import { encrypt } from "../utils/crypto";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";

const VALID_FEDERAL_STATES = Object.values(FederalState) as string[];

const tenantConfigSchema = z
  .object({
    tenantName: z.string().min(1).max(200).optional(),
    applyToExisting: z.boolean().optional(), // Auf bestehende MA ohne manuelle Änderung anwenden
    defaultWeeklyHours: z.number().min(1).max(60).optional(),
    defaultMondayHours: z.number().min(0).max(24).optional(),
    defaultTuesdayHours: z.number().min(0).max(24).optional(),
    defaultWednesdayHours: z.number().min(0).max(24).optional(),
    defaultThursdayHours: z.number().min(0).max(24).optional(),
    defaultFridayHours: z.number().min(0).max(24).optional(),
    defaultSaturdayHours: z.number().min(0).max(24).optional(),
    defaultSundayHours: z.number().min(0).max(24).optional(),
    overtimeThreshold: z.number().min(1).max(500).optional(),
    allowOvertimePayout: z.boolean().optional(),
    federalState: z
      .string()
      .refine((s) => VALID_FEDERAL_STATES.includes(s))
      .optional(),
    carryOverDeadlineDay: z.number().int().min(1).max(31).optional(),
    carryOverDeadlineMonth: z.number().int().min(1).max(12).optional(),
    defaultVacationDays: z.number().min(0.5).max(365).multipleOf(0.5).optional(),
    timezone: z.string().min(1).max(100).optional(),
    arbzgEnabled: z.boolean().optional(),
    // Phase 47.3 — Verfügbarkeits-System toggle (default true, feature-on)
    availabilityEnabled: z.boolean().optional(),
    clockOutReminderHours: z.number().int().min(1).max(48).optional(),
    missingEntriesDays: z.number().int().min(1).max(90).optional(),
    autoDeleteOpenHours: z.number().int().min(0).max(168).optional(), // legacy name: actually invalidates, not deletes
    autoBreakEnabled: z.boolean().optional(),
    defaultBreakStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    // Heiligabend/Silvester
    christmasEveRule: z.enum(["NORMAL", "HALF_DAY", "FULL_DAY_OFF"]).optional(),
    newYearsEveRule: z.enum(["NORMAL", "HALF_DAY", "FULL_DAY_OFF"]).optional(),
    holidayRulesValidFromYear: z.number().int().min(2020).max(2100).optional(),
    // Leave config
    vacationLeadTimeDays: z.number().int().min(0).max(365).optional(),
    vacationMaxAdvanceMonths: z.number().int().min(0).max(24).optional(),
    halfDayAllowed: z.boolean().optional(),
    sickSelfReport: z.boolean().optional(),
    sickNoteRequiredAfterDays: z.number().int().min(1).max(30).optional(),
    // Part-time vacation
    autoCalcPartTimeVacation: z.boolean().optional(),
    fullTimeWorkDaysPerWeek: z.number().int().min(1).max(7).optional(),
    // Carry-over / statutory minimum
    enforceMinVacation: z.boolean().optional(),
    carryOverRequiresReason: z.boolean().optional(),
    vacationReminderStartMonth: z.number().int().min(1).max(12).optional(),
    // BUrlG § 7 Hinweispflicht (EuGH C-684/16) — threshold-based warnings
    carryoverWarningEnabled: z.boolean().optional(),
    carryoverWarningThresholds: z.array(z.number().int().min(1).max(365)).max(10).optional(),
    // Data retention (Phase 31 — ADM-03)
    // Minimum 2 years (§ 16 Abs. 2 ArbZG), default 10 years (§ 147 AO / § 257 HGB)
    dataRetentionYears: z.number().int().min(2).max(10).optional(),
    // Reminders
    reminderPendingLeaveHours: z.number().int().min(1).max(720).optional(),
    reminderUpcomingAbsenceDays: z.number().int().min(1).max(30).optional(),
    reminderPendingLeaveEnabled: z.boolean().optional(),
    reminderUpcomingAbsenceEnabled: z.boolean().optional(),
    // DATEV Lohnartennummern (Phase 4 — DATEV-03)
    datevNormalstundenNr: z.number().int().min(1).max(9999).optional(),
    datevUrlaubNr: z.number().int().min(1).max(9999).optional(),
    datevKrankNr: z.number().int().min(1).max(9999).optional(),
    datevSonderurlaubNr: z.number().int().min(1).max(9999).optional(),
    // MONTHLY_HOURS Feiertagsabzug (Phase 15 — TENANT-01)
    monthlyHoursHolidayDeduction: z.boolean().optional(),
    // Ladenöffnungszeiten (Phase 42) — 7 entries Mo-So
    storeHours: z
      .array(
        z.object({
          day: z.number().int().min(0).max(6),
          open: z.string().regex(/^\d{2}:\d{2}$/),
          close: z.string().regex(/^\d{2}:\d{2}$/),
          closed: z.boolean().optional(),
        }),
      )
      .length(7)
      .optional(),
    // Phase 47.5 — STRICT / DAY_ONLY / OFF
    shiftStoreHoursMode: z.enum(["STRICT", "DAY_ONLY", "OFF"]).optional(),
    // Phase 49.2 — FLEXTIME Kernarbeitszeit-Defaults (tenant-level pre-fill suggestion)
    defaultCoreStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
      .nullable()
      .optional(),
    defaultCoreEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
      .nullable()
      .optional(),
    defaultCoreDays: z.array(z.number().int().min(0).max(6)).optional(),
    // Phase 49.5 — Standard-Arbeitstage Mo-So (Tenant-Default)
    defaultWorkDays: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Mindestens ein Arbeitstag muss aktiv sein")
      .max(7)
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Half-null guard: defaultCoreStart and defaultCoreEnd must be set together or both absent
    if (
      (data.defaultCoreStart && !data.defaultCoreEnd) ||
      (!data.defaultCoreStart && data.defaultCoreEnd)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultCoreEnd"],
        message: "Kernzeitbeginn und Kernzeitende müssen gemeinsam gesetzt oder beide leer sein",
      });
    }
    // Both present: coreEnd must be strictly after coreStart (HH:MM string comparison)
    if (
      data.defaultCoreStart &&
      data.defaultCoreEnd &&
      data.defaultCoreEnd <= data.defaultCoreStart
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultCoreEnd"],
        message: "Kernzeitende muss nach Kernzeitbeginn liegen",
      });
    }
  });

const vacationEntitlementSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  totalDays: z.number().min(0).max(365),
  carriedOverDays: z.number().min(0).max(365).optional(),
  carryOverDeadline: z.string().nullable().optional(), // ISO date string or null
});

export const employeeScheduleSchema = z
  .object({
    type: z
      .enum(["FIXED_SCHEDULE", "FLEXTIME", "MONTHLY_HOURS", "SHIFT_BASED"])
      .default("FIXED_SCHEDULE"),
    weeklyHours: z.number().min(0).max(60).nullable().optional().default(40),
    monthlyHours: z.number().min(0).max(999).nullable().optional(),
    mondayHours: z.number().min(0).max(24).default(8),
    tuesdayHours: z.number().min(0).max(24).default(8),
    wednesdayHours: z.number().min(0).max(24).default(8),
    thursdayHours: z.number().min(0).max(24).default(8),
    fridayHours: z.number().min(0).max(24).default(8),
    saturdayHours: z.number().min(0).max(24).default(0),
    sundayHours: z.number().min(0).max(24).default(0),
    overtimeThreshold: z.number().min(0).max(500).default(60),
    allowOvertimePayout: z.boolean().default(false),
    overtimeMode: z.enum(["CARRY_FORWARD", "TRACK_ONLY"]).default("CARRY_FORWARD"),
    maxNegativeBalanceMinutes: z.number().int().min(0).nullable().optional(),
    // Phase 49.1 — FLEXTIME Kernarbeitszeit (all optional; UI metadata only)
    coreStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
      .nullable()
      .optional(),
    coreEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
      .nullable()
      .optional(),
    coreDays: z.array(z.number().int().min(0).max(6)).optional().default([]),
    // Phase 49.5 — Arbeitstage/Woche (unabhängig vom AZ-Modell)
    workDays: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Mindestens ein Arbeitstag muss aktiv sein")
      .max(7)
      .optional(),
    validFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    // Phase 49.3 — Orphan-Shift-Lifecycle: when switching away from SHIFT_BASED,
    // caller must explicitly choose what to do with future shifts.
    // Exactly one (or neither) of these flags may be true.
    keepOrphanShifts: z.boolean().optional(),
    cancelOrphanShifts: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    // SHIFT_BASED and FLEXTIME both require weeklyHours > 0 (weekly-target models)
    if (
      (data.type === "SHIFT_BASED" || data.type === "FLEXTIME") &&
      (!data.weeklyHours || data.weeklyHours <= 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["weeklyHours"],
        message: "Wochenstunden-Soll muss größer als 0 sein",
      });
    }
    // FLEXTIME Kernarbeitszeit cross-field: must be set together or both empty.
    // Half-null case (only one provided) is invalid — would leave a dangling Kernzeit.
    if ((data.coreStart && !data.coreEnd) || (!data.coreStart && data.coreEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coreEnd"],
        message: "Kernzeitbeginn und Kernzeitende müssen gemeinsam gesetzt oder beide leer sein",
      });
    }
    // Both present: coreEnd must be strictly greater than coreStart
    // (string comparison works for HH:MM)
    if (data.coreStart && data.coreEnd && data.coreEnd <= data.coreStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coreEnd"],
        message: "Kernzeitende muss nach Kernzeitbeginn liegen",
      });
    }
    // Phase 49.3 — keepOrphanShifts and cancelOrphanShifts are mutually exclusive
    if (data.keepOrphanShifts && data.cancelOrphanShifts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancelOrphanShifts"],
        message: "keepOrphanShifts und cancelOrphanShifts schließen sich gegenseitig aus",
      });
    }
  });

export async function settingsRoutes(app: FastifyInstance) {
  // GET /api/v1/settings/work  — globale Vorgaben
  app.get("/work", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const [config, tenant] = await Promise.all([
        app.prisma.tenantConfig.findUnique({ where: { tenantId } }),
        app.prisma.tenant.findUnique({ where: { id: tenantId } }),
      ]);

      const base = config ?? {
        tenantId,
        defaultWeeklyHours: 40,
        defaultMondayHours: 8,
        defaultTuesdayHours: 8,
        defaultWednesdayHours: 8,
        defaultThursdayHours: 8,
        defaultFridayHours: 8,
        defaultSaturdayHours: 0,
        defaultSundayHours: 0,
        overtimeThreshold: 60,
        allowOvertimePayout: false,
        carryOverDeadlineDay: 31,
        carryOverDeadlineMonth: 3,
        defaultVacationDays: 30,
        arbzgEnabled: true,
        availabilityEnabled: true,
        clockOutReminderHours: 10,
        missingEntriesDays: 7,
        autoDeleteOpenHours: 14,
        autoBreakEnabled: false,
        defaultBreakStart: null,
        christmasEveRule: "NORMAL",
        newYearsEveRule: "NORMAL",
        holidayRulesValidFromYear: new Date().getFullYear(),
        vacationLeadTimeDays: 0,
        vacationMaxAdvanceMonths: 0,
        halfDayAllowed: true,
        sickSelfReport: true,
        sickNoteRequiredAfterDays: 3,
        autoCalcPartTimeVacation: true,
        fullTimeWorkDaysPerWeek: 5,
        enforceMinVacation: true,
        carryOverRequiresReason: true,
        vacationReminderStartMonth: 10,
        reminderPendingLeaveHours: 48,
        reminderUpcomingAbsenceDays: 3,
        reminderPendingLeaveEnabled: true,
        reminderUpcomingAbsenceEnabled: true,
        datevNormalstundenNr: 100,
        datevUrlaubNr: 300,
        datevKrankNr: 200,
        datevSonderurlaubNr: 302,
        monthlyHoursHolidayDeduction: false,
        dataRetentionYears: 10,
        carryoverWarningEnabled: true,
        carryoverWarningThresholds: [60, 30, 14, 7],
        storeHours: [
          { day: 0, open: "08:00", close: "20:00" },
          { day: 1, open: "08:00", close: "20:00" },
          { day: 2, open: "08:00", close: "20:00" },
          { day: 3, open: "08:00", close: "20:00" },
          { day: 4, open: "08:00", close: "20:00" },
          { day: 5, open: "08:00", close: "20:00" },
          { day: 6, open: "08:00", close: "20:00", closed: true },
        ],
        shiftStoreHoursMode: "DAY_ONLY",
        defaultCoreStart: null,
        defaultCoreEnd: null,
        defaultCoreDays: [],
        // Phase 49.5 — Tenant-Default Arbeitstage (Mo-Fr)
        defaultWorkDays: [1, 2, 3, 4, 5],
      };

      return {
        ...base,
        federalState: tenant?.federalState ?? "NIEDERSACHSEN",
        tenantName: tenant?.name ?? "",
      };
    },
  });

  // PUT /api/v1/settings/work  — globale Vorgaben speichern (nur Admin)
  app.put("/work", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const body = tenantConfigSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      // federalState + tenantName gehören zum Tenant, nicht zur TenantConfig
      const { federalState, tenantName, applyToExisting, ...configBody } = body;

      // Build tenant update data (name + federalState live on Tenant model)
      const tenantUpdate: Record<string, unknown> = {};
      if (federalState) tenantUpdate.federalState = federalState as FederalState;
      if (tenantName !== undefined) tenantUpdate.name = tenantName;

      const [config] = await Promise.all([
        app.prisma.tenantConfig.upsert({
          where: { tenantId },
          update: configBody,
          create: { tenantId, ...configBody },
        }),
        Object.keys(tenantUpdate).length > 0
          ? app.prisma.tenant.update({
              where: { id: tenantId },
              data: tenantUpdate,
            })
          : Promise.resolve(null),
      ]);

      // Auf bestehende MA anwenden: Neue Schedule-Version für alle MA,
      // deren aktueller Schedule noch den alten Defaults entspricht
      let appliedCount = 0;
      if (applyToExisting) {
        const employees = await app.prisma.employee.findMany({
          where: { tenantId },
          include: { workSchedules: { orderBy: { validFrom: "desc" }, take: 1 } },
        });

        const now = new Date();
        for (const emp of employees) {
          const current = emp.workSchedules[0];
          if (!current) {
            // MA ohne Schedule → neuen mit Defaults erstellen
            const created = await app.prisma.workSchedule.create({
              data: {
                employeeId: emp.id,
                type: "FIXED_SCHEDULE",
                weeklyHours: configBody.defaultWeeklyHours ?? 40,
                mondayHours: configBody.defaultMondayHours ?? 8,
                tuesdayHours: configBody.defaultTuesdayHours ?? 8,
                wednesdayHours: configBody.defaultWednesdayHours ?? 8,
                thursdayHours: configBody.defaultThursdayHours ?? 8,
                fridayHours: configBody.defaultFridayHours ?? 8,
                saturdayHours: configBody.defaultSaturdayHours ?? 0,
                sundayHours: configBody.defaultSundayHours ?? 0,
                overtimeThreshold: configBody.overtimeThreshold ?? 60,
                allowOvertimePayout: configBody.allowOvertimePayout ?? false,
                validFrom: now,
              },
            });
            await app.audit({
              userId: req.user.sub,
              action: "CREATE",
              entity: "WorkSchedule",
              entityId: created.id,
              newValue: created,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });
            appliedCount++;
          } else if (current.type === "FIXED_SCHEDULE") {
            // Nur FIXED_SCHEDULE MA updaten (nicht Minijobber)
            const created = await app.prisma.workSchedule.create({
              data: {
                employeeId: emp.id,
                type: "FIXED_SCHEDULE",
                weeklyHours: configBody.defaultWeeklyHours ?? Number(current.weeklyHours),
                mondayHours: configBody.defaultMondayHours ?? Number(current.mondayHours),
                tuesdayHours: configBody.defaultTuesdayHours ?? Number(current.tuesdayHours),
                wednesdayHours: configBody.defaultWednesdayHours ?? Number(current.wednesdayHours),
                thursdayHours: configBody.defaultThursdayHours ?? Number(current.thursdayHours),
                fridayHours: configBody.defaultFridayHours ?? Number(current.fridayHours),
                saturdayHours: configBody.defaultSaturdayHours ?? Number(current.saturdayHours),
                sundayHours: configBody.defaultSundayHours ?? Number(current.sundayHours),
                overtimeThreshold:
                  configBody.overtimeThreshold ?? Number(current.overtimeThreshold),
                allowOvertimePayout: configBody.allowOvertimePayout ?? current.allowOvertimePayout,
                validFrom: now,
              },
            });
            await app.audit({
              userId: req.user.sub,
              action: "CREATE",
              entity: "WorkSchedule",
              entityId: created.id,
              oldValue: current,
              newValue: created,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });
            appliedCount++;
          }
        }
      }

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "TenantConfig",
        entityId: config.id,
        newValue: { ...body, appliedCount },
      });

      return { ...config, federalState: federalState ?? undefined, appliedCount };
    },
  });

  // GET /api/v1/settings/work/:employeeId  — Arbeitszeit eines Mitarbeiters
  app.get("/work/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);

      if (!isManager && req.user.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId },
        orderBy: { validFrom: "desc" },
      });
      if (!schedule) return reply.code(404).send({ error: "Kein Arbeitszeitmodell gefunden" });

      return schedule;
    },
  });

  // PUT /api/v1/settings/work/:employeeId  — Arbeitszeit eines Mitarbeiters setzen
  app.put("/work/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const body = employeeScheduleSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const validFrom = new Date(body.validFrom ?? new Date().toISOString().split("T")[0]);

      // ── Phase 49.3 — Orphan-Shift-Lifecycle detection ──────────────────────
      // When switching FROM SHIFT_BASED to any other type, check for future shifts.
      // Past shifts (date < today) are immutable (Phase 47.2) and are never touched.
      if (body.type !== "SHIFT_BASED") {
        // Resolve the current (prior) effective schedule for this employee
        const priorSchedule = await app.prisma.workSchedule.findFirst({
          where: { employeeId, validFrom: { lte: new Date() } },
          orderBy: { validFrom: "desc" },
          select: { type: true },
        });

        if (priorSchedule?.type === "SHIFT_BASED") {
          // Build today's ISO date string for "future shifts" threshold.
          // We compare date (YYYY-MM-DD) string directly — no timezone conversion
          // needed because Shift.date is stored as @db.Date (calendar date, not instant).
          const now = new Date();
          const todayIso =
            `${now.getFullYear()}-` +
            `${String(now.getMonth() + 1).padStart(2, "0")}-` +
            `${String(now.getDate()).padStart(2, "0")}`;

          // Count future shifts (today and beyond are "future" for this check)
          const futureShifts = await app.prisma.shift.findMany({
            where: {
              employeeId,
              date: { gte: new Date(todayIso) },
            },
            orderBy: { date: "asc" },
            select: { id: true, date: true, startTime: true, endTime: true },
          });

          if (futureShifts.length > 0 && !body.keepOrphanShifts && !body.cancelOrphanShifts) {
            // Neither flag set — ask the client what to do
            return reply.code(409).send({
              error: "Pending shifts",
              code: "ORPHAN_SHIFTS_PENDING",
              pendingShifts: futureShifts.length,
              shiftPreview: futureShifts.slice(0, 3).map((s) => ({
                date: s.date.toISOString().split("T")[0],
                startTime: s.startTime,
                endTime: s.endTime,
              })),
            });
          }

          if (body.cancelOrphanShifts && futureShifts.length > 0) {
            // cancelOrphanShifts: hard-delete all future shifts + audit each one,
            // then write the WorkSchedule change — all in one $transaction.
            const futureShiftIds = futureShifts.map((s) => s.id);
            const scheduleData = {
              type: body.type,
              weeklyHours: body.weeklyHours,
              monthlyHours: body.monthlyHours ?? null,
              mondayHours: body.mondayHours,
              tuesdayHours: body.tuesdayHours,
              wednesdayHours: body.wednesdayHours,
              thursdayHours: body.thursdayHours,
              fridayHours: body.fridayHours,
              saturdayHours: body.saturdayHours,
              sundayHours: body.sundayHours,
              overtimeThreshold: body.overtimeThreshold,
              allowOvertimePayout: body.allowOvertimePayout,
              overtimeMode: body.overtimeMode,
              coreStart: body.coreStart ?? null,
              coreEnd: body.coreEnd ?? null,
              coreDays: body.coreDays ?? [],
              // Phase 49.5 — optional workDays override
              ...(body.workDays ? { workDays: body.workDays } : {}),
              validFrom,
            };

            const existingForDate = await app.prisma.workSchedule.findFirst({
              where: { employeeId, validFrom },
            });

            // $transaction returns the created/updated schedule via Promise.
            const schedule = await app.prisma.$transaction(async (tx) => {
              // 1. Delete all future shifts
              await tx.shift.deleteMany({ where: { id: { in: futureShiftIds } } });

              // 2. Write the WorkSchedule change and return it so the transaction
              //    result is the schedule (TypeScript can narrow the type)
              if (existingForDate) {
                return tx.workSchedule.update({
                  where: { id: existingForDate.id },
                  data: scheduleData,
                });
              } else {
                return tx.workSchedule.create({
                  data: { employeeId, ...scheduleData },
                });
              }
            });

            // 3. Audit each deleted shift (outside $transaction so failures don't
            //    roll back the schedule change; audit is best-effort but typed)
            for (const shift of futureShifts) {
              await app.audit({
                userId: req.user.sub,
                action: "DELETE",
                entity: "Shift",
                entityId: shift.id,
                oldValue: { ...shift, note: "SHIFT_CANCELLED_SCHEDULE_TYPE_CHANGE" },
                newValue: null,
                request: { ip: req.ip, headers: req.headers as Record<string, string> },
              });
            }

            await app.audit({
              userId: req.user.sub,
              action: "UPDATE",
              entity: "WorkSchedule",
              entityId: schedule.id,
              oldValue: existingForDate,
              newValue: schedule,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });

            if (validFrom < new Date()) {
              await recalculateSnapshots(app, employeeId, validFrom).catch((err) =>
                app.log.error(
                  { err, employeeId },
                  "Failed to recalculate snapshots after schedule change",
                ),
              );
            }

            return schedule;
          }
          // keepOrphanShifts: true → fall through to normal write below (no shift changes)
        }
      }
      // ── end Phase 49.3 ────────────────────────────────────────────────────

      const scheduleData = {
        type: body.type,
        weeklyHours: body.weeklyHours,
        monthlyHours: body.monthlyHours ?? null,
        mondayHours: body.mondayHours,
        tuesdayHours: body.tuesdayHours,
        wednesdayHours: body.wednesdayHours,
        thursdayHours: body.thursdayHours,
        fridayHours: body.fridayHours,
        saturdayHours: body.saturdayHours,
        sundayHours: body.sundayHours,
        overtimeThreshold: body.overtimeThreshold,
        allowOvertimePayout: body.allowOvertimePayout,
        overtimeMode: body.overtimeMode,
        coreStart: body.coreStart ?? null,
        coreEnd: body.coreEnd ?? null,
        coreDays: body.coreDays ?? [],
        // Phase 49.5 — optional workDays override
        ...(body.workDays ? { workDays: body.workDays } : {}),
        validFrom,
      };

      // Check if a schedule with the exact same validFrom exists
      const existing = await app.prisma.workSchedule.findFirst({
        where: { employeeId, validFrom },
      });

      let schedule;
      const old = existing;
      if (existing) {
        schedule = await app.prisma.workSchedule.update({
          where: { id: existing.id },
          data: scheduleData,
        });
      } else {
        schedule = await app.prisma.workSchedule.create({
          data: { employeeId, ...scheduleData },
        });
      }

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "WorkSchedule",
        entityId: schedule.id,
        oldValue: old,
        newValue: schedule,
      });

      // Retroactive recalculation: if validFrom is in the past,
      // recalculate affected snapshots
      if (validFrom < new Date()) {
        await recalculateSnapshots(app, employeeId, validFrom).catch((err) =>
          app.log.error(
            { err, employeeId },
            "Failed to recalculate snapshots after schedule change",
          ),
        );
      }

      return schedule;
    },
  });

  // GET /api/v1/settings/vacation/:employeeId?year=  — Urlaubsanspruch eines Mitarbeiters
  app.get("/vacation/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const { year: yearStr } = req.query as { year?: string };
      const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Urlaub-LeaveType finden
      const vacationType = await app.prisma.leaveType.findFirst({
        where: { tenantId: employee.tenantId, name: { contains: "Urlaub", mode: "insensitive" } },
      });
      if (!vacationType) return reply.code(404).send({ error: "Urlaubstyp nicht konfiguriert" });

      const entitlement = await app.prisma.leaveEntitlement.findUnique({
        where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationType.id, year } },
      });

      return {
        year,
        leaveTypeId: vacationType.id,
        totalDays: entitlement ? Number(entitlement.totalDays) : null,
        usedDays: entitlement ? Number(entitlement.usedDays) : 0,
        carriedOverDays: entitlement ? Number(entitlement.carriedOverDays) : 0,
        carryOverDeadline: entitlement?.carryOverDeadline ?? null,
      };
    },
  });

  // PUT /api/v1/settings/vacation/:employeeId  — Urlaubsanspruch setzen
  app.put("/vacation/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const body = vacationEntitlementSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      const vacationType = await app.prisma.leaveType.findFirst({
        where: { tenantId: employee.tenantId, name: { contains: "Urlaub", mode: "insensitive" } },
      });
      if (!vacationType) return reply.code(404).send({ error: "Urlaubstyp nicht konfiguriert" });

      const data = {
        totalDays: body.totalDays,
        carriedOverDays: body.carriedOverDays ?? 0,
        carryOverDeadline: body.carryOverDeadline ? new Date(body.carryOverDeadline) : null,
      };

      const entitlement = await app.prisma.leaveEntitlement.upsert({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId,
            leaveTypeId: vacationType.id,
            year: body.year,
          },
        },
        update: data,
        create: { employeeId, leaveTypeId: vacationType.id, year: body.year, ...data },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveEntitlement",
        entityId: entitlement.id,
        newValue: body,
      });

      return {
        year: body.year,
        totalDays: Number(entitlement.totalDays),
        usedDays: Number(entitlement.usedDays),
        carriedOverDays: Number(entitlement.carriedOverDays),
        carryOverDeadline: entitlement.carryOverDeadline,
      };
    },
  });

  // GET /api/v1/settings/smtp
  app.get("/smtp", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      return {
        smtpHost: cfg?.smtpHost ?? null,
        smtpPort: cfg?.smtpPort ?? null,
        smtpUser: cfg?.smtpUser ?? null,
        smtpPasswordSet: !!cfg?.smtpPassword,
        smtpFromEmail: cfg?.smtpFromEmail ?? null,
        smtpFromName: cfg?.smtpFromName ?? null,
        smtpSecure: cfg?.smtpSecure ?? false,
      };
    },
  });

  // PUT /api/v1/settings/smtp
  app.put("/smtp", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const smtpSchema = z.object({
        smtpHost: z.string().min(1),
        smtpPort: z.number().int().min(1).max(65535),
        smtpUser: z.string().min(1),
        smtpPassword: z.string().optional(),
        smtpFromEmail: z.string().email(),
        smtpFromName: z.string().min(1),
        smtpSecure: z.boolean(),
      });
      const body = smtpSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      const updateData: Record<string, unknown> = {
        smtpHost: body.smtpHost,
        smtpPort: body.smtpPort,
        smtpUser: body.smtpUser,
        smtpFromEmail: body.smtpFromEmail,
        smtpFromName: body.smtpFromName,
        smtpSecure: body.smtpSecure,
      };
      if (body.smtpPassword) updateData.smtpPassword = encrypt(body.smtpPassword);

      const oldConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      await app.prisma.tenantConfig.upsert({
        where: { tenantId },
        update: updateData,
        create: { tenantId, ...updateData },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "TenantConfig",
        entityId: tenantId,
        oldValue: oldConfig
          ? {
              smtpHost: oldConfig.smtpHost,
              smtpPort: oldConfig.smtpPort,
              smtpUser: oldConfig.smtpUser,
              smtpFromEmail: oldConfig.smtpFromEmail,
            }
          : null,
        newValue: {
          smtpHost: body.smtpHost,
          smtpPort: body.smtpPort,
          smtpUser: body.smtpUser,
          smtpFromEmail: body.smtpFromEmail,
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true };
    },
  });

  // POST /api/v1/settings/smtp/test
  app.post("/smtp/test", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);
      try {
        await app.mailer.sendTestMail(email, req.user.tenantId);
        return { success: true, message: "Testmail erfolgreich gesendet" };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: `SMTP-Fehler: ${msg}` });
      }
    },
  });

  // GET /api/v1/settings/security
  app.get("/security", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      return {
        twoFaEnabled: cfg?.twoFaEnabled ?? false,
        passwordMinLength: cfg?.passwordMinLength ?? 12,
        passwordRequireUpper: cfg?.passwordRequireUpper ?? true,
        passwordRequireLower: cfg?.passwordRequireLower ?? true,
        passwordRequireDigit: cfg?.passwordRequireDigit ?? true,
        passwordRequireSpecial: cfg?.passwordRequireSpecial ?? true,
        maxNegativeBalanceMinutes: cfg?.maxNegativeBalanceMinutes ?? null,
        emailNotificationsEnabled: cfg?.emailNotificationsEnabled ?? false,
        emailOnLeaveRequest: cfg?.emailOnLeaveRequest ?? true,
        emailOnLeaveDecision: cfg?.emailOnLeaveDecision ?? true,
        emailOnOvertimeWarning: cfg?.emailOnOvertimeWarning ?? false,
        emailOnMissingEntries: cfg?.emailOnMissingEntries ?? false,
        emailOnClockOutReminder: cfg?.emailOnClockOutReminder ?? false,
        emailOnMonthClose: cfg?.emailOnMonthClose ?? true,
        sessionTimeoutMinutes: cfg?.sessionTimeoutMinutes ?? 60,
        refreshTokenDays: cfg?.refreshTokenDays ?? 7,
        rememberMeEnabled: cfg?.rememberMeEnabled ?? true,
        rememberMeDays: cfg?.rememberMeDays ?? 30,
        maxSessionsPerUser: cfg?.maxSessionsPerUser ?? 0,
        loginMaxAttempts: cfg?.loginMaxAttempts ?? 5,
        loginLockoutMinutes: cfg?.loginLockoutMinutes ?? 15,
      };
    },
  });

  // PUT /api/v1/settings/security
  app.put("/security", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const body = z
        .object({
          twoFaEnabled: z.boolean().optional(),
          passwordMinLength: z.number().int().min(8).max(128).optional(),
          passwordRequireUpper: z.boolean().optional(),
          passwordRequireLower: z.boolean().optional(),
          passwordRequireDigit: z.boolean().optional(),
          passwordRequireSpecial: z.boolean().optional(),
          maxNegativeBalanceMinutes: z.number().int().min(0).nullable().optional(),
          emailNotificationsEnabled: z.boolean().optional(),
          emailOnLeaveRequest: z.boolean().optional(),
          emailOnLeaveDecision: z.boolean().optional(),
          emailOnOvertimeWarning: z.boolean().optional(),
          emailOnMissingEntries: z.boolean().optional(),
          emailOnClockOutReminder: z.boolean().optional(),
          emailOnMonthClose: z.boolean().optional(),
          sessionTimeoutMinutes: z.number().int().min(0).max(480).optional(),
          refreshTokenDays: z.number().int().min(1).max(90).optional(),
          rememberMeEnabled: z.boolean().optional(),
          rememberMeDays: z.number().int().min(1).max(365).optional(),
          maxSessionsPerUser: z.number().int().min(0).max(20).optional(),
          loginMaxAttempts: z.number().int().min(1).max(20).optional(),
          loginLockoutMinutes: z.number().int().min(1).max(1440).optional(),
        })
        .parse(req.body);
      const tenantId = req.user.tenantId;
      const oldConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      const config = await app.prisma.tenantConfig.upsert({
        where: { tenantId },
        update: body,
        create: { tenantId, ...body },
      });
      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "TenantConfig",
        entityId: tenantId,
        oldValue: {
          twoFaEnabled: oldConfig?.twoFaEnabled ?? false,
          passwordMinLength: oldConfig?.passwordMinLength ?? 12,
          maxNegativeBalanceMinutes: oldConfig?.maxNegativeBalanceMinutes ?? null,
        },
        newValue: body,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return {
        twoFaEnabled: config.twoFaEnabled,
        passwordMinLength: config.passwordMinLength,
        passwordRequireUpper: config.passwordRequireUpper,
        passwordRequireLower: config.passwordRequireLower,
        passwordRequireDigit: config.passwordRequireDigit,
        passwordRequireSpecial: config.passwordRequireSpecial,
        maxNegativeBalanceMinutes: config.maxNegativeBalanceMinutes,
        emailNotificationsEnabled: config.emailNotificationsEnabled,
        emailOnLeaveRequest: config.emailOnLeaveRequest,
        emailOnLeaveDecision: config.emailOnLeaveDecision,
        emailOnOvertimeWarning: config.emailOnOvertimeWarning,
        emailOnMissingEntries: config.emailOnMissingEntries,
        emailOnClockOutReminder: config.emailOnClockOutReminder,
        emailOnMonthClose: config.emailOnMonthClose,
        sessionTimeoutMinutes: config.sessionTimeoutMinutes,
        refreshTokenDays: config.refreshTokenDays,
        rememberMeEnabled: config.rememberMeEnabled,
        rememberMeDays: config.rememberMeDays,
        maxSessionsPerUser: config.maxSessionsPerUser,
        loginMaxAttempts: config.loginMaxAttempts,
        loginLockoutMinutes: config.loginLockoutMinutes,
      };
    },
  });

  // GET /api/v1/settings/work/:employeeId/history  — alle Schedule-Versionen eines Mitarbeiters
  app.get("/work/:employeeId/history", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, _reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const schedules = await app.prisma.workSchedule.findMany({
        where: { employeeId },
        orderBy: { validFrom: "desc" },
      });
      return schedules;
    },
  });

  // GET /api/v1/settings/employees  — alle Mitarbeiter mit ihren Arbeitszeitmodellen
  app.get("/employees", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;

      const employees = await app.prisma.employee.findMany({
        where: { tenantId },
        include: {
          user: { select: { email: true } },
          workSchedules: { orderBy: { validFrom: "desc" } },
        },
        orderBy: { employeeNumber: "asc" },
      });

      return employees.map((e) => ({
        id: e.id,
        employeeNumber: e.employeeNumber,
        firstName: e.firstName,
        lastName: e.lastName,
        email: e.user.email,
        workSchedule: e.workSchedules[0] ?? null,
      }));
    },
  });
  // GET /api/v1/settings/leave-types — all leave types with config
  app.get("/leave-types", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const types = await app.prisma.leaveType.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
      });
      return types;
    },
  });

  // PUT /api/v1/settings/leave-types/:id — update leave type config
  app.put("/leave-types/:id", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          allowHalfDay: z.boolean().optional(),
          maxDaysPerYear: z.number().int().min(0).nullable().optional(),
          leadTimeDays: z.number().int().min(0).nullable().optional(),
          color: z.string().optional(),
        })
        .parse(req.body);

      const existing = await app.prisma.leaveType.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Abwesenheitstyp nicht gefunden" });

      const updated = await app.prisma.leaveType.update({
        where: { id },
        data: body,
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "LeaveType",
        entityId: id,
        oldValue: { allowHalfDay: existing.allowHalfDay, maxDaysPerYear: existing.maxDaysPerYear },
        newValue: body,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return updated;
    },
  });
}
