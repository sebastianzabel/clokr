import { FastifyInstance } from "fastify";
import { formatInTimeZone } from "date-fns-tz";
import { requireRole } from "../middleware/auth";
import { getTenantTimezone, monthRangeUtc, calcExpectedMinutesTz, getDayOfWeekInTz, getDayHoursFromSchedule } from "../utils/timezone";
import { generateMonthlyReportPdf, generateVacationOverviewPdf } from "../utils/pdf";

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
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, parseInt(month), tz);

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

      // Soll-Stunden: kalenderbasiert über Wochentag-Soll aus WorkSchedule (TZ-aware)
      function calcShouldMinutes(schedule: { mondayHours: unknown; tuesdayHours: unknown; wednesdayHours: unknown; thursdayHours: unknown; fridayHours: unknown; saturdayHours: unknown; sundayHours: unknown } | null): number {
        if (!schedule) return 0;
        return calcExpectedMinutesTz(schedule as Record<string, unknown>, start, end, tz);
      }

      // Tagesweise Soll-Minuten für einen Zeitraum (Schnittmenge mit Monat, TZ-aware)
      function absenceMinutes(
        schedule: { mondayHours: unknown; tuesdayHours: unknown; wednesdayHours: unknown; thursdayHours: unknown; fridayHours: unknown; saturdayHours: unknown; sundayHours: unknown } | null,
        absStart: Date,
        absEnd: Date,
      ): number {
        if (!schedule) return 0;
        // Schnittmenge mit Monatsgrenzen
        const rangeStart = absStart < start ? start : absStart;
        const rangeEnd   = absEnd   > end   ? end   : absEnd;
        let min = 0;
        const cur = new Date(rangeStart);
        while (cur <= rangeEnd) {
          const dow = getDayOfWeekInTz(cur, tz);
          min += getDayHoursFromSchedule(schedule as Record<string, unknown>, dow) * 60;
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
          employeeId:     emp.id,
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
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, parseInt(month), tz);

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

  // GET /api/v1/reports/monthly/pdf?employeeId=&year=&month=
  app.get("/monthly/pdf", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId, year, month } = req.query as {
        employeeId: string;
        year: string;
        month: string;
      };

      const y = parseInt(year);
      const m = parseInt(month);
      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      const emp = await app.prisma.employee.findFirst({
        where: {
          id: employeeId,
          tenantId: req.user.tenantId,
        },
        include: {
          workSchedule: true,
          timeEntries: {
            where: { date: { gte: start, lte: end }, type: "WORK", endTime: { not: null } },
            orderBy: { date: "asc" },
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

      if (!emp) {
        reply.code(404);
        return { error: "Mitarbeiter nicht gefunden" };
      }

      // Soll-Minuten
      function calcShouldMinutes(schedule: Record<string, unknown> | null): number {
        if (!schedule) return 0;
        return calcExpectedMinutesTz(schedule, start, end, tz);
      }

      function absenceMinutes(
        schedule: Record<string, unknown> | null,
        absStart: Date,
        absEnd: Date,
      ): number {
        if (!schedule) return 0;
        const rangeStart = absStart < start ? start : absStart;
        const rangeEnd   = absEnd   > end   ? end   : absEnd;
        let min = 0;
        const cur = new Date(rangeStart);
        while (cur <= rangeEnd) {
          const dow = getDayOfWeekInTz(cur, tz);
          min += getDayHoursFromSchedule(schedule, dow) * 60;
          cur.setDate(cur.getDate() + 1);
        }
        return min;
      }

      const workedMin = emp.timeEntries.reduce((sum, e) => {
        const slotMin = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
        return sum + slotMin - Number(e.breakMinutes ?? 0);
      }, 0);

      const rawShouldMin = calcShouldMinutes(emp.workSchedule as unknown as Record<string, unknown>);
      const absenceMin = emp.leaveRequests.reduce((sum, lr) =>
        sum + absenceMinutes(emp.workSchedule as unknown as Record<string, unknown>, lr.startDate, lr.endDate), 0);
      const shouldMin = Math.max(0, rawShouldMin - absenceMin);

      const workedHours = Math.round(workedMin / 60 * 100) / 100;
      const targetHours = Math.round(shouldMin / 60 * 100) / 100;

      // Sick days
      const sickDaysAbsence = emp.absences
        .filter((a) => a.type === "SICK" || a.type === "SICK_CHILD")
        .reduce((sum, a) => {
          const s = a.startDate < start ? start : a.startDate;
          const e2 = a.endDate > end ? end : a.endDate;
          return sum + Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
        }, 0);

      const sickLeaveRequests = emp.leaveRequests.filter(
        (lr) => lr.leaveType.name === "Krankmeldung" || lr.leaveType.name === "Kinderkrank",
      );

      function daysInRange(from: Date, to: Date): number {
        const s = from < start ? start : from;
        const e2 = to > end ? end : to;
        return Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
      }

      let sickDaysWithAttest = 0;
      let sickDaysTotal = sickDaysAbsence;

      for (const lr of sickLeaveRequests) {
        const totalDays = daysInRange(lr.startDate, lr.endDate);
        if (lr.attestPresent && lr.attestValidFrom && lr.attestValidTo) {
          const attestFrom = lr.attestValidFrom > lr.startDate ? lr.attestValidFrom : lr.startDate;
          const attestTo   = lr.attestValidTo   < lr.endDate   ? lr.attestValidTo   : lr.endDate;
          sickDaysWithAttest += daysInRange(attestFrom, attestTo);
          sickDaysTotal += totalDays;
        } else if (lr.attestPresent) {
          sickDaysWithAttest += totalDays;
          sickDaysTotal += totalDays;
        } else {
          sickDaysTotal += totalDays;
        }
      }

      const SICK_NAMES = ["Krankmeldung", "Kinderkrank"];
      function daysForTypeName(typeName: string) {
        return emp!.leaveRequests
          .filter(lr => lr.leaveType.name === typeName)
          .reduce((sum, lr) => sum + daysInRange(lr.startDate, lr.endDate), 0);
      }

      const vacationDays = daysForTypeName("Urlaub");
      const nonSickLeave = emp.leaveRequests.filter(lr => !SICK_NAMES.includes(lr.leaveType.name));
      const totalAbsenceDays = nonSickLeave.reduce((sum, lr) =>
        sum + daysInRange(lr.startDate, lr.endDate), 0);

      const monthNames = [
        "Januar", "Februar", "März", "April", "Mai", "Juni",
        "Juli", "August", "September", "Oktober", "November", "Dezember",
      ];

      // Time entries for table
      const entries = emp.timeEntries.map((e) => ({
        date: formatInTimeZone(e.date, tz, "dd.MM.yyyy"),
        start: formatInTimeZone(e.startTime, tz, "HH:mm"),
        end: e.endTime ? formatInTimeZone(e.endTime, tz, "HH:mm") : "",
        breakMin: Number(e.breakMinutes ?? 0),
        netHours: Math.round(((e.endTime!.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes ?? 0)) / 60 * 100) / 100,
        note: (e as Record<string, unknown>).note as string | undefined,
      }));

      const pdfBuffer = await generateMonthlyReportPdf({
        tenantName: tenant?.name ?? "",
        employeeName: `${emp.firstName} ${emp.lastName}`,
        employeeNumber: emp.employeeNumber,
        month: `${monthNames[m - 1]} ${y}`,
        workedHours,
        targetHours,
        overtimeHours: workedHours - targetHours,
        sickDays: sickDaysTotal,
        sickDaysWithAttest,
        vacationDays,
        otherAbsenceDays: totalAbsenceDays - vacationDays,
        entries,
      });

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "MONTHLY_PDF", year, month, employeeId },
      });

      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `attachment; filename="monatsbericht-${y}-${String(m).padStart(2, "0")}-${emp.employeeNumber}.pdf"`);
      return reply.send(pdfBuffer);
    },
  });

  // GET /api/v1/reports/leave-overview/pdf?year=
  app.get("/leave-overview/pdf", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? new Date().getFullYear().toString());

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

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

      // Group by employee and aggregate (only "Urlaub" type)
      const empMap = new Map<string, {
        name: string;
        employeeNumber: string;
        totalDays: number;
        usedDays: number;
        remainingDays: number;
        carriedOver: number;
      }>();

      for (const e of entitlements) {
        if (e.leaveType.name !== "Urlaub") continue;
        const key = e.employee.employeeNumber;
        const existing = empMap.get(key);
        const total     = Number(e.totalDays);
        const carried   = Number(e.carriedOverDays);
        const used      = Number(e.usedDays);
        const remaining = total + carried - used;

        if (existing) {
          existing.totalDays += total;
          existing.carriedOver += carried;
          existing.usedDays += used;
          existing.remainingDays += remaining;
        } else {
          empMap.set(key, {
            name: `${e.employee.firstName} ${e.employee.lastName}`,
            employeeNumber: e.employee.employeeNumber,
            totalDays: total,
            carriedOver: carried,
            usedDays: used,
            remainingDays: remaining,
          });
        }
      }

      const pdfBuffer = await generateVacationOverviewPdf({
        tenantName: tenant?.name ?? "",
        year: y,
        employees: [...empMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      });

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "LEAVE_OVERVIEW_PDF", year },
      });

      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `attachment; filename="urlaubsuebersicht-${y}.pdf"`);
      return reply.send(pdfBuffer);
    },
  });
}
