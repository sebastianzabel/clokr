import { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../middleware/auth";
import { getEffectiveSchedule } from "./time-entries";
import {
  getTenantTimezone,
  todayInTz,
  dateStrInTz,
  weekRangeUtc,
  monthRangeUtc,
  calcExpectedMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
  iterateDaysInTz,
} from "../utils/timezone";
import { resolvePresenceState } from "../utils/presence";
import type { PresenceEntry, PresenceLeave, PresenceAbsence } from "../utils/presence";
import { getHolidays, STATE_MAP } from "../utils/holidays";

export async function dashboardRoutes(app: FastifyInstance) {
  // GET /api/v1/dashboard — persönliche Stats
  app.get("/", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const employeeId = req.user.employeeId;
      if (!employeeId) {
        // API-only users (no employee record) receive empty stats rather than a Prisma crash
        return reply.code(200).send({
          today: { workedHours: 0, entries: 0 },
          week: { workedHours: 0, targetHours: 0 },
          overtime: { balanceHours: 0 },
          vacation: { remaining: 0, total: 0, used: 0 },
        });
      }
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const now = new Date();
      const today = todayInTz(tz);

      const { start: weekStart, end: weekEnd } = weekRangeUtc(now, tz);

      // ── Heute: gearbeitete Stunden ────────────────────────────────────
      const todayEntries = await app.prisma.timeEntry.findMany({
        where: { employeeId, deletedAt: null, date: today, type: "WORK" },
      });

      let todayMinutes = 0;
      for (const e of todayEntries) {
        if (e.endTime) {
          todayMinutes +=
            (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
        }
      }

      // ── Aktueller Arbeitsplan ─────────────────────────────────────────
      const schedule = await getEffectiveSchedule(app, employeeId);
      const isMonthlyHoursSchedule = String(schedule.type ?? "") === "MONTHLY_HOURS";

      // Fetch tenant info (federal state for holidays; holiday deduction config for MONTHLY_HOURS)
      const [personalTenant, tenantConfig] = await Promise.all([
        app.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { federalState: true },
        }),
        isMonthlyHoursSchedule
          ? app.prisma.tenantConfig.findUnique({
              where: { tenantId },
              select: { monthlyHoursHolidayDeduction: true },
            })
          : Promise.resolve(null),
      ]);
      const personalStateCode = personalTenant?.federalState
        ? (STATE_MAP[personalTenant.federalState] ?? null)
        : null;

      // ── Diese Woche / Dieser Monat: gearbeitete Stunden ──────────────

      // For MONTHLY_HOURS: fetch hours worked this month (monthStart..today).
      // For FIXED_WEEKLY: fetch hours worked this week (weekStart..weekEnd).
      let workedQueryStart: Date;
      let workedQueryEnd: Date;
      let monthStart: Date | null = null;
      let monthEnd: Date | null = null;

      if (isMonthlyHoursSchedule) {
        const todayZoned = today;
        const y = parseInt(dateStrInTz(todayZoned, tz).slice(0, 4));
        const m = parseInt(dateStrInTz(todayZoned, tz).slice(5, 7));
        const range = monthRangeUtc(y, m, tz);
        monthStart = range.start;
        monthEnd = range.end;
        workedQueryStart = monthStart;
        workedQueryEnd = today; // Ist = hours worked so far this month
      } else {
        workedQueryStart = weekStart;
        workedQueryEnd = weekEnd;
      }

      const periodEntries = await app.prisma.timeEntry.findMany({
        where: {
          employeeId,
          deletedAt: null,
          date: { gte: workedQueryStart, lte: workedQueryEnd },
          type: "WORK",
          endTime: { not: null },
        },
      });

      let periodWorkedMinutes = 0;
      for (const e of periodEntries) {
        if (e.endTime) {
          periodWorkedMinutes +=
            (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
        }
      }

      // Keep weekMinutes for backwards-compat (used as week.workedHours for FIXED_WEEKLY)
      const weekMinutes = isMonthlyHoursSchedule ? 0 : periodWorkedMinutes;

      // ── Soll-Stunden ──────────────────────────────────────────────────

      let weekSollMinutes = 0;
      let monthSollMinutes = 0;

      if (isMonthlyHoursSchedule) {
        // MONTHLY_HOURS: show full monthly budget as Soll, optionally reduced by holidays.
        const mh = Number(schedule.monthlyHours ?? 0);
        if (mh > 0 && monthStart && monthEnd) {
          const holidayDeductionEnabled = tenantConfig?.monthlyHoursHolidayDeduction === true;

          if (holidayDeductionEnabled && personalStateCode !== undefined) {
            // Replicate reports.ts calcShouldMinutes holiday deduction logic:
            // dailySoll = budget / workdays_in_month; deduct dailySoll for each holiday on a workday.
            const DOW_KEYS_MH = [
              "sundayHours",
              "mondayHours",
              "tuesdayHours",
              "wednesdayHours",
              "thursdayHours",
              "fridayHours",
              "saturdayHours",
            ] as const;
            let monthWorkdays = 0;
            iterateDaysInTz(monthStart, monthEnd, tz, (dow) => {
              if (Number((schedule as Record<string, unknown>)[DOW_KEYS_MH[dow]] ?? 0) > 0)
                monthWorkdays++;
            });

            if (monthWorkdays > 0) {
              const dailySollMin = (mh * 60) / monthWorkdays;
              const monthYear = monthStart.getUTCFullYear();
              const monthEndYear = monthEnd.getUTCFullYear();
              const monthHolidays = getHolidays(monthYear, personalStateCode);
              if (monthEndYear !== monthYear)
                monthHolidays.push(...getHolidays(monthEndYear, personalStateCode));
              let holidayDeductionMin = 0;
              for (const h of monthHolidays) {
                const hDate = new Date(h.date + "T12:00:00Z");
                if (hDate >= monthStart && hDate <= monthEnd) {
                  const dow = getDayOfWeekInTz(hDate, tz);
                  if (Number((schedule as Record<string, unknown>)[DOW_KEYS_MH[dow]] ?? 0) > 0) {
                    holidayDeductionMin += dailySollMin;
                  }
                }
              }
              monthSollMinutes = Math.max(0, Math.round(mh * 60 - holidayDeductionMin));
            } else {
              // No per-day config (flexible Minijobber): full budget, no deduction
              monthSollMinutes = mh * 60;
            }
          } else {
            monthSollMinutes = mh * 60;
          }
        }
      } else {
        // FIXED_WEEKLY: sum scheduled hours from week start up to today (inclusive).
        // clampedEnd = today limits to hours that "should have been worked by now".
        const personalStartYear = new Date(weekStart).getFullYear();
        const personalEndYear = new Date(weekEnd).getFullYear();
        const personalHolidays = getHolidays(personalStartYear, personalStateCode);
        if (personalEndYear !== personalStartYear)
          personalHolidays.push(...getHolidays(personalEndYear, personalStateCode));

        const clampedEnd = new Date(Math.min(today.getTime(), weekEnd.getTime()));
        weekSollMinutes = calcExpectedMinutesTz(schedule, weekStart, clampedEnd, tz);

        // Subtract holidays that fall within [weekStart, clampedEnd]
        for (const h of personalHolidays) {
          const hDate = new Date(h.date + "T12:00:00Z");
          if (hDate >= weekStart && hDate <= clampedEnd) {
            const dow = getDayOfWeekInTz(hDate, tz);
            weekSollMinutes -=
              getDayHoursFromSchedule(schedule as Record<string, unknown>, dow) * 60;
          }
        }
        if (weekSollMinutes < 0) weekSollMinutes = 0;
      }

      // ── Überstunden ───────────────────────────────────────────────────
      const overtimeAccount = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId },
      });
      const overtimeBalance = Number(overtimeAccount?.balanceHours ?? 0);

      // ── Resturlaub ────────────────────────────────────────────────────
      const yearNow = parseInt(dateStrInTz(now, tz).slice(0, 4));
      const entitlements = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId, year: yearNow },
      });
      const totalVacation = entitlements.reduce(
        (sum, e) => sum + Number(e.totalDays) + Number(e.carriedOverDays),
        0,
      );
      const usedVacation = entitlements.reduce((sum, e) => sum + Number(e.usedDays), 0);

      return {
        today: { workedHours: round(todayMinutes / 60), entries: todayEntries.length },
        week: { workedHours: round(weekMinutes / 60), targetHours: round(weekSollMinutes / 60) },
        // For MONTHLY_HOURS employees the dashboard widget shows a monthly view instead of weekly.
        // periodType tells the frontend which widget to render.
        periodType: isMonthlyHoursSchedule ? "month" : "week",
        month: isMonthlyHoursSchedule
          ? {
              workedHours: round(periodWorkedMinutes / 60),
              targetHours: round(monthSollMinutes / 60),
            }
          : undefined,
        overtime: { balanceHours: round(overtimeBalance) },
        vacation: {
          remaining: totalVacation - usedVacation,
          total: totalVacation,
          used: usedVacation,
        },
      };
    },
  });

  // GET /api/v1/dashboard/team-week — Wochenübersicht für Admins/Manager
  app.get("/team-week", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const query = req.query as { date?: string };
      const refDate = query.date ? new Date(query.date) : new Date();

      const { start: weekStart, end: weekEnd, days: weekDays } = weekRangeUtc(refDate, tz);

      // Holiday detection for the week
      const tenant = await app.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { federalState: true },
      });
      const stateCode = tenant?.federalState ? (STATE_MAP[tenant.federalState] ?? null) : null;
      // Week can span two years (e.g. Dec 30 – Jan 5), fetch both if needed
      const startYear = new Date(weekStart).getFullYear();
      const endYear = new Date(weekEnd).getFullYear();
      const weekHolidays = getHolidays(startYear, stateCode);
      if (endYear !== startYear) weekHolidays.push(...getHolidays(endYear, stateCode));
      const holidayMap = new Map(weekHolidays.map((h) => [h.date, h.name]));

      // Alle aktiven, nicht-anonymisierten Mitarbeiter
      const employees = await app.prisma.employee.findMany({
        where: { tenantId, exitDate: null, user: { isActive: true } },
        select: { id: true, firstName: true, lastName: true, employeeNumber: true },
        orderBy: { lastName: "asc" },
      });

      // Zeiteinträge der Woche
      const timeEntries = await app.prisma.timeEntry.findMany({
        where: {
          employee: { tenantId },
          deletedAt: null,
          date: { gte: weekStart, lte: weekEnd },
          type: "WORK",
        },
        select: {
          employeeId: true,
          date: true,
          startTime: true,
          endTime: true,
          breakMinutes: true,
          isInvalid: true,
        },
      });

      // Genehmigte Abwesenheiten (inkl. Urlaubsstornierungen)
      const leaveRequests = await app.prisma.leaveRequest.findMany({
        where: {
          employee: { tenantId },
          status: { in: ["APPROVED", "CANCELLATION_REQUESTED"] },
          startDate: { lte: weekEnd },
          endDate: { gte: weekStart },
        },
        select: {
          employeeId: true,
          startDate: true,
          endDate: true,
          status: true,
          leaveType: { select: { name: true } },
        },
      });

      // Krankheiten
      const absences = await app.prisma.absence.findMany({
        where: {
          deletedAt: null,
          employee: { tenantId },
          startDate: { lte: weekEnd },
          endDate: { gte: weekStart },
        },
        select: { employeeId: true, startDate: true, endDate: true, type: true },
      });

      // Schichten der Woche
      const shifts = await app.prisma.shift.findMany({
        where: {
          employee: { tenantId },
          date: { gte: weekStart, lte: weekEnd },
        },
        include: { template: { select: { name: true, color: true } } },
      });

      // Aktuelle Schedules aller MA (bulk, latest per employee)
      const allSchedules = await app.prisma.workSchedule.findMany({
        where: {
          employeeId: { in: employees.map((e) => e.id) },
          validFrom: { lte: weekEnd },
        },
        orderBy: { validFrom: "desc" },
      });

      // Pro Mitarbeiter die Woche aufbereiten
      const team = employees.map((emp) => {
        const days = weekDays.map((dayStr) => {
          const dayEntries = timeEntries.filter(
            (e) => e.employeeId === emp.id && dateStrInTz(e.date, tz) === dayStr,
          );
          // workedMinutes: only valid (non-invalid) entries count
          let workedMinutes = 0;
          for (const e of dayEntries) {
            if (!e.isInvalid && e.endTime) {
              workedMinutes +=
                (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
            }
          }

          const leave = leaveRequests.find(
            (lr) =>
              lr.employeeId === emp.id &&
              dateStrInTz(lr.startDate, tz) <= dayStr &&
              dateStrInTz(lr.endDate, tz) >= dayStr,
          );

          const absence = absences.find(
            (a) =>
              a.employeeId === emp.id &&
              dateStrInTz(a.startDate, tz) <= dayStr &&
              dateStrInTz(a.endDate, tz) >= dayStr,
          );

          // Find shift for this employee + day
          const dayShifts = shifts.filter(
            (s) => s.employeeId === emp.id && dateStrInTz(s.date, tz) === dayStr,
          );
          const shift =
            dayShifts.length > 0
              ? {
                  startTime: dayShifts[0].startTime,
                  endTime: dayShifts[0].endTime,
                  label: dayShifts[0].label ?? dayShifts[0].template?.name ?? null,
                  color: dayShifts[0].template?.color ?? null,
                }
              : null;

          // Check if this is a workday from the schedule
          const empSchedule = allSchedules.find((s) => s.employeeId === emp.id);
          const dayDate = new Date(dayStr + "T12:00:00Z");
          const dow = getDayOfWeekInTz(dayDate, tz);
          const expectedHours = empSchedule
            ? getDayHoursFromSchedule(empSchedule as Record<string, unknown>, dow)
            : 0;
          const isWorkday = expectedHours > 0;

          const todayStr = dateStrInTz(new Date(), tz);
          const isFuture = dayStr > todayStr;

          // Build typed inputs for the presence resolver
          const presenceEntries: PresenceEntry[] = dayEntries.map((e) => ({
            endTime: e.endTime,
            isInvalid: e.isInvalid,
          }));

          const presenceLeave: PresenceLeave | null = leave
            ? {
                status: leave.status as "APPROVED" | "CANCELLATION_REQUESTED",
                leaveTypeName: leave.leaveType.name,
              }
            : null;

          const presenceAbsence: PresenceAbsence | null = absence ? { type: absence.type } : null;

          const { status, reason } = resolvePresenceState({
            entries: presenceEntries,
            leave: presenceLeave,
            absence: presenceAbsence,
            isWorkday,
            isFuture,
            hasShift: shift !== null,
            isHoliday: holidayMap.has(dayStr),
            holidayName: holidayMap.get(dayStr) ?? null,
          });

          return {
            date: dayStr,
            status,
            workedHours: round(workedMinutes / 60),
            reason,
            shift,
            isWorkday,
            expectedHours,
          };
        });

        return {
          id: emp.id,
          name: `${emp.firstName} ${emp.lastName}`,
          employeeNumber: emp.employeeNumber,
          days,
        };
      });

      return { weekStart: weekDays[0], weekEnd: weekDays[6], weekDays, team };
    },
  });
  // GET /api/v1/dashboard/today-attendance — Tages-Anwesenheitsübersicht (RPT-03)
  app.get("/today-attendance", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const today = todayInTz(tz);
      const todayStr = dateStrInTz(today, tz);

      // Fetch tenant federal state for holiday detection
      const tenant = await app.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { federalState: true },
      });
      const stateCode = tenant?.federalState ? (STATE_MAP[tenant.federalState] ?? null) : null;
      const holidays = getHolidays(today.getFullYear(), stateCode);
      const todayHoliday = holidays.find((h) => h.date === todayStr) ?? null;
      const isHoliday = todayHoliday !== null;
      const holidayName = todayHoliday?.name ?? null;

      // Bulk fetch 1 — active employees for this tenant
      const employees = await app.prisma.employee.findMany({
        where: { tenantId, exitDate: null, user: { isActive: true } },
        select: { id: true, firstName: true, lastName: true, employeeNumber: true },
        orderBy: { lastName: "asc" },
      });

      const employeeIds = employees.map((e) => e.id);

      // Bulk fetch 2 — WORK time entries for today (deletedAt: null, tenant-scoped via employee)
      const timeEntries = await app.prisma.timeEntry.findMany({
        where: {
          employee: { tenantId },
          deletedAt: null,
          date: today,
          type: "WORK",
        },
        select: { employeeId: true, endTime: true, isInvalid: true },
      });

      // Bulk fetch 3 — leave requests covering today (APPROVED + CANCELLATION_REQUESTED)
      const leaveRequests = await app.prisma.leaveRequest.findMany({
        where: {
          employee: { tenantId },
          status: { in: ["APPROVED", "CANCELLATION_REQUESTED"] },
          startDate: { lte: today },
          endDate: { gte: today },
          deletedAt: null,
        },
        select: {
          employeeId: true,
          status: true,
          leaveType: { select: { name: true } },
        },
      });

      // Bulk fetch 4 — absences covering today (deletedAt: null, tenant-scoped)
      const absences = await app.prisma.absence.findMany({
        where: {
          employee: { tenantId },
          startDate: { lte: today },
          endDate: { gte: today },
          deletedAt: null,
        },
        select: { employeeId: true, type: true },
      });

      // Bulk fetch 5 — latest work schedule per employee (validFrom <= today, ordered desc)
      const allSchedules = await app.prisma.workSchedule.findMany({
        where: {
          employeeId: { in: employeeIds },
          validFrom: { lte: today },
        },
        orderBy: { validFrom: "desc" },
      });

      // Build lookup maps (employeeId → first match)
      const entriesByEmp = new Map<string, typeof timeEntries>();
      for (const e of timeEntries) {
        const list = entriesByEmp.get(e.employeeId) ?? [];
        list.push(e);
        entriesByEmp.set(e.employeeId, list);
      }

      const leaveByEmp = new Map<string, (typeof leaveRequests)[0]>();
      for (const lr of leaveRequests) {
        if (!leaveByEmp.has(lr.employeeId)) {
          leaveByEmp.set(lr.employeeId, lr);
        }
      }

      const absenceByEmp = new Map<string, (typeof absences)[0]>();
      for (const a of absences) {
        if (!absenceByEmp.has(a.employeeId)) {
          absenceByEmp.set(a.employeeId, a);
        }
      }

      // DOW for today (needed once — all employees share the same day)
      const dow = getDayOfWeekInTz(today, tz);

      // Summary counters
      let present = 0;
      let absent = 0;
      let clockedIn = 0;
      let missing = 0;
      let holiday = 0;

      const employeeRows = employees.map((emp) => {
        const empSchedule = allSchedules.find((s) => s.employeeId === emp.id) ?? null;
        const expectedHours = empSchedule
          ? getDayHoursFromSchedule(empSchedule as Record<string, unknown>, dow)
          : 0;
        const isWorkday = expectedHours > 0;

        const rawEntries = entriesByEmp.get(emp.id) ?? [];
        const presenceEntries: PresenceEntry[] = rawEntries.map((e) => ({
          endTime: e.endTime,
          isInvalid: e.isInvalid,
        }));

        const rawLeave = leaveByEmp.get(emp.id) ?? null;
        const presenceLeave: PresenceLeave | null = rawLeave
          ? {
              status: rawLeave.status as "APPROVED" | "CANCELLATION_REQUESTED",
              leaveTypeName: rawLeave.leaveType.name,
            }
          : null;

        const rawAbsence = absenceByEmp.get(emp.id) ?? null;
        const presenceAbsence: PresenceAbsence | null = rawAbsence
          ? { type: rawAbsence.type }
          : null;

        const { status, reason } = resolvePresenceState({
          entries: presenceEntries,
          leave: presenceLeave,
          absence: presenceAbsence,
          isWorkday,
          isFuture: false, // today is never future
          hasShift: false,
          isHoliday,
          holidayName,
        });

        // Accumulate summary counters
        if (status === "present") present++;
        else if (status === "absent") absent++;
        else if (status === "clocked_in") clockedIn++;
        else if (status === "missing") missing++;
        else if (status === "holiday") holiday++;

        return {
          id: emp.id,
          name: `${emp.firstName} ${emp.lastName}`,
          employeeNumber: emp.employeeNumber,
          status,
          reason,
        };
      });

      return {
        date: todayStr,
        employees: employeeRows,
        summary: { present, absent, clockedIn, missing, holiday },
      };
    },
  });

  // GET /api/v1/dashboard/overtime-overview — Überstunden-Übersicht (RPT-01 + SALDO-03)
  app.get("/overtime-overview", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;

      // Query 1: all OvertimeAccount rows joined with employee (tenant-scoped, active only)
      const accounts = await app.prisma.overtimeAccount.findMany({
        where: { employee: { tenantId, exitDate: null, user: { isActive: true } } },
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeNumber: true },
          },
        },
        orderBy: { employee: { lastName: "asc" } },
      });

      const employeeIds = accounts.map((a) => a.employeeId);

      // Query 2: last 6 months of MONTHLY SaldoSnapshots for these employees
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
      sixMonthsAgo.setUTCDate(1);
      sixMonthsAgo.setUTCHours(0, 0, 0, 0);

      const snapshots = await app.prisma.saldoSnapshot.findMany({
        where: {
          employeeId: { in: employeeIds },
          periodType: "MONTHLY",
          periodStart: { gte: sixMonthsAgo },
        },
        orderBy: { periodStart: "asc" },
        select: {
          employeeId: true,
          periodStart: true,
          balanceMinutes: true,
          carryOver: true,
        },
      });

      // Group snapshots by employeeId
      const snapshotsByEmp = new Map<string, typeof snapshots>();
      for (const snap of snapshots) {
        const list = snapshotsByEmp.get(snap.employeeId) ?? [];
        list.push(snap);
        snapshotsByEmp.set(snap.employeeId, list);
      }

      return {
        employees: accounts.map((a) => {
          const balanceHours = Number(a.balanceHours);
          return {
            id: a.employeeId,
            name: `${a.employee.firstName} ${a.employee.lastName}`,
            employeeNumber: a.employee.employeeNumber,
            balanceHours,
            status: classifyOvertimeBalance(balanceHours),
            snapshots: (snapshotsByEmp.get(a.employeeId) ?? []).map((s) => ({
              periodStart: s.periodStart.toISOString().slice(0, 10),
              balanceMinutes: s.balanceMinutes,
              carryOver: s.carryOver,
            })),
          };
        }),
      };
    },
  });

  // GET /api/v1/dashboard/my-week — persönliche Wochenübersicht (für alle MA)
  app.get("/my-week", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const employeeId = req.user.employeeId!;
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const { date } = req.query as { date?: string };
      const refDate = date ? new Date(date) : new Date();
      const { start, end, days: weekDays } = weekRangeUtc(refDate, tz);

      const schedule = await getEffectiveSchedule(app, employeeId);

      // Holiday detection for the week
      const myWeekTenant = await app.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { federalState: true },
      });
      const myWeekStateCode = myWeekTenant?.federalState
        ? (STATE_MAP[myWeekTenant.federalState] ?? null)
        : null;
      const startYear = new Date(start).getFullYear();
      const endYear = new Date(end).getFullYear();
      const myWeekHolidays = getHolidays(startYear, myWeekStateCode);
      if (endYear !== startYear) myWeekHolidays.push(...getHolidays(endYear, myWeekStateCode));
      const myWeekHolidayMap = new Map(myWeekHolidays.map((h) => [h.date, h.name]));

      const entries = await app.prisma.timeEntry.findMany({
        where: { employeeId, deletedAt: null, type: "WORK", date: { gte: start, lte: end } },
      });

      const days = weekDays.map((dateStr: string) => {
        const dayEntries = entries.filter((e) => dateStrInTz(e.date, tz) === dateStr);
        const workedMin = dayEntries.reduce((sum: number, e) => {
          if (!e.endTime) return sum;
          return (
            sum +
            (e.endTime.getTime() - e.startTime.getTime()) / 60000 -
            Number(e.breakMinutes || 0)
          );
        }, 0);

        const dow = getDayOfWeekInTz(new Date(dateStr + "T12:00:00Z"), tz);
        const holidayName = myWeekHolidayMap.get(dateStr) ?? null;
        // Feiertage reduzieren das Soll auf 0
        const expectedMin =
          schedule && !holidayName ? getDayHoursFromSchedule(schedule, dow) * 60 : 0;
        const isWorkday = expectedMin > 0;
        const hasEntry = dayEntries.length > 0;
        const isClockedIn = dayEntries.some((e) => !e.endTime);
        const isPast = new Date(dateStr) < todayInTz(tz);

        let status = "none";
        if (isClockedIn) status = "clocked_in";
        else if (hasEntry) status = workedMin >= expectedMin ? "complete" : "partial";
        else if (holidayName) status = "holiday";
        else if (isPast && isWorkday) status = "missing";
        else if (isWorkday) status = "scheduled";

        return {
          date: dateStr,
          workedHours: round(workedMin / 60),
          expectedHours: round(expectedMin / 60),
          status,
          isWorkday,
          holidayName,
        };
      });

      return { weekDays, days };
    },
  });

  // GET /api/v1/dashboard/open-items — offene Vorgänge für den MA
  app.get("/open-items", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const employeeId = req.user.employeeId!;
      const tenantId = req.user.tenantId;
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const today = todayInTz(tz);
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // 1. Missing time entries (workdays without entries in last 7 days)
      const schedule = await getEffectiveSchedule(app, employeeId);
      const recentEntries = await app.prisma.timeEntry.findMany({
        where: {
          employeeId,
          deletedAt: null,
          type: "WORK",
          date: { gte: sevenDaysAgo, lt: today },
        },
        select: { date: true },
      });
      const entryDates = new Set(recentEntries.map((e) => dateStrInTz(e.date, tz)));

      // Fetch holidays for the 7-day window (window can span two years near Jan 1)
      const openItemsTenant = await app.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { federalState: true },
      });
      const openItemsStateCode = openItemsTenant?.federalState
        ? (STATE_MAP[openItemsTenant.federalState] ?? null)
        : null;
      const startYear = sevenDaysAgo.getFullYear();
      const endYear = today.getFullYear();
      const openItemsHolidays = getHolidays(startYear, openItemsStateCode);
      if (endYear !== startYear)
        openItemsHolidays.push(...getHolidays(endYear, openItemsStateCode));
      const openItemsHolidaySet = new Set(openItemsHolidays.map((h) => h.date));

      const missingDays: string[] = [];
      const cursor = new Date(sevenDaysAgo);
      while (cursor < today) {
        const dateStr = dateStrInTz(cursor, tz);
        if (openItemsHolidaySet.has(dateStr)) {
          cursor.setDate(cursor.getDate() + 1);
          continue;
        }
        const dow = getDayOfWeekInTz(cursor, tz);
        const expectedH = schedule ? getDayHoursFromSchedule(schedule, dow) : 0;
        if (expectedH > 0 && !entryDates.has(dateStr)) {
          missingDays.push(dateStr);
        }
        cursor.setDate(cursor.getDate() + 1);
      }

      // 2. Pending leave requests
      const pendingRequests = await app.prisma.leaveRequest.findMany({
        where: { employeeId, deletedAt: null, status: "PENDING" },
        select: { id: true, startDate: true, endDate: true },
      });

      // 3. Invalidated time entries
      const invalidEntries = await app.prisma.timeEntry.findMany({
        where: { employeeId, deletedAt: null, isInvalid: true },
        select: { id: true, date: true, invalidReason: true },
      });

      return {
        missingDays,
        pendingRequests: pendingRequests.length,
        invalidEntries: invalidEntries.length,
        total: missingDays.length + pendingRequests.length + invalidEntries.length,
      };
    },
  });

  // GET /api/v1/dashboard/overtime-trend — Team overtime saldo trend (last 6 months)
  app.get("/overtime-trend", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const tenantId = req.user.tenantId;

      // 6-month window (inclusive of current month)
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 5);
      sixMonthsAgo.setUTCDate(1);
      sixMonthsAgo.setUTCHours(0, 0, 0, 0);

      // First fetch active employee IDs for this tenant.
      // Prisma groupBy does not support relation filters in `where`, so we resolve
      // tenant scoping via a separate employee query.
      const employees = await app.prisma.employee.findMany({
        where: { tenantId, user: { isActive: true } },
        select: { id: true },
      });
      const employeeIds = employees.map((e) => e.id);

      // Query 1: SUM(carryOver) grouped by periodStart, MONTHLY only, within 6-month window.
      const grouped =
        employeeIds.length === 0
          ? []
          : await app.prisma.saldoSnapshot.groupBy({
              by: ["periodStart"],
              where: {
                employeeId: { in: employeeIds },
                periodType: "MONTHLY",
                periodStart: { gte: sixMonthsAgo },
              },
              _sum: { carryOver: true },
              orderBy: { periodStart: "asc" },
            });

      const snapshots = grouped.map((g) => ({
        month: g.periodStart.toISOString().slice(0, 10), // "YYYY-MM-DD" (always day 01)
        teamCarryOverMinutes: g._sum.carryOver ?? 0,
      }));

      // Query 2: SUM(balanceHours * 60) across all active employees' OvertimeAccounts.
      const accounts =
        employeeIds.length === 0
          ? []
          : await app.prisma.overtimeAccount.findMany({
              where: { employeeId: { in: employeeIds } },
              select: { balanceHours: true },
            });
      const currentTeamBalanceMinutes = Math.round(
        accounts.reduce((sum, a) => sum + Number(a.balanceHours) * 60, 0),
      );

      return { snapshots, currentTeamBalanceMinutes };
    },
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Keep in sync with overtime.ts status logic
function classifyOvertimeBalance(balanceHours: number): "NORMAL" | "ELEVATED" | "CRITICAL" {
  const abs = Math.abs(balanceHours);
  if (abs <= 20) return "NORMAL";
  if (abs <= 40) return "ELEVATED";
  return "CRITICAL";
}
