import { FastifyInstance } from "fastify";
import { requireRole } from "../middleware/auth";

export async function reportRoutes(app: FastifyInstance) {
  // GET /api/v1/reports/monthly?employeeId=&year=&month=
  app.get("/monthly", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const { employeeId, year, month } = req.query as {
        employeeId?: string;
        year: string;
        month: string;
      };

      const y = parseInt(year);
      const m = parseInt(month) - 1;
      const start = new Date(y, m, 1);
      const end   = new Date(y, m + 1, 0, 23, 59, 59, 999);

      // Alle Mitarbeiter des Tenants (oder nur einen)
      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          ...(employeeId ? { id: employeeId } : {}),
          exitDate: null,
        },
        include: {
          workSchedule: true,
          timeEntries: {
            where: { date: { gte: start, lte: end }, type: "WORK", endTime: { not: null } },
          },
          absences: {
            where: { startDate: { lte: end }, endDate: { gte: start } },
          },
          leaveRequests: {
            where: { status: "APPROVED", startDate: { lte: end }, endDate: { gte: start } },
            include: { leaveType: true },
          },
        },
        orderBy: { lastName: "asc" },
      });

      // Soll-Stunden: kalenderbasiert über Wochentag-Soll aus WorkSchedule
      function calcShouldMinutes(schedule: { mondayHours: unknown; tuesdayHours: unknown; wednesdayHours: unknown; thursdayHours: unknown; fridayHours: unknown; saturdayHours: unknown; sundayHours: unknown } | null): number {
        const dow = [
          Number(schedule?.sundayHours    ?? 0),  // 0
          Number(schedule?.mondayHours    ?? 8),  // 1
          Number(schedule?.tuesdayHours   ?? 8),  // 2
          Number(schedule?.wednesdayHours ?? 8),  // 3
          Number(schedule?.thursdayHours  ?? 8),  // 4
          Number(schedule?.fridayHours    ?? 8),  // 5
          Number(schedule?.saturdayHours  ?? 0),  // 6
        ];
        let totalMin = 0;
        const cur = new Date(start);
        while (cur <= end) {
          totalMin += dow[cur.getDay()] * 60;
          cur.setDate(cur.getDate() + 1);
        }
        return totalMin;
      }

      // Tagesweise Soll-Minuten für einen Zeitraum (Schnittmenge mit Monat)
      function absenceMinutes(
        schedule: { mondayHours: unknown; tuesdayHours: unknown; wednesdayHours: unknown; thursdayHours: unknown; fridayHours: unknown; saturdayHours: unknown; sundayHours: unknown } | null,
        absStart: Date,
        absEnd: Date,
      ): number {
        const dow = [
          Number(schedule?.sundayHours    ?? 0),
          Number(schedule?.mondayHours    ?? 8),
          Number(schedule?.tuesdayHours   ?? 8),
          Number(schedule?.wednesdayHours ?? 8),
          Number(schedule?.thursdayHours  ?? 8),
          Number(schedule?.fridayHours    ?? 8),
          Number(schedule?.saturdayHours  ?? 0),
        ];
        // Schnittmenge mit Monatsgrenzen
        const rangeStart = absStart < start ? start : absStart;
        const rangeEnd   = absEnd   > end   ? end   : absEnd;
        let min = 0;
        const cur = new Date(rangeStart);
        while (cur <= rangeEnd) {
          min += dow[cur.getDay()] * 60;
          cur.setDate(cur.getDate() + 1);
        }
        return min;
      }

      const rows = employees.map((emp) => {
        // Geleistete Minuten (Netto)
        const workedMin = emp.timeEntries.reduce((sum, e) => {
          const slotMin = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
          return sum + slotMin - Number(e.breakMinutes ?? 0);
        }, 0);

        // Soll-Minuten: Gesamtmonat minus genehmigte Abwesenheitstage
        const rawShouldMin = calcShouldMinutes(emp.workSchedule);
        const absenceMin = emp.leaveRequests.reduce((sum, lr) =>
          sum + absenceMinutes(emp.workSchedule, lr.startDate, lr.endDate), 0);
        const shouldMin = Math.max(0, rawShouldMin - absenceMin);

        // Kranktage aus Absence-Modell (direkt erfasste)
        const sickDaysAbsence = emp.absences
          .filter((a) => a.type === "SICK" || a.type === "SICK_CHILD")
          .reduce((sum, a) => {
            const s = a.startDate < start ? start : a.startDate;
            const e2 = a.endDate > end ? end : a.endDate;
            return sum + Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
          }, 0);

        // Kranktage aus LeaveRequest, aufgeteilt nach Attest-Zeitraum
        const sickLeaveRequests = emp.leaveRequests.filter(
          (lr) => lr.leaveType.name === "Krankmeldung" || lr.leaveType.name === "Kinderkrank"
        );

        function daysInRange(from: Date, to: Date): number {
          const s = from < start ? start : from;
          const e2 = to > end ? end : to;
          return Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
        }

        let sickDaysWithAttest    = 0;
        let sickDaysWithoutAttest = sickDaysAbsence;

        for (const lr of sickLeaveRequests) {
          const totalDays = daysInRange(lr.startDate, lr.endDate);
          if (lr.attestPresent && lr.attestValidFrom && lr.attestValidTo) {
            // Schnittmenge: Antragszeitraum ∩ Attest-Zeitraum ∩ Monat
            const attestFrom = lr.attestValidFrom > lr.startDate ? lr.attestValidFrom : lr.startDate;
            const attestTo   = lr.attestValidTo   < lr.endDate   ? lr.attestValidTo   : lr.endDate;
            const attestDays = daysInRange(attestFrom, attestTo);
            sickDaysWithAttest    += attestDays;
            sickDaysWithoutAttest += Math.max(0, totalDays - attestDays);
          } else if (lr.attestPresent) {
            // Attest vorhanden, aber kein Datum → ganzer Zeitraum attestiert
            sickDaysWithAttest += totalDays;
          } else {
            sickDaysWithoutAttest += totalDays;
          }
        }

        // Abwesenheiten aufgeschlüsselt nach Typ
        const SICK_NAMES     = ["Krankmeldung", "Kinderkrank"];
        const nonSickLeave   = emp.leaveRequests.filter(lr => !SICK_NAMES.includes(lr.leaveType.name));

        function daysForTypeName(typeName: string) {
          return emp.leaveRequests
            .filter(lr => lr.leaveType.name === typeName)
            .reduce((sum, lr) => sum + daysInRange(lr.startDate, lr.endDate), 0);
        }

        const vacationDays       = daysForTypeName("Urlaub");
        const overtimeCompDays   = daysForTypeName("Überstundenausgleich");
        const specialLeaveDays   = daysForTypeName("Sonderurlaub");
        const educationDays      = daysForTypeName("Bildungsurlaub");
        const unpaidDays         = daysForTypeName("Unbezahlter Urlaub");
        const maternityDays      = daysForTypeName("Mutterschutz");
        const parentalDays       = daysForTypeName("Elternzeit");

        const totalAbsenceDays = nonSickLeave.reduce((sum, lr) =>
          sum + daysInRange(lr.startDate, lr.endDate), 0);

        return {
          employeeName:   `${emp.firstName} ${emp.lastName}`,
          employeeNumber: emp.employeeNumber,
          workedHours:    Math.round(workedMin / 60 * 100) / 100,
          shouldHours:    Math.round(shouldMin / 60 * 100) / 100,
          // Krankheit
          sickDays:             sickDaysWithAttest + sickDaysWithoutAttest,
          sickDaysWithAttest,
          sickDaysWithoutAttest,
          // Abwesenheiten nach Grund
          vacationDays,
          overtimeCompDays,
          specialLeaveDays,
          educationDays,
          unpaidDays,
          maternityDays,
          parentalDays,
          totalAbsenceDays,
        };
      });

      return { month: parseInt(month), year: y, rows };
    },
  });

  // GET /api/v1/reports/leave-overview?year=
  app.get("/leave-overview", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? new Date().getFullYear().toString());

      const entitlements = await app.prisma.leaveEntitlement.findMany({
        where: {
          year: y,
          employee: { tenantId: req.user.tenantId },
        },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
          leaveType: true,
        },
      });

      return entitlements.map((e) => ({
        employee: e.employee,
        leaveType: e.leaveType,
        year: e.year,
        totalDays: Number(e.totalDays),
        carriedOverDays: Number(e.carriedOverDays),
        usedDays: Number(e.usedDays),
        remainingDays: Number(e.totalDays) + Number(e.carriedOverDays) - Number(e.usedDays),
      }));
    },
  });

  // GET /api/v1/reports/datev?year=&month=  – DATEV LODAS Export
  app.get("/datev", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { year, month } = req.query as { year: string; month: string };
      const y = parseInt(year);
      const m = parseInt(month) - 1;
      const start = new Date(y, m, 1);
      const end = new Date(y, m + 1, 0);

      const employees = await app.prisma.employee.findMany({
        where: { tenantId: req.user.tenantId, exitDate: null },
        include: {
          workSchedule: true,
          timeEntries: {
            where: { date: { gte: start, lte: end }, endTime: { not: null } },
          },
          absences: {
            where: { startDate: { lte: end }, endDate: { gte: start } },
          },
          leaveRequests: {
            where: { status: "APPROVED", startDate: { lte: end }, endDate: { gte: start } },
            include: { leaveType: true },
          },
        },
      });

      // DATEV LODAS CSV Format
      // Lohnarten:
      //   100 = Normalstunden          | 200 = Krankheit (AU)
      //   201 = Krankheit Kind         | 300 = Urlaub
      //   301 = Überstundenausgleich   | 302 = Sonderurlaub
      //   303 = Bildungsurlaub         | 304 = Unbezahlter Urlaub
      //   310 = Mutterschutz           | 320 = Elternzeit
      const lines: string[] = [];
      lines.push("Personalnummer;Lohnart;Menge;Einheit;Monat;Jahr;Abwesenheitsgrund");

      function daysInMonthRange(from: Date, to: Date): number {
        const s  = from < start ? start : from;
        const e2 = to   > end   ? end   : to;
        return Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
      }

      function daysForName(emp: typeof employees[0], name: string): number {
        return emp.leaveRequests
          .filter(lr => lr.leaveType.name === name)
          .reduce((sum, lr) => sum + daysInMonthRange(lr.startDate, lr.endDate), 0);
      }

      for (const emp of employees) {
        const pn = emp.employeeNumber;

        const workedMinutes = emp.timeEntries.reduce((sum, e) => {
          if (!e.endTime) return sum;
          return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - e.breakMinutes;
        }, 0);
        const workedHours = (workedMinutes / 60).toFixed(2);

        // Krankheit aus Absence-Modell
        const sickDays      = emp.absences.filter(a => a.type === "SICK")
          .reduce((sum, a) => sum + daysInMonthRange(a.startDate, a.endDate), 0);
        const sickChildDays = emp.absences.filter(a => a.type === "SICK_CHILD")
          .reduce((sum, a) => sum + daysInMonthRange(a.startDate, a.endDate), 0);

        // Abwesenheiten aus LeaveRequest
        const vacationDays     = daysForName(emp, "Urlaub");
        const overtimeCompDays = daysForName(emp, "Überstundenausgleich");
        const specialDays      = daysForName(emp, "Sonderurlaub");
        const educationDays    = daysForName(emp, "Bildungsurlaub");
        const unpaidDays       = daysForName(emp, "Unbezahlter Urlaub");
        const maternityDays    = daysForName(emp, "Mutterschutz");
        const parentalDays     = daysForName(emp, "Elternzeit");

        // Ausgabe
        lines.push(`${pn};100;${workedHours};Std;${month};${year};Arbeitszeit`);
        if (sickDays      > 0) lines.push(`${pn};200;${sickDays};Tag;${month};${year};Krankheit`);
        if (sickChildDays > 0) lines.push(`${pn};201;${sickChildDays};Tag;${month};${year};Krankheit Kind`);
        if (vacationDays  > 0) lines.push(`${pn};300;${vacationDays};Tag;${month};${year};Urlaub`);
        if (overtimeCompDays > 0) lines.push(`${pn};301;${overtimeCompDays};Tag;${month};${year};Überstundenausgleich`);
        if (specialDays   > 0) lines.push(`${pn};302;${specialDays};Tag;${month};${year};Sonderurlaub`);
        if (educationDays > 0) lines.push(`${pn};303;${educationDays};Tag;${month};${year};Bildungsurlaub`);
        if (unpaidDays    > 0) lines.push(`${pn};304;${unpaidDays};Tag;${month};${year};Unbezahlter Urlaub`);
        if (maternityDays > 0) lines.push(`${pn};310;${maternityDays};Tag;${month};${year};Mutterschutz`);
        if (parentalDays  > 0) lines.push(`${pn};320;${parentalDays};Tag;${month};${year};Elternzeit`);
      }

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "DATEV", year, month },
      });

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="datev-${year}-${month}.csv"`);
      return lines.join("\n");
    },
  });
}
