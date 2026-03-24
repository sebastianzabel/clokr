import { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../middleware/auth";

export async function dashboardRoutes(app: FastifyInstance) {
  // GET /api/v1/dashboard — persönliche Stats
  app.get("/", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const employeeId = req.user.employeeId!;
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Montag dieser Woche berechnen
      const dayOfWeek = now.getDay(); // 0=So, 1=Mo
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() + mondayOffset);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);

      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      // ── Heute: gearbeitete Stunden ────────────────────────────────────
      const todayEntries = await app.prisma.timeEntry.findMany({
        where: { employeeId, date: today, type: "WORK" },
      });

      let todayMinutes = 0;
      for (const e of todayEntries) {
        if (e.endTime) {
          todayMinutes += (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
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
          weekMinutes += (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
        }
      }

      // ── Soll-Stunden diese Woche ──────────────────────────────────────
      const schedule = await getSchedule(app, employeeId);
      const weekSollMinutes = calcExpectedMinutes(schedule, weekStart, new Date(Math.min(today.getTime(), weekEnd.getTime())));

      // ── Überstunden ───────────────────────────────────────────────────
      const overtimeAccount = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
      const overtimeBalance = Number(overtimeAccount?.balanceHours ?? 0);

      // ── Resturlaub ────────────────────────────────────────────────────
      const entitlements = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId, year: now.getFullYear() },
      });
      const totalVacation = entitlements.reduce(
        (sum, e) => sum + Number(e.totalDays) + Number(e.carriedOverDays), 0
      );
      const usedVacation = entitlements.reduce(
        (sum, e) => sum + Number(e.usedDays), 0
      );
      const remainingVacation = totalVacation - usedVacation;

      return {
        today: {
          workedHours: round(todayMinutes / 60),
          entries: todayEntries.length,
        },
        week: {
          workedHours: round(weekMinutes / 60),
          targetHours: round(weekSollMinutes / 60),
        },
        overtime: {
          balanceHours: round(overtimeBalance),
        },
        vacation: {
          remaining: remainingVacation,
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
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Montag dieser Woche
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() + mondayOffset);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);

      // Alle aktiven Mitarbeiter des Tenants
      const employees = await app.prisma.employee.findMany({
        where: { tenantId, exitDate: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeNumber: true,
        },
        orderBy: { lastName: "asc" },
      });

      // Zeiteinträge der Woche (alle Mitarbeiter)
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

      // Abwesenheiten der Woche (genehmigt)
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

      // Absences (Krankheit direkt eingetragen)
      const absences = await app.prisma.absence.findMany({
        where: {
          employee: { tenantId },
          startDate: { lte: weekEnd },
          endDate: { gte: weekStart },
        },
        select: {
          employeeId: true,
          startDate: true,
          endDate: true,
          type: true,
        },
      });

      // Tage der Woche (Mo-So)
      const weekDays: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        weekDays.push(d.toISOString().slice(0, 10));
      }

      // Pro Mitarbeiter die Woche aufbereiten
      const teamWeek = employees.map((emp) => {
        const days = weekDays.map((dayStr) => {
          const dayDate = new Date(dayStr);

          // Gearbeitete Stunden an diesem Tag
          const dayEntries = timeEntries.filter(
            (e) => e.employeeId === emp.id && e.date.toISOString().slice(0, 10) === dayStr
          );
          let workedMinutes = 0;
          let isPresent = false;
          let isClockedIn = false;

          for (const e of dayEntries) {
            if (e.endTime) {
              workedMinutes += (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
              isPresent = true;
            } else {
              isClockedIn = true;
              isPresent = true;
            }
          }

          // Abwesenheit an diesem Tag?
          const leave = leaveRequests.find(
            (lr) =>
              lr.employeeId === emp.id &&
              lr.startDate.toISOString().slice(0, 10) <= dayStr &&
              lr.endDate.toISOString().slice(0, 10) >= dayStr
          );

          const absence = absences.find(
            (a) =>
              a.employeeId === emp.id &&
              a.startDate.toISOString().slice(0, 10) <= dayStr &&
              a.endDate.toISOString().slice(0, 10) >= dayStr
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
            reason = absence.type === "SICK" ? "Krankmeldung" :
                     absence.type === "SICK_CHILD" ? "Kinderkrank" :
                     absence.type === "MATERNITY" ? "Mutterschutz" :
                     absence.type === "PARENTAL" ? "Elternzeit" :
                     absence.type.toString();
          } else if (isPresent) {
            status = "present";
          }

          return {
            date: dayStr,
            status,
            workedHours: round(workedMinutes / 60),
            reason,
          };
        });

        return {
          id: emp.id,
          name: `${emp.firstName} ${emp.lastName}`,
          employeeNumber: emp.employeeNumber,
          days,
        };
      });

      return {
        weekStart: weekStart.toISOString().slice(0, 10),
        weekEnd: weekEnd.toISOString().slice(0, 10),
        weekDays,
        team: teamWeek,
      };
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function getSchedule(app: FastifyInstance, employeeId: string) {
  const schedule = await app.prisma.workSchedule.findUnique({ where: { employeeId } });
  if (schedule) return schedule;

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const cfg = employee
    ? await app.prisma.tenantConfig.findUnique({ where: { tenantId: employee.tenantId } })
    : null;

  return {
    mondayHours:    cfg?.defaultMondayHours    ?? 8,
    tuesdayHours:   cfg?.defaultTuesdayHours   ?? 8,
    wednesdayHours: cfg?.defaultWednesdayHours ?? 8,
    thursdayHours:  cfg?.defaultThursdayHours  ?? 8,
    fridayHours:    cfg?.defaultFridayHours    ?? 8,
    saturdayHours:  cfg?.defaultSaturdayHours  ?? 0,
    sundayHours:    cfg?.defaultSundayHours    ?? 0,
  };
}

function calcExpectedMinutes(
  schedule: Record<string, unknown>,
  from: Date,
  to: Date
): number {
  const keys = ["sundayHours", "mondayHours", "tuesdayHours", "wednesdayHours",
                "thursdayHours", "fridayHours", "saturdayHours"];
  let total = 0;
  const current = new Date(from);
  while (current <= to) {
    total += Number(schedule[keys[current.getDay()]] ?? 0) * 60;
    current.setDate(current.getDate() + 1);
  }
  return total;
}
