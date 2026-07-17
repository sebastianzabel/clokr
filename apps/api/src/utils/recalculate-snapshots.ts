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
  calcLeaveAbsenceMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "./timezone";
import { getHolidays, STATE_MAP } from "./holidays";
import { getEffectiveBreakDuration } from "./break-effective";

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
      superseded: false,
    },
    orderBy: { periodStart: "asc" },
  });

  if (snapshots.length === 0) return;

  const employee = await app.prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      tenantId: true,
      hireDate: true,
      isTimeTrackingExempt: true, // Phase 76.7 (D-06, SALDO-V19-04b)
      breakOver6hOverride: true, // SHIFT_BASED netto (parity with overtime.ts close-month)
      breakOver9hOverride: true,
      tenant: { select: { federalState: true } },
    },
  });
  if (!employee) return;
  // Phase 76.7 (D-06) — exempt employees never get snapshot recalcs.
  if (employee.isTimeTrackingExempt) return;

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
      superseded: false,
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
    const scheduleType = String(schedule.type ?? "");

    // ── Schedule-type-aware expected/holiday/leave ─────────────────────────────
    // SHIFT_BASED: Σ Shift durations skipping leave/absence-covered days; holiday
    // and leave subtractions stay at 0 (already excluded by the shift filter).
    // Note: absenceMinutes is intentionally NOT introduced here — scope of this
    // change mirrors the SHIFT_BASED branch only. Adding absence subtraction to
    // recalc is a separate ticket (out of scope to keep 260527-dsy scope clean).
    let expectedMinutes: number;
    let holidayMinutes: number;
    let leaveMinutes: number;

    if (scheduleType === "SHIFT_BASED") {
      const shifts = await app.prisma.shift.findMany({
        where: {
          employeeId,
          date: { gte: effectiveStart, lte: monthEnd },
          deletedAt: null, // Phase 67.2 — snapshot recalc ignores soft-deleted shifts
        },
        select: { date: true, startTime: true, endTime: true },
      });
      const approvedLeave = await app.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          deletedAt: null, // required by soft-delete convention
          status: "APPROVED",
          startDate: { lte: monthEnd },
          endDate: { gte: effectiveStart },
        },
      });
      const absences = await app.prisma.absence.findMany({
        where: {
          employeeId,
          deletedAt: null, // required by soft-delete convention
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
      // SHIFT_BASED netto: subtract the configured break from each shift's brutto
      // duration — parity with overtime.ts close-month (v1.8.9) and the live saldo
      // path in time-entries.ts. Without this the recalc stored BRUTTO expected
      // minutes, silently inflating the Soll by the break minutes per shift.
      const recalcEmpBreakShape = {
        breakOver6hOverride: employee.breakOver6hOverride ?? null,
        breakOver9hOverride: employee.breakOver9hOverride ?? null,
      };
      const recalcTenantBreakShape = {
        defaultBreakOver6h: tenantConfig?.defaultBreakOver6h ?? 30,
        defaultBreakOver9h: tenantConfig?.defaultBreakOver9h ?? 45,
      };
      let shiftMinutes = 0;
      for (const sh of shifts) {
        if (coveredDates.has(dateStrInTz(sh.date, tz))) continue;
        let brutto = hmToMin(sh.endTime) - hmToMin(sh.startTime);
        if (brutto < 0) brutto += 24 * 60; // cross-midnight (e.g. 22:00–06:00)
        if (brutto <= 0) continue;
        const breakMin = getEffectiveBreakDuration(
          recalcEmpBreakShape,
          recalcTenantBreakShape,
          brutto,
        );
        shiftMinutes += Math.max(0, brutto - breakMin);
      }
      expectedMinutes = shiftMinutes;
      leaveMinutes = 0;
      holidayMinutes = 0;
    } else {
      expectedMinutes = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);

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
      // D-06: holiday dates (tenant-TZ YYYY-MM-DD) so a holiday inside approved leave is
      // NOT double-deducted (holidayMinutes subtracts it separately). Identical to the
      // time-entries.ts + overtime.ts saldo paths.
      const holidayDateStrSet = new Set(allHolidays.map((h) => dateStrInTz(h.date, tz)));

      // MONTHLY_HOURS Feiertagsabzug (Phase 15 — TENANT-01)
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
      leaveMinutes = approvedLeave.reduce((sum, lr) => {
        const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
        const leaveEnd = lr.endDate > monthEnd ? monthEnd : lr.endDate;
        if (leaveStart > leaveEnd) return sum;
        // Phase 76.12 D-15 — Ø-Methode (BAG 9 AZR 406/17) honors lr.halfDay.
        return (
          sum +
          calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, tz, {
            halfDay: Boolean(lr.halfDay),
            excludeHolidays: holidayDateStrSet,
          })
        );
      }, 0);

      // CLAUDE.md "Schedule Types": MONTHLY_HOURS — holiday/absence deductions do NOT apply.
      // Note: this file does not currently subtract absences (v1.6.3 deliberately scoped
      // absence-subtraction out of recalculateSnapshots). We preserve that decision —
      // only leaveMinutes is gated here. (#192)
      // Phase 76.12 D-15 — this scope is RESPECTED: leave-only refactor in this file.
      if (scheduleType === "MONTHLY_HOURS") {
        leaveMinutes = 0;
      }
    }

    const netExpected = Math.max(0, expectedMinutes - holidayMinutes - leaveMinutes);
    const balanceMinutes = Math.round(workedMinutes - netExpected);
    const isTrackOnly = schedule.overtimeMode === "TRACK_ONLY";
    const carryOver = isTrackOnly ? 0 : runningCarryOver + balanceMinutes;

    // COMP-V1814-04: supersede the old snapshot, then create a fresh active row.
    // Never update in-place — closed history is immutable (Revisionssicherheit).
    // CR-01: wrap both operations in a single transaction so a crash between them
    // cannot orphan the period (old superseded, new never created → carry-over gap).
    await app.prisma.$transaction(async (tx) => {
      await tx.saldoSnapshot.update({
        where: { id: snapshot.id },
        data: { superseded: true, supersededReason: "retroactive recalculation" },
      });

      await tx.saldoSnapshot.create({
        data: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: snapshot.periodStart,
          periodEnd: snapshot.periodEnd,
          workedMinutes: Math.round(workedMinutes),
          expectedMinutes: Math.round(netExpected),
          balanceMinutes,
          carryOver,
          closedAt: snapshot.closedAt,
          closedBy: snapshot.closedBy,
          note: snapshot.note,
          // superseded defaults to false (new active row)
        },
      });
    });

    // Audit log with old/new values
    await app.audit({
      userId: undefined, // system-initiated recalculation
      action: "SUPERSEDE",
      entity: "SaldoSnapshot",
      entityId: snapshot.id,
      oldValue: oldValues,
      newValue: {
        workedMinutes: Math.round(workedMinutes),
        expectedMinutes: Math.round(netExpected),
        balanceMinutes,
        carryOver,
        superseded: true,
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
