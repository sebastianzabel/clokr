import { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../middleware/auth";
import { getEffectiveSchedule } from "./time-entries";
import {
  getTenantTimezone,
  todayInTz,
  dateStrInTz,
  weekRangeUtc,
  calcExpectedMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "../utils/timezone";

export async function dashboardRoutes(app: FastifyInstance) {
  // GET /api/v1/dashboard — persönliche Stats
  app.get("/", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const employeeId = req.user.employeeId!;
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

      // ── Diese Woche: gearbeitete Stunden ──────────────────────────────
      const weekEntries = await app.prisma.timeEntry.findMany({
        where: {
          employeeId,
          deletedAt: null,
          date: { gte: weekStart, lte: weekEnd },
          type: "WORK",
          endTime: { not: null },
        },
      });

      let weekMinutes = 0;
      for (const e of weekEntries) {
        if (e.endTime) {
          weekMinutes +=
            (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
        }
      }

      // ── Soll-Stunden diese Woche (bis heute) ─────────────────────────
      const schedule = await getEffectiveSchedule(app, employeeId);
      const clampedEnd = new Date(Math.min(today.getTime(), weekEnd.getTime()));
      const weekSollMinutes = calcExpectedMinutesTz(schedule, weekStart, clampedEnd, tz);

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

      // Alle aktiven Mitarbeiter
      const employees = await app.prisma.employee.findMany({
        where: { tenantId, exitDate: null },
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
        },
      });

      // Genehmigte Abwesenheiten
      const leaveRequests = await app.prisma.leaveRequest.findMany({
        where: {
          employee: { tenantId },
          status: "APPROVED",
          startDate: { lte: weekEnd },
          endDate: { gte: weekStart },
        },
        select: {
          employeeId: true,
          startDate: true,
          endDate: true,
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
          let workedMinutes = 0;
          let isPresent = false;
          let isClockedIn = false;

          for (const e of dayEntries) {
            if (e.endTime) {
              workedMinutes +=
                (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
              isPresent = true;
            } else {
              isClockedIn = true;
              isPresent = true;
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
          const expectedHours = empSchedule ? getDayHoursFromSchedule(empSchedule as any, dow) : 0;
          const isWorkday = expectedHours > 0;

          let status: "present" | "absent" | "clocked_in" | "missing" | "scheduled" | "none" =
            "none";
          let reason: string | null = null;

          const todayStr = dateStrInTz(new Date(), tz);
          const isFuture = dayStr > todayStr;

          if (isClockedIn) {
            status = "clocked_in";
          } else if (isPresent) {
            // Tatsächliche Anwesenheit hat Vorrang (auch bei genehmigtem Urlaub)
            status = "present";
          } else if (leave) {
            status = "absent";
            reason = leave.leaveType.name;
          } else if (absence) {
            status = "absent";
            reason =
              absence.type === "SICK"
                ? "Krankmeldung"
                : absence.type === "SICK_CHILD"
                  ? "Kinderkrank"
                  : absence.type === "MATERNITY"
                    ? "Mutterschutz"
                    : absence.type === "PARENTAL"
                      ? "Elternzeit"
                      : absence.type.toString();
          } else if (isFuture && (shift || isWorkday)) {
            status = "scheduled";
          } else if (!isFuture && (shift || isWorkday)) {
            status = "missing";
          }

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

      const entries = await app.prisma.timeEntry.findMany({
        where: { employeeId, deletedAt: null, type: "WORK", date: { gte: start, lte: end } },
      });

      const days = weekDays.map((dateStr: string) => {
        const dayEntries = entries.filter((e: any) => dateStrInTz(e.date, tz) === dateStr);
        const workedMin = dayEntries.reduce((sum: number, e: any) => {
          if (!e.endTime) return sum;
          return (
            sum +
            (e.endTime.getTime() - e.startTime.getTime()) / 60000 -
            Number(e.breakMinutes || 0)
          );
        }, 0);

        const dow = getDayOfWeekInTz(new Date(dateStr + "T12:00:00Z"), tz);
        const expectedMin = schedule ? getDayHoursFromSchedule(schedule, dow) * 60 : 0;
        const isWorkday = expectedMin > 0;
        const hasEntry = dayEntries.length > 0;
        const isClockedIn = dayEntries.some((e: any) => !e.endTime);
        const isPast = new Date(dateStr) < todayInTz(tz);

        let status = "none";
        if (isClockedIn) status = "clocked_in";
        else if (hasEntry) status = workedMin >= expectedMin ? "complete" : "partial";
        else if (isPast && isWorkday) status = "missing";
        else if (isWorkday) status = "scheduled";

        return {
          date: dateStr,
          workedHours: round(workedMin / 60),
          expectedHours: round(expectedMin / 60),
          status,
          isWorkday,
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
      const entryDates = new Set(recentEntries.map((e: any) => dateStrInTz(e.date, tz)));

      const missingDays: string[] = [];
      const cursor = new Date(sevenDaysAgo);
      while (cursor < today) {
        const dateStr = dateStrInTz(cursor, tz);
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
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
