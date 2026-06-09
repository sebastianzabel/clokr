/**
 * Phase 76.12 Plan 03 — Pure (read-only) recompute of SaldoSnapshot numbers.
 *
 * Mirrors the math from `recalculateSnapshots()` in this directory but
 * never writes. The ops script (apps/api/scripts/recalculate-snapshots-
 * after-soll-fix.ts) calls this to compute the post-Ø-Methode values and
 * compare them against the stored ones, so it can decide whether to write
 * + audit-log (D-20 idempotency / noop detection).
 *
 * Keeping the recompute as a separate exported function avoids touching
 * `recalculateSnapshots()` itself (Plan 02 file) — additive-only change.
 *
 * Takes a PrismaClient directly (not a FastifyInstance) so it can be
 * used from the script context where Fastify is not bootstrapped.
 */
import type { PrismaClient } from "@clokr/db";
import {
  getTenantTimezone,
  dateStrInTz,
  calcExpectedMinutesTz,
  calcLeaveAbsenceMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "./timezone";
import { getHolidays, STATE_MAP } from "./holidays";

export type RecomputedSnapshotValues = {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
};

export type SnapshotRow = {
  id: string;
  employeeId: string;
  periodStart: Date;
  periodEnd: Date;
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
};

/**
 * Resolve the effective WorkSchedule for an employee at a given date.
 * Falls back to TenantConfig defaults when no row covers the date.
 */
async function getEffectiveScheduleForDate(
  prisma: PrismaClient,
  employeeId: string,
  forDate: Date,
): Promise<Record<string, unknown>> {
  const schedule = await prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: forDate } },
    orderBy: { validFrom: "desc" },
  });
  if (schedule) return schedule as unknown as Record<string, unknown>;

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const tenantConfig = employee
    ? await prisma.tenantConfig.findUnique({ where: { tenantId: employee.tenantId } })
    : null;

  return {
    type: "FIXED_SCHEDULE",
    weeklyHours: tenantConfig?.defaultWeeklyHours ?? 40,
    monthlyHours: null,
    mondayHours: tenantConfig?.defaultMondayHours ?? 8,
    tuesdayHours: tenantConfig?.defaultTuesdayHours ?? 8,
    wednesdayHours: tenantConfig?.defaultWednesdayHours ?? 8,
    thursdayHours: tenantConfig?.defaultThursdayHours ?? 8,
    fridayHours: tenantConfig?.defaultFridayHours ?? 8,
    saturdayHours: tenantConfig?.defaultSaturdayHours ?? 0,
    sundayHours: tenantConfig?.defaultSundayHours ?? 0,
    overtimeThreshold: tenantConfig?.overtimeThreshold ?? 60,
    allowOvertimePayout: tenantConfig?.allowOvertimePayout ?? false,
    overtimeMode: "CARRY_FORWARD",
  };
}

/**
 * Pure recompute. Returns post-Ø-Methode workedMinutes / expectedMinutes /
 * balanceMinutes / carryOver for the given snapshot. Never writes.
 *
 * `priorCarryOver` is the carryOver from the snapshot immediately before this
 * one (chronologically, same employee). For the first snapshot, pass 0.
 */
