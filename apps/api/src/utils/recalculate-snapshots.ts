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
  monthRangeUtc,
  monthDayBounds,
  calcExpectedMinutesTz,
  calcLeaveAbsenceMinutesTz,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
} from "./timezone";
import { getHolidays, STATE_MAP } from "./holidays";
import { getEffectiveBreakDuration } from "./break-effective";
import { getVocationalSchoolMinutesForDate } from "./vocational-school-saldo";
import { calcShiftBasedSaldo } from "./shift-based-saldo"; // Phase 76.22 — Model B + § 615

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

    // Derive the CANONICAL month range from the stored period instead of using
    // periodStart/periodEnd directly:
    //   - periodStart is convention-ambiguous (TZ-converted rows store the previous
    //     month's last day, e.g. 2026-05-31 for June/Berlin; legacy UTC-naive rows
    //     store the 1st). Iterating expected from the raw periodStart added ONE
    //     EXTRA Soll day for TZ-converted rows.
    //   - the mid-period instant is safely inside the month under BOTH conventions.
    const midMonth = new Date((snapshot.periodStart.getTime() + snapshot.periodEnd.getTime()) / 2);
    const { start: monthStart, end: monthEnd } = monthRangeUtc(
      midMonth.getUTCFullYear(),
      midMonth.getUTCMonth() + 1,
      tz,
    );
    const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
      monthStart,
      monthEnd,
      tz,
    );

    // Get the effective schedule for the middle of this month
    const schedule = await getEffectiveSchedule(app, employeeId, midMonth);
    const scheduleType = String(schedule.type ?? "");

    // Effective start: hire date or first day of month, whichever is later
    const hireDateNorm = employee.hireDate
      ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
      : null;
    const effectiveStart =
      hireDateNorm && hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

    // Calculate worked minutes for the month (day bounds — see monthDayBounds:
    // the raw periodStart included the previous month's boundary day for UTC+ tenants)
    const entries = await app.prisma.timeEntry.findMany({
      where: {
        employeeId,
        deletedAt: null,
        date: { gte: effectiveStart, lte: monthLastDay },
        endTime: { not: null },
        type: "WORK",
        isInvalid: false,
      },
    });

    const workedMinutes = entries.reduce((sum, e) => {
      if (!e.endTime) return sum;
      return sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes);
    }, 0);

    // ── Schedule-type-aware expected/holiday/leave/absence ─────────────────────
    // SHIFT_BASED: Model B + § 615 via calcShiftBasedSaldo (Phase 76.22).
    //   expectedMinutes = C_net (contract Ø-Methode − leave/absence credits + bsExpectedMinutes).
    //   balanceMinutes  = D-01 two-clause result via shiftBalanceOverride (not totalWorked−netExpected).
    // All other types: same subtraction chain as the manual close (overtime.ts) and
    // auto-close paths — including absences and BS-doubling (parity invariant: a
    // retroactive recalc of an unchanged month must reproduce the close's numbers).
    let expectedMinutes: number;
    let holidayMinutes: number;
    let leaveMinutes: number;
    let absenceMinutes = 0;
    // Phase 76.22: non-null only in SHIFT_BASED branch; replaces totalWorked−netExpected.
    let shiftBalanceOverride: number | null = null;
    // Phase-2 intermediates: stashed inside the SHIFT_BASED branch, consumed after the
    // bsExpectedMinutes block so the D-01 formula can fold in bsExpectedMinutes.
    let recalcCNetBeforeBS = 0; // pre-bs C_net (set in SHIFT_BASED branch)
    let recalcRoster = 0; // R = Σ netto shifts  (set in SHIFT_BASED branch)

    if (scheduleType === "SHIFT_BASED") {
      const shifts = await app.prisma.shift.findMany({
        where: {
          employeeId,
          date: { gte: effectiveStart, lte: monthLastDay },
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
      let shiftMinutes = 0; // R = Σ netto active shifts (deletedAt=null, coveredDates excluded)
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

      // Phase 76.22 — Model B + § 615: C_net pre-bs is computed here; bsExpectedMinutes
      // is folded in after the bs block below (two-phase approach: bs cannot be computed
      // inside the SHIFT_BASED branch because the bsAbsencesRecalc query follows this block).
      //
      // D-03 note: avgWorkMinutesCore denominator uses {day}Hours>0 count, which equals
      // workDays[].length for all valid post-Phase-61 rows (CLAUDE.md invariant).
      const recalcContractSoll = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);
      const recalcLeaveCredit = approvedLeave.reduce((sum, lr) => {
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
      const recalcAbsenceCredit = absences.reduce((sum, ab) => {
        // VOCATIONAL_SCHOOL + source=PATTERN excluded from credit loop (Phase 76.22 D-06).
        if (ab.type === "VOCATIONAL_SCHOOL" || ab.source === "PATTERN") return sum;
        const absStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
        const absEnd = ab.endDate > monthEnd ? monthEnd : ab.endDate;
        if (absStart > absEnd) return sum;
        return sum + calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz);
      }, 0);
      // Stash pre-bs C_net and R in the outer-scope lets so the phase-2 block (after
      // bsExpectedMinutes is computed) can fold bs into C_net and call calcShiftBasedSaldo.
      recalcCNetBeforeBS = Math.max(
        0,
        recalcContractSoll - recalcLeaveCredit - recalcAbsenceCredit,
      );
      recalcRoster = shiftMinutes;
      expectedMinutes = recalcCNetBeforeBS; // overwritten in phase 2 with final C_net + bsExpectedMinutes
      leaveMinutes = 0;
      holidayMinutes = 0;
      // shiftBalanceOverride remains null until phase 2 sets it post-bs.
    } else {
      expectedMinutes = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);

      // Subtract holidays: merge computed Feiertage + DB-stored manual holidays (bugfix: was DB-only)
      const snapStateCode = employee.tenant
        ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
        : "NI";
      // Year from MID-month — monthStart.getUTCFullYear() is the PREVIOUS year for
      // January in UTC+ timezones (2025-12-31T23:00Z), which silently skipped all
      // January holidays (Neujahr) in the recalc.
      const snapYear = midMonth.getUTCFullYear();
      const computedHolidays = getHolidays(snapYear, snapStateCode).filter(
        (h) => h.date >= dateStrInTz(effectiveStart, tz) && h.date <= dateStrInTz(monthEnd, tz),
      );
      const computedDateSet = new Set(computedHolidays.map((h) => h.date));
      const dbSnapHolidays = await app.prisma.publicHoliday.findMany({
        where: {
          tenant: { employees: { some: { id: employeeId } } },
          date: { gte: effectiveStart, lte: monthLastDay },
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

      // Subtract absences from expected — parity with the manual close (overtime.ts),
      // which subtracts ALL absence types (INCLUDING VOCATIONAL_SCHOOL + PATTERN);
      // together with the BS-doubling below this keeps BS days balance-neutral
      // (Phase 63 D-01). The former "no absence subtraction in recalc" scope (#192)
      // broke the invariant close == recalc: a retroactive recalc of an unchanged
      // month with absences produced a different balance than its original close.
      const recalcAbsences = await app.prisma.absence.findMany({
        where: {
          employeeId,
          deletedAt: null, // required by soft-delete convention
          startDate: { lte: monthEnd },
          endDate: { gte: effectiveStart },
        },
      });
      if (scheduleType !== "MONTHLY_HOURS") {
        absenceMinutes = recalcAbsences.reduce((sum, ab) => {
          const absStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
          const absEnd = ab.endDate > monthEnd ? monthEnd : ab.endDate;
          if (absStart > absEnd) return sum;
          return (
            sum +
            calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz, {
              excludeHolidays: holidayDateStrSet,
            })
          );
        }, 0);
      }

      // CLAUDE.md "Schedule Types": MONTHLY_HOURS — holiday/absence deductions do NOT apply.
      if (scheduleType === "MONTHLY_HOURS") {
        leaveMinutes = 0;
      }
    }

    // Phase 63 — Berufsschule (BS) doubling (parity with live, manual close and
    // auto-close): VOCATIONAL_SCHOOL absences add the same minutes to BOTH
    // workedMinutes AND expectedMinutes for Soll-bearing types (balance neutral);
    // MONTHLY_HOURS adds to workedMinutes only (D-04). Previously MISSING here,
    // so a recalc dropped the BS credit from the stored worked/expected values.
    const bsAbsencesRecalc = await app.prisma.absence.findMany({
      where: {
        employeeId,
        deletedAt: null, // CLAUDE.md soft-delete rule
        type: "VOCATIONAL_SCHOOL",
        startDate: { lte: monthEnd },
        endDate: { gte: effectiveStart },
      },
    });
    let bsWorkedMinutes = 0;
    let bsExpectedMinutes = 0;
    for (const ab of bsAbsencesRecalc) {
      const start = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
      const end = ab.endDate > monthEnd ? monthEnd : ab.endDate;
      const cur = new Date(start);
      while (cur <= end) {
        const bsMin = await getVocationalSchoolMinutesForDate(
          app.prisma,
          employeeId,
          cur,
          tenantConfig,
        );
        bsWorkedMinutes += bsMin;
        if (scheduleType !== "MONTHLY_HOURS") {
          bsExpectedMinutes += bsMin;
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }

    // Phase 76.22 — phase 2: now that bsExpectedMinutes is known, complete the
    // SHIFT_BASED C_net and call calcShiftBasedSaldo to get the D-01 balance.
    // shiftBalanceOverride was left null in phase 1; set it here.
    if (scheduleType === "SHIFT_BASED") {
      const finalCNet = recalcCNetBeforeBS + bsExpectedMinutes;
      const sbResult = calcShiftBasedSaldo({
        contractSollMinutes: finalCNet,
        rosterMinutes: recalcRoster,
        workedMinutes,
      });
      expectedMinutes = sbResult.expectedMinutes; // = finalCNet (stored in SaldoSnapshot — not R)
      shiftBalanceOverride = sbResult.balanceDelta + bsWorkedMinutes;
    }

    const totalWorked = workedMinutes + bsWorkedMinutes;
    const netExpected = Math.max(
      0,
      expectedMinutes + bsExpectedMinutes - holidayMinutes - leaveMinutes - absenceMinutes,
    );
    // Phase 76.22: SHIFT_BASED uses D-01 two-clause formula via shiftBalanceOverride.
    // Non-SHIFT branches keep the flat totalWorked − netExpected subtraction.
    const balanceMinutes =
      shiftBalanceOverride !== null
        ? Math.round(shiftBalanceOverride)
        : Math.round(totalWorked - netExpected);
    // TRACK_ONLY zeroes the carry-over only for MONTHLY_HOURS (parity with the
    // close paths, which gate on schedule type + overtimeMode).
    const isTrackOnly = scheduleType === "MONTHLY_HOURS" && schedule.overtimeMode === "TRACK_ONLY";
    const carryOver = isTrackOnly ? 0 : runningCarryOver + balanceMinutes;

    // COMP-V1814-04: supersede the old snapshot, then create a fresh active row.
    // Never update in-place — closed history is immutable (Revisionssicherheit).
    // CR-01: wrap both operations in a single transaction so a crash between them
    // cannot orphan the period (old superseded, new never created → carry-over gap).
    // Phase 76.22: SHIFT_BASED snapshot stores C_net (= expectedMinutes, set in phase 2
    // to calcShiftBasedSaldo.expectedMinutes). Non-SHIFT stores netExpected as before.
    const snapshotExpectedMinutes =
      shiftBalanceOverride !== null ? Math.round(expectedMinutes) : Math.round(netExpected);

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
          workedMinutes: Math.round(totalWorked),
          expectedMinutes: snapshotExpectedMinutes,
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
        workedMinutes: Math.round(totalWorked),
        expectedMinutes: snapshotExpectedMinutes,
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
