/**
 * Retroactive snapshot recalculation.
 *
 * When saldo-relevant data changes (schedule, leave, holidays),
 * existing monthly snapshots must be recalculated so that carry-over
 * values stay consistent.
 */
import { FastifyInstance } from "fastify";
import { getEffectiveSchedule } from "../routes/time-entries";
import {
  getTenantTimezone,
  dateStrInTz,
  calcExpectedMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "./timezone";
import { getHolidays, STATE_MAP } from "./holidays";

/**
 * Recalculate all MONTHLY SaldoSnapshots for an employee starting from `fromDate`.
 *
 * - Only updates snapshots that already exist (does not create new ones).
 * - Recalculates workedMinutes, expectedMinutes, balanceMinutes, carryOver.
 * - Updates the OvertimeAccount with the final carryOver.
 * - Creates audit log entries per recalculated snapshot.
 *
 * Safe to call multiple times (idempotent).
 */
export async function recalculateSnapshots(
  app: FastifyInstance,
  employeeId: string,
  fromDate: Date,
): Promise<void> {
  // Find all MONTHLY snapshots at or after fromDate
  const snapshots = await app.prisma.saldoSnapshot.findMany({
    where: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: { gte: fromDate },
    },
    orderBy: { periodStart: "asc" },
  });

  if (snapshots.length === 0) return;

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true, hireDate: true, tenant: { select: { federalState: true } } },
  });
  if (!employee) return;

  const tz = await getTenantTimezone(app.prisma, employee.tenantId);
  const tenantConfig = await app.prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
  });

  // Get the carry-over from the snapshot immediately before the first affected one
  const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
    where: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: { lt: snapshots[0].periodStart },
    },
    orderBy: { periodStart: "desc" },
  });
  let runningCarryOver = prevSnapshot?.carryOver ?? 0;

  for (const snapshot of snapshots) {
    const oldValues = {
      workedMinutes: snapshot.workedMinutes,
      expectedMinutes: snapshot.expectedMinutes,
      balanceMinutes: snapshot.balanceMinutes,
      carryOver: snapshot.carryOver,
    };

    const monthStart = snapshot.periodStart;
    const monthEnd = snapshot.periodEnd;

    // Get the effective schedule for the middle of this month
    const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
    const schedule = await getEffectiveSchedule(app, employeeId, midMonth);

    // Calculate worked minutes for the month
    const entries = await app.prisma.timeEntry.findMany({
      where: {
        employeeId,
        deletedAt: null,
        date: { gte: monthStart, lte: monthEnd },
        endTime: { not: null },
        type: "WORK",
        isInvalid: false,
      },
    });

    const workedMinutes = entries.reduce((sum, e) => {
      if (!e.endTime) return sum;
      return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
    }, 0);

    // Calculate expected minutes
    const hireDateNorm = employee.hireDate
      ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
      : null;
    const effectiveStart = hireDateNorm && hireDateNorm > monthStart ? hireDateNorm : monthStart;
    const expectedMinutes = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);

    // Subtract holidays: merge computed Feiertage + DB-stored manual holidays (bugfix: was DB-only)
    const snapStateCode = employee.tenant
      ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
      : "NI";
    const snapYear = monthStart.getUTCFullYear();
    const computedHolidays = getHolidays(snapYear, snapStateCode).filter(
      (h) => h.date >= dateStrInTz(effectiveStart, tz) && h.date <= dateStrInTz(monthEnd, tz),
    );
    const computedDateSet = new Set(computedHolidays.map((h) => h.date));
    const dbSnapHolidays = await app.prisma.publicHoliday.findMany({
      where: {
        tenant: { employees: { some: { id: employeeId } } },
        date: { gte: effectiveStart, lte: monthEnd },
      },
    });
    const allHolidays: { date: Date }[] = [
      ...computedHolidays.map((h) => ({ date: new Date(h.date + "T00:00:00Z") })),
      ...dbSnapHolidays
        .filter((h) => !computedDateSet.has(dateStrInTz(h.date, tz)))
        .map((h) => ({ date: h.date })),
    ];

    // MONTHLY_HOURS Feiertagsabzug (Phase 15 — TENANT-01)
    const isMonthlyHoursDeduction =
      String(schedule.type ?? "") === "MONTHLY_HOURS" &&
      Number(schedule.monthlyHours ?? 0) > 0 &&
      tenantConfig?.monthlyHoursHolidayDeduction === true;

    let workingDaysInRange = 0;
    if (isMonthlyHoursDeduction) {
      const wdCur = new Date(effectiveStart);
      while (wdCur <= monthEnd) {
        const wdDow = getDayOfWeekInTz(wdCur, tz);
        if (getDayHoursFromSchedule(schedule, wdDow) > 0) workingDaysInRange++;
        wdCur.setDate(wdCur.getDate() + 1);
      }
    }
    const dailySollMin =
      isMonthlyHoursDeduction && workingDaysInRange > 0
        ? (Number(schedule.monthlyHours!) * 60) / workingDaysInRange
        : 0;

    const holidayMinutes = allHolidays.reduce((sum, h) => {
      const dow = getDayOfWeekInTz(h.date, tz);
      if (isMonthlyHoursDeduction) {
        return getDayHoursFromSchedule(schedule, dow) > 0 ? sum + dailySollMin : sum;
      }
      return sum + getDayHoursFromSchedule(schedule, dow) * 60;
    }, 0);

    // Subtract approved leave
    const approvedLeave = await app.prisma.leaveRequest.findMany({
      where: {
        employeeId,
        deletedAt: null, // required by soft-delete convention
        status: "APPROVED",
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
    });
    const leaveMinutes = approvedLeave.reduce((sum, lr) => {
      const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
      const leaveEnd = lr.endDate > monthEnd ? monthEnd : lr.endDate;
      if (leaveStart > leaveEnd) return sum;
      return sum + calcExpectedMinutesTz(schedule, leaveStart, leaveEnd, tz);
    }, 0);

    const netExpected = Math.max(0, expectedMinutes - holidayMinutes - leaveMinutes);
    const balanceMinutes = Math.round(workedMinutes - netExpected);
    const isTrackOnly = schedule.overtimeMode === "TRACK_ONLY";
    const carryOver = isTrackOnly ? 0 : runningCarryOver + balanceMinutes;

    // Update the snapshot
    await app.prisma.saldoSnapshot.update({
      where: { id: snapshot.id },
      data: {
        workedMinutes: Math.round(workedMinutes),
        expectedMinutes: Math.round(netExpected),
        balanceMinutes,
        carryOver,
      },
    });

    // Audit log with old/new values
    await app.audit({
      userId: undefined, // system-initiated recalculation
      action: "UPDATE",
      entity: "SaldoSnapshot",
      entityId: snapshot.id,
      oldValue: oldValues,
      newValue: {
        workedMinutes: Math.round(workedMinutes),
        expectedMinutes: Math.round(netExpected),
        balanceMinutes,
        carryOver,
        reason: "retroactive recalculation",
      },
    });

    runningCarryOver = carryOver;
  }

  // Update the OvertimeAccount with the final carry-over
  await app.prisma.overtimeAccount.upsert({
    where: { employeeId },
    create: { employeeId, balanceHours: runningCarryOver / 60 },
    update: { balanceHours: runningCarryOver / 60 },
  });
}
