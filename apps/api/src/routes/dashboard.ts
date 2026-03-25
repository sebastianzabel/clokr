import { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../middleware/auth";
import { getEffectiveSchedule } from "./time-entries";
import {
  getTenantTimezone,
  todayInTz,
  dateStrInTz,
  weekRangeUtc,
  calcExpectedMinutesTz,
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
        where: { employeeId, date: today, type: "WORK" },
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
          employee: { tenantId },
          startDate: { lte: weekEnd },
          endDate: { gte: weekStart },
        },
        select: { employeeId: true, startDate: true, endDate: true, type: true },
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

          let status: "present" | "absent" | "clocked_in" | "none" = "none";
          let reason: string | null = null;

          if (isClockedIn) {
            status = "clocked_in";
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
          } else if (isPresent) {
            status = "present";
          }

          return { date: dayStr, status, workedHours: round(workedMinutes / 60), reason };
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
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
