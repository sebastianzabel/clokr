import { FastifyInstance } from "fastify";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  getEffectiveSchedule,
  computeOvertimeBalanceBreakdown,
  type OvertimeBalanceBreakdown,
} from "./time-entries";
import {
  getTenantTimezone,
  todayInTz,
  dateStrInTz,
  weekRangeUtc,
  monthRangeUtc,
  monthDayBounds,
  calcExpectedMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
  iterateDaysInTz,
  timeStrInTz,
} from "../utils/timezone";
import { resolvePresenceState, isObligatedWorkday, isDayDue } from "../utils/presence";
import type { PresenceEntry, PresenceLeave, PresenceAbsence } from "../utils/presence";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { getConfirmedCarryOver, getConfirmedCarryOverBulk } from "../utils/confirmed-saldo"; // Phase 97-04
import { findMissingWorkdays } from "../utils/find-missing-workdays"; // Phase 111 — canonical gap detector
import { findUnconfirmedBreakDays } from "../utils/find-unconfirmed-break-days"; // Phase 126 — canonical unconfirmed-Pflichtpause detector (BREAK-05)

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
          periodType: "week" as const,
          scheduleType: null,
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
      // For FIXED_SCHEDULE / FLEXTIME / SHIFT_BASED: fetch hours worked this week (weekStart..weekEnd).
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

      // Keep weekMinutes for backwards-compat (used as week.workedHours for FIXED_SCHEDULE / FLEXTIME / SHIFT_BASED)
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
        // FIXED_SCHEDULE / FLEXTIME / SHIFT_BASED: sum scheduled hours from week start up to today (inclusive).
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
      // LIVE lifetime saldo through windowEnd (today only if today has completed entries, else
      // yesterday), from the SAME source of truth updateOvertimeAccount persists — so the KPI
      // reflects "as of yesterday" while the current day is incomplete, instead of the stale
      // event-driven OvertimeAccount.balanceHours. computeOvertimeBalanceBreakdown returns null
      // for §18-exempt employees. Fail-safe: on any error, fall back to the stored value so the
      // dashboard never 500s on the saldo tile.
      //
      // Phase 97-04 (SALDO-DISP-01/02/04) — the SAME call additively yields confirmedMinutes /
      // openMonthMinutes / hasClosedMonth / rosterIncomplete, mirroring the fail-safe shape
      // 97-01 established on GET /overtime/:employeeId. Both non-happy branches (exempt →
      // breakdown null, or the catch) fall back identically: read confirmedMinutes/hasClosedMonth
      // from the independent getConfirmedCarryOver query and report openMonthMinutes: null so the
      // forecast renders as unavailable — a fabricated 0 there would be indistinguishable from a
      // genuine zero forecast. That fallback query is itself never-500 (own try/catch): a failure
      // of getConfirmedCarryOver still yields the stored balanceHours.
      let overtimeBalance: number;
      let confirmedMinutes: number;
      let openMonthMinutes: number | null;
      let hasClosedMonth: boolean;
      let rosterIncomplete: boolean | undefined;

      let breakdown: OvertimeBalanceBreakdown | null = null;
      try {
        breakdown = await computeOvertimeBalanceBreakdown(app, employeeId);
      } catch (err) {
        app.log.warn({ err, employeeId }, "dashboard: live overtime saldo failed, using stored");
        // breakdown stays null (its declared initial value) — never reassigned here.
      }

      if (breakdown !== null) {
        overtimeBalance = breakdown.totalHours;
        confirmedMinutes = breakdown.confirmedMinutes;
        openMonthMinutes = breakdown.openMonthMinutes;
        hasClosedMonth = breakdown.hasClosedMonth;
        rosterIncomplete = breakdown.rosterIncomplete;
      } else {
        const acct = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
        overtimeBalance = Number(acct?.balanceHours ?? 0);
        try {
          const confirmed = await getConfirmedCarryOver(app, employeeId);
          confirmedMinutes = confirmed.minutes;
          hasClosedMonth = confirmed.hasClosedMonth;
        } catch (fallbackErr) {
          app.log.warn(
            { err: fallbackErr, employeeId },
            "dashboard: confirmed carry-over fallback failed",
          );
          confirmedMinutes = 0;
          hasClosedMonth = false;
        }
        openMonthMinutes = null;
        rosterIncomplete = undefined;
      }

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
        // Phase 49.1 — expose schedule type so frontend can branch widgets per model.
        // Returns null when no schedule exists (transient state for freshly created employees);
        // frontend treats null as "no daily/weekly target to display".
        scheduleType: (schedule.type ?? null) as
          | "FIXED_SCHEDULE"
          | "FLEXTIME"
          | "MONTHLY_HOURS"
          | "SHIFT_BASED"
          | null,
        month: isMonthlyHoursSchedule
          ? {
              workedHours: round(periodWorkedMinutes / 60),
              targetHours: round(monthSollMinutes / 60),
            }
          : undefined,
        overtime: {
          balanceHours: round(overtimeBalance),
          // Phase 97-04 (SALDO-DISP-01/02/04) — additive split fields. rosterIncomplete only
          // present when defined (SHIFT_BASED open partial month) — never a fabricated `false`.
          confirmedMinutes,
          openMonthMinutes,
          hasClosedMonth,
          ...(rosterIncomplete !== undefined ? { rosterIncomplete } : {}),
        },
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

      // Genehmigte Abwesenheiten (inkl. Urlaubsstornierungen) + offene Anträge (PENDING).
      // Phase 95 SHIFT-01: PENDING leave surfaces as "beantragt" instead of "–".
      const leaveRequests = await app.prisma.leaveRequest.findMany({
        where: {
          employee: { tenantId },
          deletedAt: null, // D-09: exclude soft-deleted leave from calendar/dashboard reads
          status: { in: ["APPROVED", "CANCELLATION_REQUESTED", "PENDING"] },
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
          deletedAt: null, // Phase 67.2 — hide soft-deleted shifts on dashboard week
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

          // Phase 95 SHIFT-01 (Pitfall 2): an employee can have both an APPROVED and a
          // PENDING leave overlapping one day (rare, via corrections). Prefer the
          // non-PENDING (real) leave so APPROVED "Urlaub" wins over "beantragt".
          const leaveMatches = (lr: (typeof leaveRequests)[number]) =>
            lr.employeeId === emp.id &&
            dateStrInTz(lr.startDate, tz) <= dayStr &&
            dateStrInTz(lr.endDate, tz) >= dayStr;
          const leave =
            leaveRequests.find((lr) => leaveMatches(lr) && lr.status !== "PENDING") ??
            leaveRequests.find(leaveMatches);

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

          // Check if this is a workday from the schedule.
          // v1.7.3: source of truth is `WorkSchedule.workDays` (Int[] of weekday indices),
          // NOT just `{day}Hours > 0`. Legacy rows can diverge (Phase 61 audit), and
          // SHIFT_BASED employees often keep default per-day hours but rely on the
          // actual planned shift — for them, "workday" means a shift exists.
          // Without this, the Wochenübersicht falsely reports "Fehlt" on a Monday
          // when the employee's contract has Mo off (workDays=[2,3,4,5]).
          const empSchedule = allSchedules.find((s) => s.employeeId === emp.id);
          const dayDate = new Date(dayStr + "T12:00:00Z");
          const dow = getDayOfWeekInTz(dayDate, tz);
          const expectedHours = empSchedule
            ? getDayHoursFromSchedule(empSchedule as Record<string, unknown>, dow)
            : 0;
          const schedType =
            empSchedule && "type" in empSchedule ? (empSchedule.type as string) : null;
          const scheduleWorkDays = (
            empSchedule && "workDays" in empSchedule
              ? ((empSchedule as { workDays: number[] }).workDays ?? [])
              : []
          ) as number[];
          // Schedule-type-aware obligation: SHIFT_BASED → only a planned shift
          // makes the day a workday; FLEXTIME/MONTHLY_HOURS → never per-day
          // (free daily distribution → no "Fehlt"); FIXED/unknown → workDays
          // array or expectedHours fallback.
          const isWorkday = isObligatedWorkday({
            scheduleType: schedType,
            workDays: scheduleWorkDays,
            dow,
            expectedHours,
            hasShift: shift !== null,
          });

          const todayStr = dateStrInTz(new Date(), tz);
          const nowHHMM = timeStrInTz(new Date(), tz);
          // "Due" = late enough that an absence counts as "Fehlt": past days
          // always; today only after the shift start time has passed (or never
          // for schedules without a known start time). A not-yet-due obligated
          // day must render "scheduled", not "missing" → pass isFuture: !isDue.
          const isDue = isDayDue({
            dayStr,
            todayStr,
            nowHHMM,
            shiftStartTime: shift?.startTime ?? null,
          });
          const isFuture = !isDue;

          // Build typed inputs for the presence resolver
          const presenceEntries: PresenceEntry[] = dayEntries.map((e) => ({
            endTime: e.endTime,
            isInvalid: e.isInvalid,
          }));

          const presenceLeave: PresenceLeave | null = leave
            ? {
                status: leave.status as "APPROVED" | "CANCELLATION_REQUESTED" | "PENDING",
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
        // v1.7.3: workDays is the canonical source of truth (see /team-week).
        const schedType =
          empSchedule && "type" in empSchedule ? (empSchedule.type as string) : null;
        const scheduleWorkDays = (
          empSchedule && "workDays" in empSchedule
            ? ((empSchedule as { workDays: number[] }).workDays ?? [])
            : []
        ) as number[];
        // No shift data fetched here → hasShift:false, so SHIFT_BASED resolves
        // to "not a workday" (avoids false "Fehlt"). FLEXTIME/MONTHLY_HOURS also
        // resolve to false (free daily distribution) so they no longer inflate
        // the "missing" count. FIXED/unknown → workDays or expectedHours.
        const isWorkday = isObligatedWorkday({
          scheduleType: schedType,
          workDays: scheduleWorkDays,
          dow,
          expectedHours,
          hasShift: false,
        });

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
          superseded: false,
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

      // Phase 97-04 (SALDO-DISP-01/02) — ONE bulk lookup for the "Bestätigt" carry-over,
      // placed BEFORE the per-employee Promise.all below (never a per-employee query inside
      // it — the whole point of getConfirmedCarryOverBulk, see confirmed-saldo.ts and
      // 97-CONTEXT's "Known N+1 risk" note). Deliberately NOT the six-month-bounded
      // `snapshots` query above: an employee whose last close predates that window would
      // falsely read as having no closed month at all if reused for this purpose.
      const confirmedByEmp = await getConfirmedCarryOverBulk(app, employeeIds);

      // Per-employee LIVE lifetime saldo through windowEnd (today only if today has completed
      // entries, else yesterday) — SAME source of truth as the dashboard KPI + calendar header
      // (computeOvertimeBalanceBreakdown), replacing the stale event-driven
      // OvertimeAccount.balanceHours. One compute per employee per request (no redundant
      // recompute) — this pre-existing per-employee fan-out (one saldoSnapshot.findFirst per
      // employee, inside the shared helper) is NOT changed by this phase; see
      // dashboard-overtime-overview-n1.test.ts's header for the scope note. TRACK_ONLY → 0
      // (handled inside). Fail-safe: any per-employee error falls back to the stored value so
      // one employee never 500s the whole team overview.
      //
      // Phase 97-04 (SALDO-DISP-01/02/04) — the SAME call additively yields confirmedMinutes /
      // openMonthMinutes / hasClosedMonth / rosterIncomplete for the happy path (no extra
      // query — the value it decomposes was already being computed). The per-employee
      // fail-safe branch and the exempt branch (breakdown null) read confirmedMinutes/
      // hasClosedMonth from the pre-fetched bulk Map above instead (defaulting to zero/false
      // for an employee absent from it) and report openMonthMinutes: null.
      const employees = await Promise.all(
        accounts.map(async (a) => {
          let balanceHours: number;
          let confirmedMinutes: number;
          let openMonthMinutes: number | null;
          let hasClosedMonth: boolean;
          let rosterIncomplete: boolean | undefined;

          let breakdown: OvertimeBalanceBreakdown | null = null;
          try {
            breakdown = await computeOvertimeBalanceBreakdown(app, a.employeeId);
          } catch (err) {
            app.log.warn(
              { err, employeeId: a.employeeId },
              "overtime-overview: live saldo failed, using stored",
            );
            // breakdown stays null (its declared initial value) — never reassigned here.
          }

          if (breakdown !== null) {
            balanceHours = round(breakdown.totalHours);
            confirmedMinutes = breakdown.confirmedMinutes;
            openMonthMinutes = breakdown.openMonthMinutes;
            hasClosedMonth = breakdown.hasClosedMonth;
            rosterIncomplete = breakdown.rosterIncomplete;
          } else {
            balanceHours = Number(a.balanceHours);
            const confirmed = confirmedByEmp.get(a.employeeId) ?? {
              minutes: 0,
              hasClosedMonth: false,
            };
            confirmedMinutes = confirmed.minutes;
            hasClosedMonth = confirmed.hasClosedMonth;
            openMonthMinutes = null;
            rosterIncomplete = undefined;
          }

          return {
            id: a.employeeId,
            name: `${a.employee.firstName} ${a.employee.lastName}`,
            employeeNumber: a.employee.employeeNumber,
            balanceHours,
            status: classifyOvertimeBalance(balanceHours),
            // Phase 97-04 (SALDO-DISP-01/02/04) — additive split fields, same shape as
            // GET /dashboard and GET /overtime/:employeeId.
            confirmedMinutes,
            openMonthMinutes,
            hasClosedMonth,
            ...(rosterIncomplete !== undefined ? { rosterIncomplete } : {}),
            snapshots: (snapshotsByEmp.get(a.employeeId) ?? []).map((s) => ({
              periodStart: s.periodStart.toISOString().slice(0, 10),
              balanceMinutes: s.balanceMinutes,
              carryOver: s.carryOver,
            })),
          };
        }),
      );

      return { employees };
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

      // Phase 49.4: leave + absence overlay for the user week-view
      const myWeekLeaves = await app.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          deletedAt: null, // D-09: exclude soft-deleted leave from calendar/dashboard reads
          // Phase 95 SHIFT-01: include PENDING so an open request shows "beantragt".
          status: { in: ["APPROVED", "CANCELLATION_REQUESTED", "PENDING"] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        // `status` is required for the inline "requested" vs "leave" branch below.
        select: {
          startDate: true,
          endDate: true,
          status: true,
          leaveType: { select: { name: true } },
        },
      });
      const myWeekAbsences = await app.prisma.absence.findMany({
        where: {
          employeeId,
          deletedAt: null,
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { startDate: true, endDate: true, type: true },
      });
      // Phase 49.4 (fix): own shifts for this week so SHIFT_BASED users see the planned shift
      // time on scheduled days instead of a generic "Geplant" label.
      const myWeekShifts = await app.prisma.shift.findMany({
        where: {
          employeeId,
          date: { gte: start, lte: end },
          deletedAt: null, // Phase 67.2 — hide soft-deleted shifts from my-week view
        },
        include: { template: { select: { name: true, color: true } } },
      });
      const scheduleType = (schedule as { type?: string } | null)?.type ?? null;

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
        const hasEntry = dayEntries.length > 0;
        const isClockedIn = dayEntries.some((e) => !e.endTime);
        const isWeekend = dow === 0 || dow === 6;

        // Phase 95 SHIFT-01 (Pitfall 2): prefer a non-PENDING leave so a real
        // APPROVED "Urlaub" wins over a coincident PENDING "beantragt" on the same day.
        const myLeaveMatches = (lr: (typeof myWeekLeaves)[number]) =>
          dateStrInTz(lr.startDate, tz) <= dateStr && dateStrInTz(lr.endDate, tz) >= dateStr;
        const leave =
          myWeekLeaves.find((lr) => myLeaveMatches(lr) && lr.status !== "PENDING") ??
          myWeekLeaves.find(myLeaveMatches);
        const absence = myWeekAbsences.find(
          (a) => dateStrInTz(a.startDate, tz) <= dateStr && dateStrInTz(a.endDate, tz) >= dateStr,
        );
        const dayShifts = myWeekShifts.filter((s) => dateStrInTz(s.date, tz) === dateStr);
        const shift =
          dayShifts.length > 0
            ? {
                startTime: dayShifts[0].startTime,
                endTime: dayShifts[0].endTime,
                label: dayShifts[0].label ?? dayShifts[0].template?.name ?? null,
                color: dayShifts[0].template?.color ?? null,
              }
            : null;
        const hasShift = shift !== null;

        // Schedule-type-aware obligation (fixes flexible schedules never being
        // "Fehlt" and SHIFT_BASED-without-shift no longer being "Fehlt").
        const isWorkday = isObligatedWorkday({
          scheduleType,
          workDays: (schedule as { workDays?: number[] } | null)?.workDays ?? [],
          dow,
          expectedHours: expectedMin / 60,
          hasShift,
        });
        // Due-aware timing: past days always due; today only after the shift
        // start time has passed (or never for a schedule without a start time).
        // Replaces the isPast-only branch so a today shift whose start has passed
        // renders "missing", while flexible/before-shift days render "scheduled".
        const isDue = isDayDue({
          dayStr: dateStr,
          todayStr: dateStrInTz(new Date(), tz),
          nowHHMM: timeStrInTz(new Date(), tz),
          shiftStartTime: shift?.startTime ?? null,
        });

        let status = "none";
        if (isClockedIn) status = "clocked_in";
        else if (hasEntry) status = workedMin >= expectedMin ? "complete" : "partial";
        // Phase 95 SHIFT-01: a PENDING leave surfaces as "requested" ("beantragt"),
        // an APPROVED/CANCELLATION_REQUESTED one stays green "leave".
        else if (leave) status = leave.status === "PENDING" ? "requested" : "leave";
        else if (absence) {
          status = absence.type === "SICK" || absence.type === "SICK_CHILD" ? "sick" : "absent";
        } else if (holidayName) status = "holiday";
        else if (isWeekend && !hasShift) status = "weekend";
        else if (isDue && (isWorkday || hasShift)) status = "missing";
        else if (isWorkday || hasShift) status = "scheduled";

        return {
          date: dateStr,
          workedHours: round(workedMin / 60),
          expectedHours: round(expectedMin / 60),
          status,
          isWorkday,
          isWeekend,
          holidayName,
          leaveType: leave?.leaveType.name ?? null,
          absenceType: absence?.type ?? null,
          shift,
        };
      });

      return { weekDays, scheduleType, days };
    },
  });

  // GET /api/v1/dashboard/open-items — offene Vorgänge für den MA (+ pending approvals für Manager)
  app.get("/open-items", {
    schema: { tags: ["Dashboard"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const employeeId = req.user.employeeId;
      const tenantId = req.user.tenantId;
      const role = req.user.role;
      const isManager = role === "ADMIN" || role === "MANAGER";
      const tz = await getTenantTimezone(app.prisma, tenantId);
      const today = todayInTz(tz);
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      // findMissingWorkdays' effectiveEnd is INCLUSIVE; the replaced loop ran `cursor < today`,
      // so the last day of the window is yesterday. Window size and bounds are unchanged.
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      // Personal open items (only when the user has an employee record)
      const missingDays: string[] = [];
      let pendingRequestsCount = 0;
      let invalidEntriesCount = 0;
      let unconfirmedBreakDays: string[] = [];

      if (employeeId) {
        // Phase 126: hoisted out of the §18-exemption short-circuit because the break-confirmation
        // derivation below needs scheduleType too, and an exempt employee is still subject to
        // break confirmation — the client-side counter this replaces never checked exemption either.
        const schedule = await getEffectiveSchedule(app, employeeId);

        // Phase 76.7 (D-08, UI-V19-04 supporting backend) — exempt employees never
        // get "missing dates" surfaced on their personal dashboard. The Stempeluhr
        // CTA is also hidden client-side (Plan 03), but we short-circuit here so the
        // open-items query stays cheap. BUrlG signals (pendingRequests +
        // invalidEntries) stay outside this guard — vacation tracking still applies.
        const meEmployee = await app.prisma.employee.findUnique({
          where: { id: employeeId },
          select: { isTimeTrackingExempt: true, hireDate: true, exitDate: true },
        });
        if (!meEmployee?.isTimeTrackingExempt) {
          // 1. Missing time entries (workdays without entries in last 7 days)
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

          // Approved leave + Absences in the 7-day window cover the day too
          // (mirrors overtime.ts close-month/status logic — a day is only "missing"
          // if no entry, no holiday, no leave, no absence covers it)
          const approvedLeaveInWindow = await app.prisma.leaveRequest.findMany({
            where: {
              employeeId,
              deletedAt: null,
              status: "APPROVED",
              startDate: { lte: today },
              endDate: { gte: sevenDaysAgo },
            },
            select: { startDate: true, endDate: true, halfDay: true },
          });
          const absencesInWindow = await app.prisma.absence.findMany({
            where: {
              employeeId,
              deletedAt: null,
              startDate: { lte: today },
              endDate: { gte: sevenDaysAgo },
            },
            select: { startDate: true, endDate: true, halfDay: true },
          });

          // Phase 111 (issue #114) — the inline `{day}Hours > 0` predicate that used to live here
          // read {day}Hours for EVERY schedule type. For SHIFT_BASED/FLEXTIME/MONTHLY_HOURS those
          // columns are a legacy 1/0 flag, not hours, so a free day with thursdayHours=1 was
          // reported as missing forever. Commit 523d7042 (v1.9.5) fixed the three sibling sites in
          // this file and missed this one. Route through the canonical detector instead — the same
          // one the Monatsabschluss and GET /overtime/close-month/status use, so card and
          // Monatsabschluss cannot drift apart.
          const openItemsScheduleType = String(schedule?.type ?? "");

          // SHIFT_BASED obligation comes from the roster, never from {day}Hours (pitfall A4).
          // Tenant-scoped via the employee relation + soft-delete filtered (CLAUDE.md).
          let openItemsRosterDates: Set<string> | undefined;
          if (openItemsScheduleType === "SHIFT_BASED") {
            const openItemsShifts = await app.prisma.shift.findMany({
              where: {
                employeeId,
                employee: { tenantId },
                date: { gte: sevenDaysAgo, lte: yesterday },
                deletedAt: null,
              },
              select: { date: true },
            });
            openItemsRosterDates = new Set(openItemsShifts.map((sh) => dateStrInTz(sh.date, tz)));
          }

          // Clamp to the employment span, mirroring GET /overtime/close-month/status — a day
          // before hire or after exit carries no obligation.
          const hireDate = meEmployee?.hireDate ?? null;
          const exitDate = meEmployee?.exitDate ?? null;
          const openItemsStart = hireDate && hireDate > sevenDaysAgo ? hireDate : sevenDaysAgo;
          const openItemsEnd = exitDate && exitDate < yesterday ? exitDate : yesterday;

          const openItemsGapResult = findMissingWorkdays({
            // Phase 128 (D-01/D-02): the detector's FIXED branch is workDays-primary itself now, so
            // the Phase 111 workDaysPrimarySchedule() projection that used to sit here is gone -
            // this card and the Monatsabschluss read one rule from one place.
            schedule: (schedule ?? {}) as Record<string, unknown>,
            effectiveStart: openItemsStart,
            effectiveEnd: openItemsEnd,
            tz,
            entryDates,
            approvedLeave: approvedLeaveInWindow.map((lr) => ({
              startDate: lr.startDate,
              endDate: lr.endDate,
              halfDay: Boolean(lr.halfDay),
            })),
            absences: absencesInWindow.map((ab) => ({
              startDate: ab.startDate,
              endDate: ab.endDate,
              halfDay: Boolean(ab.halfDay),
            })),
            holidayDateStrings: openItemsHolidaySet,
            rosterDates: openItemsRosterDates,
          });

          // partial:true gaps come from half-day leave/absence days without an entry. This card
          // renders a nagging "Nachtragen" CTA and has never nagged about a leave-covered day;
          // surfacing them here would trade one false positive for a new one. Full gaps only.
          missingDays.push(...openItemsGapResult.gaps.filter((g) => !g.partial).map((g) => g.date));
        }

        // 2. Own pending leave requests — BUrlG still applies for exempt employees
        const pendingRequests = await app.prisma.leaveRequest.findMany({
          where: { employeeId, deletedAt: null, status: "PENDING" },
          select: { id: true },
        });
        pendingRequestsCount = pendingRequests.length;

        // 3. Invalidated time entries — leave signal also applies for exempt employees
        const invalidEntries = await app.prisma.timeEntry.findMany({
          where: { employeeId, deletedAt: null, isInvalid: true },
          select: { id: true },
        });
        invalidEntriesCount = invalidEntries.length;

        // 3b. Unbestätigte Pflichtpausen (§ 4 ArbZG, BREAK-05) — Phase 126, GitHub issue #126.
        //
        // D-02: the number is produced HERE, by the canonical detector, and never again by a
        // client-side predicate. Before this, dashboard/+page.svelte counted AUTO days itself over a
        // 12-MONTH window with none of the detector's filters (no type:"WORK", no
        // MONTHLY_HOURS/FLEXTIME exclusion), so the card demanded action on days the backend does not
        // know about. Same error class as the inline {day}Hours predicate Phase 111 removed above.
        //
        // D-01: the window is the CURRENT MONTH — deliberately NOT widened to match the old client
        // counter. Days outside the current month trigger no notification and block no
        // Monatsabschluss; a hint demanding an unenforced action IS the defect (Phase 113 / #116
        // removed exactly such a promise rather than building it). Making older months actionable
        // also opens the question of whether they should block month close — its own domain ticket.
        //
        // D-09: no explicit enforceBreakConfirmation branch here. findUnconfirmedBreakDays returns []
        // for an un-opted tenant as its FIRST check (BREAK-05 Gesamt-Opt-in), so the gate is inherited.
        const breakTenantConfig = await app.prisma.tenantConfig.findUnique({
          where: { tenantId },
          select: { enforceBreakConfirmation: true },
        });
        const breakMonthRef = todayInTz(tz);
        const { start: breakMonthStart, end: breakMonthEnd } = monthRangeUtc(
          breakMonthRef.getUTCFullYear(),
          breakMonthRef.getUTCMonth() + 1,
          tz,
        );
        const { firstDay: breakMonthFirstDay, lastDay: breakMonthLastDay } = monthDayBounds(
          breakMonthStart,
          breakMonthEnd,
          tz,
        );
        unconfirmedBreakDays = await findUnconfirmedBreakDays(app.prisma, {
          employeeId,
          monthFirstDay: breakMonthFirstDay,
          monthLastDay: breakMonthLastDay,
          tz,
          scheduleType: String(schedule?.type ?? ""),
          enforceBreakConfirmation: breakTenantConfig?.enforceBreakConfirmation ?? false,
        });
      }

      // 4. Team-wide pending approvals (only for managers/admins)
      let pendingApprovalsCount = 0;
      if (isManager) {
        pendingApprovalsCount = await app.prisma.leaveRequest.count({
          where: {
            employee: { tenantId },
            deletedAt: null,
            status: { in: ["PENDING", "CANCELLATION_REQUESTED"] },
            // Exclude own requests so they don't double-count with pendingRequests
            ...(employeeId ? { employeeId: { not: employeeId } } : {}),
          },
        });
      }

      // unconfirmedBreakDays is deliberately NOT summed into `total`. `total` is the Phase-111
      // contract the client feeds into hasNoOpenItems($lib/leave/karenz-nudge.ts) as a value
      // SEPARATE from the break and Karenz counts; folding it in here would double-count it there.
      const total =
        missingDays.length + pendingRequestsCount + invalidEntriesCount + pendingApprovalsCount;

      return {
        missingDays,
        pendingRequests: pendingRequestsCount,
        invalidEntries: invalidEntriesCount,
        pendingApprovals: pendingApprovalsCount,
        unconfirmedBreakDays,
        total,
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
