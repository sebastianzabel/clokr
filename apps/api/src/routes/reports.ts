import { FastifyInstance } from "fastify";
import PDFDocument from "pdfkit";
import { formatInTimeZone } from "date-fns-tz";
import { requireRole } from "../middleware/auth";
import {
  getTenantTimezone,
  monthRangeUtc,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "../utils/timezone";
import {
  generateMonthlyReportPdf,
  generateVacationOverviewPdf,
  streamCompanyMonthlyReportPdf,
  streamLeaveListPdf,
} from "../utils/pdf";

// ── Month name lookup ─────────────────────────────────────────────────────────
const MONTH_NAMES = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

// ── Schedule helper types ─────────────────────────────────────────────────────

type WorkSchedule = {
  validFrom: Date;
  type: string;
  monthlyHours?: number | null;
  [key: string]: unknown;
};

type LeaveRequestWithType = {
  startDate: Date;
  endDate: Date;
  status: string;
  deletedAt: Date | null;
  attestPresent: boolean;
  attestValidFrom: Date | null;
  attestValidTo: Date | null;
  leaveType: { name: string };
};

type AbsenceRecord = {
  startDate: Date;
  endDate: Date;
  type: string;
};

type TimeEntryRecord = {
  date: Date;
  startTime: Date;
  endTime: Date | null;
  breakMinutes: number | bigint | null;
  [key: string]: unknown;
};

// Employee shape returned by findMany with all necessary includes
type EmployeeWithIncludes = {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
  hireDate: Date;
  exitDate: Date | null;
  workSchedules: WorkSchedule[];
  timeEntries: TimeEntryRecord[];
  absences: AbsenceRecord[];
  leaveRequests: LeaveRequestWithType[];
  user: { role: "ADMIN" | "MANAGER" | "EMPLOYEE" };
};

// ── computeEmployeeSummary ────────────────────────────────────────────────────
// Pure helper — single source of truth for monthly summary calculation.
// Called by GET /monthly (JSON), GET /monthly/pdf (single-emp), GET /monthly/pdf/all (company).
function computeEmployeeSummary(
  emp: EmployeeWithIncludes,
  start: Date,
  end: Date,
  tz: string,
): {
  workedHours: number;
  targetHours: number;
  overtimeHours: number;
  sickDays: number;
  sickDaysWithAttest: number;
  sickDaysWithoutAttest: number;
  vacationDays: number;
  overtimeCompDays: number;
  specialLeaveDays: number;
  educationDays: number;
  unpaidDays: number;
  maternityDays: number;
  parentalDays: number;
  totalAbsenceDays: number;
  entries: Array<{ date: string; start: string; end: string; breakMin: number; netHours: number; note?: string }>;
} {
  // ── Helper: pick schedule valid on a given date ───────────────────────────
  function getScheduleForDate(schedules: WorkSchedule[], date: Date): WorkSchedule | null {
    return (
      schedules
        .filter((s) => s.validFrom <= date)
        .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime())[0] ?? null
    );
  }

  // ── Soll-Minuten (day-by-day, TZ-aware) ──────────────────────────────────
  function calcShouldMinutes(schedules: WorkSchedule[], hireDate?: Date): number {
    if (schedules.length === 0) return 0;
    const effectiveStart = hireDate && hireDate > start ? hireDate : start;
    const latestSchedule = getScheduleForDate(schedules, end);
    if (latestSchedule && String(latestSchedule.type) === "MONTHLY_HOURS") {
      const mh = Number(latestSchedule.monthlyHours ?? 0);
      return mh > 0 ? mh * 60 : 0;
    }
    let totalMin = 0;
    const cur = new Date(effectiveStart);
    while (cur <= end) {
      const schedule = getScheduleForDate(schedules, cur);
      if (schedule) {
        const dow = getDayOfWeekInTz(cur, tz);
        totalMin += getDayHoursFromSchedule(schedule as Record<string, unknown>, dow) * 60;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return totalMin;
  }

  // ── Abwesenheitsminuten (Schnittmenge mit Monat, TZ-aware) ───────────────
  function calcAbsenceMinutes(schedules: WorkSchedule[], absStart: Date, absEnd: Date): number {
    if (schedules.length === 0) return 0;
    const rangeStart = absStart < start ? start : absStart;
    const rangeEnd = absEnd > end ? end : absEnd;
    let min = 0;
    const cur = new Date(rangeStart);
    while (cur <= rangeEnd) {
      const schedule = getScheduleForDate(schedules, cur);
      if (schedule) {
        const dow = getDayOfWeekInTz(cur, tz);
        min += getDayHoursFromSchedule(schedule as Record<string, unknown>, dow) * 60;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return min;
  }

  // ── Days in range clamped to [start, end] ────────────────────────────────
  function daysInRange(from: Date, to: Date): number {
    const s = from < start ? start : from;
    const e2 = to > end ? end : to;
    return Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
  }

  function daysForTypeName(typeName: string): number {
    return emp.leaveRequests
      .filter((lr) => lr.leaveType.name === typeName)
      .reduce((sum, lr) => sum + daysInRange(lr.startDate, lr.endDate), 0);
  }

  // ── Worked hours ─────────────────────────────────────────────────────────
  const workedMin = emp.timeEntries.reduce((sum, e) => {
    const slotMin = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
    return sum + slotMin - Number(e.breakMinutes ?? 0);
  }, 0);

  // ── Target hours ─────────────────────────────────────────────────────────
  const rawShouldMin = calcShouldMinutes(emp.workSchedules, emp.hireDate);
  const latestSchedule = getScheduleForDate(emp.workSchedules, end);
  const isMonthlyHours = String(latestSchedule?.type ?? "") === "MONTHLY_HOURS";
  // Minijobber (MONTHLY_HOURS) arbeiten flexibel — Abwesenheiten reduzieren Soll nicht
  const absenceMin = isMonthlyHours
    ? 0
    : emp.leaveRequests.reduce(
        (sum, lr) => sum + calcAbsenceMinutes(emp.workSchedules, lr.startDate, lr.endDate),
        0,
      );
  const shouldMin = Math.max(0, rawShouldMin - absenceMin);

  // ── Sick days ────────────────────────────────────────────────────────────
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

  let sickDaysWithAttest = 0;
  let sickDaysWithoutAttest = sickDaysAbsence;

  for (const lr of sickLeaveRequests) {
    const totalDays = daysInRange(lr.startDate, lr.endDate);
    if (lr.attestPresent && lr.attestValidFrom && lr.attestValidTo) {
      const attestFrom = lr.attestValidFrom > lr.startDate ? lr.attestValidFrom : lr.startDate;
      const attestTo = lr.attestValidTo < lr.endDate ? lr.attestValidTo : lr.endDate;
      const attestDays = daysInRange(attestFrom, attestTo);
      sickDaysWithAttest += attestDays;
      sickDaysWithoutAttest += Math.max(0, totalDays - attestDays);
    } else if (lr.attestPresent) {
      sickDaysWithAttest += totalDays;
    } else {
      sickDaysWithoutAttest += totalDays;
    }
  }

  // ── Absence breakdown ────────────────────────────────────────────────────
  const SICK_NAMES = ["Krankmeldung", "Kinderkrank"];
  const nonSickLeave = emp.leaveRequests.filter((lr) => !SICK_NAMES.includes(lr.leaveType.name));
  const totalAbsenceDays = nonSickLeave.reduce(
    (sum, lr) => sum + daysInRange(lr.startDate, lr.endDate),
    0,
  );
  const vacationDays = daysForTypeName("Urlaub");
  const overtimeCompDays = daysForTypeName("Überstundenausgleich");
  const specialLeaveDays = daysForTypeName("Sonderurlaub");
  const educationDays = daysForTypeName("Bildungsurlaub");
  const unpaidDays = daysForTypeName("Unbezahlter Urlaub");
  const maternityDays = daysForTypeName("Mutterschutz");
  const parentalDays = daysForTypeName("Elternzeit");

  // ── Time entries (formatted) ─────────────────────────────────────────────
  const entries = emp.timeEntries.map((e) => ({
    date: formatInTimeZone(e.date, tz, "dd.MM.yyyy"),
    start: formatInTimeZone(e.startTime, tz, "HH:mm"),
    end: e.endTime ? formatInTimeZone(e.endTime, tz, "HH:mm") : "",
    breakMin: Number(e.breakMinutes ?? 0),
    netHours:
      Math.round(
        (((e.endTime!.getTime() - e.startTime.getTime()) / 60000 -
          Number(e.breakMinutes ?? 0)) /
          60) *
          100,
      ) / 100,
    note: (e as Record<string, unknown>).note as string | undefined,
  }));

  const workedHours = Math.round((workedMin / 60) * 100) / 100;
  const targetHours = Math.round((shouldMin / 60) * 100) / 100;

  return {
    workedHours,
    targetHours,
    overtimeHours: Math.round((workedHours - targetHours) * 100) / 100,
    sickDays: sickDaysWithAttest + sickDaysWithoutAttest,
    sickDaysWithAttest,
    sickDaysWithoutAttest,
    vacationDays,
    overtimeCompDays,
    specialLeaveDays,
    educationDays,
    unpaidDays,
    maternityDays,
    parentalDays,
    totalAbsenceDays,
    entries,
  };
}

// ── Common employee include shape ─────────────────────────────────────────────
function buildEmployeeInclude(start: Date, end: Date) {
  return {
    user: { select: { role: true } },
    workSchedules: { orderBy: { validFrom: "asc" } },
    timeEntries: {
      where: {
        deletedAt: null,
        date: { gte: start, lte: end },
        type: "WORK",
        endTime: { not: null },
        isInvalid: false,
      },
      orderBy: { date: "asc" },
    },
    absences: {
      where: { deletedAt: null, startDate: { lte: end }, endDate: { gte: start } },
    },
    leaveRequests: {
      where: {
        deletedAt: null,
        status: "APPROVED",
        startDate: { lte: end },
        endDate: { gte: start },
      },
      include: { leaveType: true },
    },
  } as const;
}

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
      const employees = (await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          ...(employeeId ? { id: employeeId } : {}),
          exitDate: null,
          user: { isActive: true },
        },
        include: buildEmployeeInclude(start, end),
        orderBy: { lastName: "asc" },
      })) as unknown as EmployeeWithIncludes[];

      const rows = employees.map((emp) => {
        const summary = computeEmployeeSummary(emp, start, end, tz);
        return {
          employeeId: emp.id,
          employeeName: `${emp.firstName} ${emp.lastName}`,
          employeeNumber: emp.employeeNumber,
          workedHours: summary.workedHours,
          shouldHours: summary.targetHours,
          // Krankheit
          sickDays: summary.sickDays,
          sickDaysWithAttest: summary.sickDaysWithAttest,
          sickDaysWithoutAttest: summary.sickDaysWithoutAttest,
          // Abwesenheiten nach Grund
          vacationDays: summary.vacationDays,
          overtimeCompDays: summary.overtimeCompDays,
          specialLeaveDays: summary.specialLeaveDays,
          educationDays: summary.educationDays,
          unpaidDays: summary.unpaidDays,
          maternityDays: summary.maternityDays,
          parentalDays: summary.parentalDays,
          totalAbsenceDays: summary.totalAbsenceDays,
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
        where: { tenantId: req.user.tenantId, exitDate: null, user: { isActive: true } },
        include: {
          workSchedules: { orderBy: { validFrom: "asc" } },
          timeEntries: {
            where: {
              deletedAt: null,
              date: { gte: start, lte: end },
              endTime: { not: null },
              isInvalid: false,
            },
          },
          absences: {
            where: { deletedAt: null, startDate: { lte: end }, endDate: { gte: start } },
          },
          leaveRequests: {
            where: {
              deletedAt: null,
              status: "APPROVED",
              startDate: { lte: end },
              endDate: { gte: start },
            },
            include: { leaveType: true },
          },
        },
      });

      // ── DATEV LODAS ASCII-Import Format ────────────────────────────
      // 11 Felder, Semikolon-getrennt, Dezimal-Komma
      // Personalnummer;Kalendertag;Ausfallschlüssel;Lohnartennummer;
      // Stundenanzahl;Tagesanzahl;Wert;Abweichender Faktor;
      // Abweichende Lohnveränderung;Kostenstellennummer;Kostenträger
      //
      // Ausfallschlüssel: U=Urlaub, K=Krank, S=Sonderurlaub, (leer)=Arbeit
      // Lohnarten (konfigurierbar im Mandant):
      //   100 = Normalstunden          | 200 = Krankheit (AU)
      //   201 = Krankheit Kind         | 300 = Urlaub
      //   301 = Überstundenausgleich   | 302 = Sonderurlaub
      //   303 = Bildungsurlaub         | 304 = Unbezahlter Urlaub
      //   310 = Mutterschutz           | 320 = Elternzeit

      const lines: string[] = [];
      // DATEV header row
      lines.push(
        "Personalnummer;Kalendertag;Ausfallschluessel;Lohnartennummer;Stundenanzahl;Tagesanzahl;Wert;Abweichender Faktor;Abweichende Lohnveraenderung;Kostenstellennummer;Kostentraeger",
      );

      /** Dezimal mit Komma formatieren */
      function dec(n: number, digits = 2): string {
        return n.toFixed(digits).replace(".", ",");
      }

      /** Arbeitstage (Mo-Fr) im Schnittmenge aus [from,to] ∩ [start,end] zählen */
      function workDaysInMonthRange(from: Date, to: Date): number {
        const s = from < start ? start : from;
        const e2 = to > end ? end : to;
        let count = 0;
        const cur = new Date(s);
        while (cur <= e2) {
          const dow = cur.getUTCDay();
          if (dow !== 0 && dow !== 6) count++;
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
        return count;
      }

      function daysForName(emp: (typeof employees)[0], name: string): number {
        return emp.leaveRequests
          .filter((lr) => lr.leaveType.name === name)
          .reduce((sum, lr) => sum + workDaysInMonthRange(lr.startDate, lr.endDate), 0);
      }

      /** DATEV-Zeile: 11 Felder, leere Felder = Semikolon */
      function datevLine(
        pn: string,
        tag: string,
        ausfall: string,
        lohnart: number,
        stunden: number,
        tage: number,
      ): string {
        return `${pn};${tag};${ausfall};${lohnart};${stunden > 0 ? dec(stunden) : ""};${tage > 0 ? dec(tage, 1) : ""};;;;;`;
      }

      const m = parseInt(month);

      for (const emp of employees) {
        const pn = emp.employeeNumber;
        // Kalendertag = letzter Tag des Monats (DATEV-Konvention für Monatswerte)
        const lastDay = new Date(y, m, 0).getDate();
        const tag = String(lastDay).padStart(2, "0");

        // Arbeitsstunden
        const workedMinutes = emp.timeEntries.reduce((sum, e) => {
          if (!e.endTime) return sum;
          return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - e.breakMinutes;
        }, 0);
        const workedHours = workedMinutes / 60;

        // Krankheit aus Absence-Modell
        const sickDays = emp.absences
          .filter((a) => a.type === "SICK")
          .reduce((sum, a) => sum + workDaysInMonthRange(a.startDate, a.endDate), 0);
        const sickChildDays = emp.absences
          .filter((a) => a.type === "SICK_CHILD")
          .reduce((sum, a) => sum + workDaysInMonthRange(a.startDate, a.endDate), 0);

        // Abwesenheiten aus LeaveRequest (nur Arbeitstage)
        const vacationDays = daysForName(emp, "Urlaub");
        const overtimeCompDays = daysForName(emp, "Überstundenausgleich");
        const specialDays = daysForName(emp, "Sonderurlaub");
        const educationDays = daysForName(emp, "Bildungsurlaub");
        const unpaidDays = daysForName(emp, "Unbezahlter Urlaub");
        const maternityDays = daysForName(emp, "Mutterschutz");
        const parentalDays = daysForName(emp, "Elternzeit");

        // DATEV-Zeilen (Format: 11 Felder, Semikolon-getrennt)
        lines.push(datevLine(pn, tag, "", 100, workedHours, 0));
        if (sickDays > 0) lines.push(datevLine(pn, tag, "K", 200, 0, sickDays));
        if (sickChildDays > 0) lines.push(datevLine(pn, tag, "K", 201, 0, sickChildDays));
        if (vacationDays > 0) lines.push(datevLine(pn, tag, "U", 300, 0, vacationDays));
        if (overtimeCompDays > 0) lines.push(datevLine(pn, tag, "U", 301, 0, overtimeCompDays));
        if (specialDays > 0) lines.push(datevLine(pn, tag, "S", 302, 0, specialDays));
        if (educationDays > 0) lines.push(datevLine(pn, tag, "S", 303, 0, educationDays));
        if (unpaidDays > 0) lines.push(datevLine(pn, tag, "", 304, 0, unpaidDays));
        if (maternityDays > 0) lines.push(datevLine(pn, tag, "", 310, 0, maternityDays));
        if (parentalDays > 0) lines.push(datevLine(pn, tag, "", 320, 0, parentalDays));
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

      const emp = (await app.prisma.employee.findFirst({
        where: {
          id: employeeId,
          tenantId: req.user.tenantId,
        },
        include: buildEmployeeInclude(start, end),
      })) as unknown as EmployeeWithIncludes | null;

      if (!emp) {
        reply.code(404);
        return { error: "Mitarbeiter nicht gefunden" };
      }

      const summary = computeEmployeeSummary(emp, start, end, tz);

      const pdfBuffer = await generateMonthlyReportPdf({
        tenantName: tenant?.name ?? "",
        employeeName: `${emp.firstName} ${emp.lastName}`,
        employeeNumber: emp.employeeNumber,
        month: `${MONTH_NAMES[m - 1]} ${y}`,
        workedHours: summary.workedHours,
        targetHours: summary.targetHours,
        overtimeHours: summary.overtimeHours,
        sickDays: summary.sickDays,
        sickDaysWithAttest: summary.sickDaysWithAttest,
        vacationDays: summary.vacationDays,
        otherAbsenceDays: summary.totalAbsenceDays - summary.vacationDays,
        entries: summary.entries,
      });

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "MONTHLY_PDF", year, month, employeeId },
      });

      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `attachment; filename="monatsbericht-${y}-${String(m).padStart(2, "0")}-${emp.employeeNumber}.pdf"`,
      );
      return reply.send(pdfBuffer);
    },
  });

  // GET /api/v1/reports/monthly/pdf/all?year=&month=&role=  — PDF-01/PDF-03/PDF-05
  app.get("/monthly/pdf/all", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { year, month, role } = req.query as {
        year: string;
        month: string;
        role?: string;
      };
      const y = parseInt(year);
      const m = parseInt(month);

      // ALLOWLIST validation — never pass untrusted string to Prisma enum
      const roleFilter: "EMPLOYEE" | "MANAGER" | undefined =
        role === "MANAGER" ? "MANAGER" : role === "EMPLOYEE" ? "EMPLOYEE" : undefined;

      const tz = await getTenantTimezone(app.prisma, req.user.tenantId);
      const { start, end } = monthRangeUtc(y, m, tz);

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      const employees = (await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          exitDate: null,
          user: { isActive: true, ...(roleFilter ? { role: roleFilter } : {}) },
        },
        include: buildEmployeeInclude(start, end),
        orderBy: { lastName: "asc" },
      })) as unknown as EmployeeWithIncludes[];

      if (employees.length === 0) {
        reply.code(404);
        return { error: "Keine Mitarbeiter gefunden" };
      }

      const rows = employees.map((emp) => {
        const summary = computeEmployeeSummary(emp, start, end, tz);
        return {
          employeeName: `${emp.firstName} ${emp.lastName}`,
          employeeNumber: emp.employeeNumber,
          role: emp.user.role,
          ...summary,
        };
      });

      const doc = new PDFDocument({ size: "A4", margin: 50 });
      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `attachment; filename="monatsbericht-alle-${y}-${String(m).padStart(2, "0")}.pdf"`,
      );

      streamCompanyMonthlyReportPdf(doc, {
        tenantName: tenant?.name ?? "",
        month: `${MONTH_NAMES[m - 1]} ${y}`,
        year: y,
        monthNumber: m,
        roleFilter: roleFilter ?? "all",
        rows,
      });
      doc.end(); // CRITICAL: end() BEFORE reply.send() per RESEARCH.md Pitfall 1

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "COMPANY_MONTHLY_PDF", year, month, role: roleFilter ?? "all" },
      });

      return reply.send(doc);
    },
  });

  // GET /api/v1/reports/leave-list/pdf?year=  — PDF-02/PDF-05
  app.get("/leave-list/pdf", {
    schema: { tags: ["Reporting"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { year } = req.query as { year: string };
      const y = parseInt(year ?? new Date().getFullYear().toString());
      const yearStart = new Date(`${y}-01-01T00:00:00.000Z`);
      const yearEnd = new Date(`${y}-12-31T23:59:59.999Z`);

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true },
      });

      const employees = await app.prisma.employee.findMany({
        where: {
          tenantId: req.user.tenantId,
          exitDate: null,
          user: { isActive: true },
        },
        include: {
          leaveRequests: {
            where: {
              deletedAt: null,
              status: "APPROVED",
              startDate: { lte: yearEnd },
              endDate: { gte: yearStart },
            },
            include: { leaveType: true },
            orderBy: { startDate: "asc" },
          },
        },
        orderBy: { lastName: "asc" },
      });

      // Build leave list data (include all employees, even those with no leave — show empty periods)
      const leaveListData = {
        tenantName: tenant?.name ?? "",
        year: y,
        employees: employees.map((emp) => {
          const periods = emp.leaveRequests.map((lr) => {
            // Clamp to year boundaries
            const s = lr.startDate < yearStart ? yearStart : lr.startDate;
            const e2 = lr.endDate > yearEnd ? yearEnd : lr.endDate;
            const days = Math.max(0, Math.round((e2.getTime() - s.getTime()) / 86400000) + 1);
            return {
              startDate: formatInTimeZone(lr.startDate, "Europe/Berlin", "dd.MM.yyyy"),
              endDate: formatInTimeZone(lr.endDate, "Europe/Berlin", "dd.MM.yyyy"),
              leaveTypeName: lr.leaveType.name,
              days,
            };
          });
          return {
            employeeName: `${emp.firstName} ${emp.lastName}`,
            employeeNumber: emp.employeeNumber,
            periods,
            totalDays: periods.reduce((sum, p) => sum + p.days, 0),
          };
        }),
      };

      const doc = new PDFDocument({ size: "A4", margin: 50 });
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `attachment; filename="urlaubsliste-${y}.pdf"`);

      streamLeaveListPdf(doc, leaveListData);
      doc.end(); // CRITICAL: before reply.send

      await app.audit({
        userId: req.user.sub,
        action: "EXPORT",
        entity: "Report",
        newValue: { type: "LEAVE_LIST_PDF", year },
      });

      return reply.send(doc);
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
      const empMap = new Map<
        string,
        {
          name: string;
          employeeNumber: string;
          totalDays: number;
          usedDays: number;
          remainingDays: number;
          carriedOver: number;
        }
      >();

      for (const e of entitlements) {
        if (e.leaveType.name !== "Urlaub") continue;
        const key = e.employee.employeeNumber;
        const existing = empMap.get(key);
        const total = Number(e.totalDays);
        const carried = Number(e.carriedOverDays);
        const used = Number(e.usedDays);
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