export async function recomputeSnapshotValues(
  prisma: PrismaClient,
  snapshot: SnapshotRow,
  priorCarryOver: number,
): Promise<RecomputedSnapshotValues> {
  const employee = await prisma.employee.findUnique({
    where: { id: snapshot.employeeId },
    select: {
      tenantId: true,
      hireDate: true,
      isTimeTrackingExempt: true,
      tenant: { select: { federalState: true } },
    },
  });
  if (!employee) {
    return {
      workedMinutes: snapshot.workedMinutes,
      expectedMinutes: snapshot.expectedMinutes,
      balanceMinutes: snapshot.balanceMinutes,
      carryOver: snapshot.carryOver,
    };
  }
  // Phase 76.7 D-06 — exempt employees never get snapshot recalcs. Return
  // the stored values so the comparison flags it as noop (no audit row).
  if (employee.isTimeTrackingExempt) {
    return {
      workedMinutes: snapshot.workedMinutes,
      expectedMinutes: snapshot.expectedMinutes,
      balanceMinutes: snapshot.balanceMinutes,
      carryOver: snapshot.carryOver,
    };
  }

  const tz = await getTenantTimezone(prisma, employee.tenantId);
  const tenantConfig = await prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
  });

  const monthStart = snapshot.periodStart;
  const monthEnd = snapshot.periodEnd;
  const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
  const schedule = await getEffectiveScheduleForDate(prisma, snapshot.employeeId, midMonth);

  // ── workedMinutes ─────────────────────────────────────────────────────
  const entries = await prisma.timeEntry.findMany({
    where: {
      employeeId: snapshot.employeeId,
      deletedAt: null,
      date: { gte: monthStart, lte: monthEnd },
      endTime: { not: null },
      type: "WORK",
      isInvalid: false,
    },
  });

  const workedMinutesRaw = entries.reduce((sum, e) => {
    if (!e.endTime) return sum;
    return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
  }, 0);

  // ── expectedMinutes ───────────────────────────────────────────────────
  const hireDateNorm = employee.hireDate
    ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
    : null;
  const effectiveStart = hireDateNorm && hireDateNorm > monthStart ? hireDateNorm : monthStart;
  const scheduleType = String(schedule.type ?? "");

  let expectedMinutes: number;
  let holidayMinutes: number;
  let leaveMinutes: number;

  if (scheduleType === "SHIFT_BASED") {
    const shifts = await prisma.shift.findMany({
      where: {
        employeeId: snapshot.employeeId,
        date: { gte: effectiveStart, lte: monthEnd },
        deletedAt: null,
      },
      select: { date: true, startTime: true, endTime: true },
    });
    const approvedLeave = await prisma.leaveRequest.findMany({
      where: {
        employeeId: snapshot.employeeId,
        deletedAt: null,
        status: "APPROVED",
        startDate: { lte: monthEnd },
        endDate: { gte: effectiveStart },
      },
    });
    const absences = await prisma.absence.findMany({
      where: {
        employeeId: snapshot.employeeId,
        deletedAt: null,
        startDate: { lte: monthEnd },
        endDate: { gte: effectiveStart },
      },
    });

    const coveredDates = new Set<string>();
    const addRange = (s: Date, e: Date) => {
      const cur = new Date(dateStrInTz(s, tz) + "T00:00:00Z");
      const end = new Date(dateStrInTz(e, tz) + "T00:00:00Z");
      while (cur <= end) {
        coveredDates.add(dateStrInTz(cur, tz));
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    };
    for (const lr of approvedLeave) {
      const s = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
      const e = lr.endDate > monthEnd ? monthEnd : lr.endDate;
      if (s <= e) addRange(s, e);
    }
    for (const ab of absences) {
      const s = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
      const e = ab.endDate > monthEnd ? monthEnd : ab.endDate;
      if (s <= e) addRange(s, e);
    }
    const hmToMin = (hm: string) => {
      const [h, m] = hm.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };
    let shiftMinutes = 0;
    for (const sh of shifts) {
      if (coveredDates.has(dateStrInTz(sh.date, tz))) continue;
      const dur = hmToMin(sh.endTime) - hmToMin(sh.startTime);
      if (dur > 0) shiftMinutes += dur;
    }
    expectedMinutes = shiftMinutes;
    leaveMinutes = 0;
    holidayMinutes = 0;
  } else {
    expectedMinutes = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);

    const snapStateCode = employee.tenant
      ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
      : "NI";
    const snapYear = monthStart.getUTCFullYear();
    const computedHolidays = getHolidays(snapYear, snapStateCode).filter(
      (h) => h.date >= dateStrInTz(effectiveStart, tz) && h.date <= dateStrInTz(monthEnd, tz),
    );
    const computedDateSet = new Set(computedHolidays.map((h) => h.date));
    const dbSnapHolidays = await prisma.publicHoliday.findMany({
      where: {
        tenant: { employees: { some: { id: snapshot.employeeId } } },
        date: { gte: effectiveStart, lte: monthEnd },
      },
    });
    const allHolidays: { date: Date }[] = [
      ...computedHolidays.map((h) => ({ date: new Date(h.date + "T00:00:00Z") })),
      ...dbSnapHolidays
        .filter((h) => !computedDateSet.has(dateStrInTz(h.date, tz)))
        .map((h) => ({ date: h.date })),
    ];

    const isMonthlyHoursDeduction =
      scheduleType === "MONTHLY_HOURS" &&
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

    holidayMinutes = allHolidays.reduce((sum, h) => {
      const dow = getDayOfWeekInTz(h.date, tz);
      if (isMonthlyHoursDeduction) {
        return getDayHoursFromSchedule(schedule, dow) > 0 ? sum + dailySollMin : sum;
      }
      return sum + getDayHoursFromSchedule(schedule, dow) * 60;
    }, 0);

    const approvedLeave = await prisma.leaveRequest.findMany({
      where: {
        employeeId: snapshot.employeeId,
        deletedAt: null,
        status: "APPROVED",
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
    });
    leaveMinutes = approvedLeave.reduce((sum, lr) => {
      const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
      const leaveEnd = lr.endDate > monthEnd ? monthEnd : lr.endDate;
      if (leaveStart > leaveEnd) return sum;
      return (
        sum +
        calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, tz, {
          halfDay: Boolean(lr.halfDay),
        })
      );
    }, 0);

    // CLAUDE.md "Schedule Types": MONTHLY_HOURS — holiday/absence deductions
    // do NOT apply (flexible Minijobber budget). Matches recalculateSnapshots()
    // and Phase 76.12 D-15.
    if (scheduleType === "MONTHLY_HOURS") {
      leaveMinutes = 0;
    }
  }

  const netExpected = Math.max(0, expectedMinutes - holidayMinutes - leaveMinutes);
  const balanceMinutes = Math.round(workedMinutesRaw - netExpected);
  const isTrackOnly = String(schedule.overtimeMode ?? "") === "TRACK_ONLY";
  const carryOver = isTrackOnly ? 0 : priorCarryOver + balanceMinutes;

  return {
    workedMinutes: Math.round(workedMinutesRaw),
    expectedMinutes: Math.round(netExpected),
    balanceMinutes,
    carryOver,
  };
}
