/**
 * Retroactive snapshot recalculation.
 *
 * When saldo-relevant data changes (schedule, leave, holidays),
 * existing monthly snapshots must be recalculated so that carry-over
 * values stay consistent.
 *
 * Phase 76.26-05 — P3 retroactive recalc rewired to closeEmployeeMonth shared core.
 * The per-snapshot inline saldo block (old lines 85-459) is replaced by a
 * closeEmployeeMonth(input) call. The supersede-then-create $transaction, app.audit(),
 * locked-month immutability, and cross-month carryOver chaining are preserved.
 *
 * Four-path parity: manual (P1) + cron (P2) + recalc (P3) now all call
 * closeEmployeeMonth — byte-identical SaldoSnapshot values guaranteed.
 * Live path (P4, time-entries.ts) remains for SNAP-03 (76.27).
 */
import { FastifyInstance } from "fastify";
import { getEffectiveSchedule } from "../routes/time-entries";
import { getTenantTimezone, dateStrInTz, monthRangeUtc, monthDayBounds } from "./timezone";
import { getHolidays, STATE_MAP } from "./holidays";
import { closeEmployeeMonth } from "./close-employee-month"; // Phase 76.26 — shared pure saldo core
import { loadBsSlotOverrides } from "./load-bs-slot-overrides"; // Phase 76.31 — D-06 slot overrides

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
      exitDate: true, // CLOSE-04: needed by closeEmployeeMonth
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

    // ── Phase 76.26-05: assemble CloseMonthInput and call the shared pure core ──
    //
    // P3 retroactive recalc rewire: the inline saldo block (old lines 85-459) is replaced
    // by closeEmployeeMonth(input). effectiveStart is now computed inside the core
    // (max(hireDate, monthFirstDay) — TZ-normalized). The phase-2 bsExpectedMinutes fold
    // (old lines 404-437) is now owned by the core (no inline bsExpectedMinutes here).
    //
    // Pre-fetch pattern mirrors P1 (overtime.ts) and P2 (auto-close-month.ts) rewires
    // from Plans 03 and 04.

    // Build holiday set: merge computed German Feiertage + DB-stored manual holidays.
    // Year from MID-month — monthStart.getUTCFullYear() is the PREVIOUS year for
    // January in UTC+ timezones (2025-12-31T23:00Z), which silently skipped all
    // January holidays (Neujahr) in the recalc.
    const snapYear = midMonth.getUTCFullYear();
    const snapStateCode = employee.tenant
      ? (STATE_MAP[employee.tenant.federalState] ?? "NI")
      : "NI";

    // Effective start: hire date or first day of month, whichever is later — used for
    // the holiday filter to match the inline path's filter (byte-identical query range).
    const hireDateNorm = employee.hireDate
      ? new Date(dateStrInTz(employee.hireDate, tz) + "T00:00:00Z")
      : null;
    const effectiveStartForHolidayFilter =
      hireDateNorm && hireDateNorm > monthFirstDay ? hireDateNorm : monthFirstDay;

    const computedHolidays = getHolidays(snapYear, snapStateCode).filter(
      (h) =>
        h.date >= dateStrInTz(effectiveStartForHolidayFilter, tz) &&
        h.date <= dateStrInTz(monthEnd, tz),
    );
    const computedDateSet = new Set(computedHolidays.map((h) => h.date));
    const dbSnapHolidays = await app.prisma.publicHoliday.findMany({
      where: {
        tenant: { employees: { some: { id: employeeId } } },
        date: { gte: effectiveStartForHolidayFilter, lte: monthLastDay },
      },
    });
    const holidayDateStrings = new Set<string>([
      ...computedHolidays.map((h) => h.date),
      ...dbSnapHolidays
        .filter((h) => !computedDateSet.has(dateStrInTz(h.date, tz)))
        .map((h) => dateStrInTz(h.date, tz)),
    ]);

    // Pre-fetch all collections needed by closeEmployeeMonth (parallel for PERF).
    // SHIFT_BASED: shifts also fetched for non-SHIFT; core ignores them for non-SHIFT types.
    const [closeEntries, closeShifts, closeApprovedLeave, closeAbsences] = await Promise.all([
      // WORK entries (effectiveStart..monthLastDay, soft-delete + isInvalid filter)
      app.prisma.timeEntry.findMany({
        where: {
          employeeId,
          deletedAt: null,
          date: { gte: effectiveStartForHolidayFilter, lte: monthLastDay },
          endTime: { not: null },
          type: "WORK",
          isInvalid: false,
        },
        select: { date: true, startTime: true, endTime: true, breakMinutes: true },
      }),
      // Shifts (SHIFT_BASED — soft-deleted shifts excluded, Phase 67.2)
      app.prisma.shift.findMany({
        where: {
          employeeId,
          date: { gte: effectiveStartForHolidayFilter, lte: monthLastDay },
          deletedAt: null,
        },
        select: { date: true, startTime: true, endTime: true },
      }),
      // Approved leave
      app.prisma.leaveRequest.findMany({
        where: {
          employeeId,
          deletedAt: null, // required by soft-delete convention
          status: "APPROVED",
          startDate: { lte: monthEnd },
          endDate: { gte: monthStart },
        },
        select: { startDate: true, endDate: true, halfDay: true },
      }),
      // All absences (including VOCATIONAL_SCHOOL — BS-doubling handled in closeEmployeeMonth core).
      // Phase 63: const bsAbsences = await app.prisma.absence.findMany (type:"VOCATIONAL_SCHOOL")
      // is now inside closeEmployeeMonth via the full absences array (all types included).
      app.prisma.absence.findMany({
        where: {
          employeeId,
          deletedAt: null, // required by soft-delete convention
          startDate: { lte: monthEnd },
          endDate: { gte: effectiveStartForHolidayFilter },
        },
        select: {
          startDate: true,
          endDate: true,
          type: true,
          source: true,
          halfDay: true,
          // Phase 76.38 (D-11) — per-day Unterrichtszeit for duration-based BS slot.
          unterrichtsMinutes: true,
        },
      }),
    ]);

    // ── Call the shared pure saldo core ──────────────────────────────────────
    // carryOverIn = runningCarryOver from the previous snapshot in this iteration chain
    // (or the pre-existing prevSnapshot carryOver for the first snapshot — initialized above).
    // carryOverOut is threaded back into runningCarryOver after the $transaction.
    //
    // Phase 76.26-05 D-01: Phase-2 bsExpectedMinutes fold (old :404-437) is now
    // handled inside closeEmployeeMonth — REMOVED from the caller.
    //
    // Phase 76.31 (D-06): load Employee + active-Pattern bsSlot* overrides so the
    // recompute honors per-MA / per-pattern slot amounts (null → fallback).
    const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
      await loadBsSlotOverrides(app.prisma, employeeId, monthFirstDay);

    const r = closeEmployeeMonth({
      employeeId,
      monthStart,
      monthEnd,
      monthFirstDay,
      monthLastDay,
      tz,
      carryOverIn: runningCarryOver,
      schedule: schedule as Record<string, unknown>,
      hireDate: employee.hireDate,
      exitDate: employee.exitDate ?? null,
      isTimeTrackingExempt: false, // already short-circuited above via employee.isTimeTrackingExempt
      breakOver6hOverride: employee.breakOver6hOverride ?? null,
      breakOver9hOverride: employee.breakOver9hOverride ?? null,
      entries: closeEntries.map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime!,
        breakMinutes: e.breakMinutes,
      })),
      shifts: closeShifts.map((sh) => ({
        date: sh.date,
        startTime: sh.startTime,
        endTime: sh.endTime,
      })),
      approvedLeave: closeApprovedLeave.map((lr) => ({
        startDate: lr.startDate,
        endDate: lr.endDate,
        halfDay: Boolean(lr.halfDay),
      })),
      // Phase 76.12 D-14: halfDay: Boolean(lr.halfDay) and calcLeaveAbsenceMinutesTz
      // are now inside closeEmployeeMonth; the mapping above preserves the halfDay field.
      // Phase 76.32.1 (Wave 4): halfDay: ab.halfDay threaded through absence mapper.
      absences: closeAbsences.map((ab) => ({
        startDate: ab.startDate,
        endDate: ab.endDate,
        type: ab.type,
        source: ab.source,
        halfDay: ab.halfDay,
        unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
      })),
      holidayDateStrings,
      tenantConfig: tenantConfig
        ? {
            defaultBreakOver6h: tenantConfig.defaultBreakOver6h,
            defaultBreakOver9h: tenantConfig.defaultBreakOver9h,
            monthlyHoursHolidayDeduction: tenantConfig.monthlyHoursHolidayDeduction ?? undefined,
            vocationalSchoolMinutesPerDay: tenantConfig.vocationalSchoolMinutesPerDay ?? undefined,
            vocationalSchoolBlockMinutesPerWeek:
              tenantConfig.vocationalSchoolBlockMinutesPerWeek ?? undefined,
            // Phase 76.31 (D-06) — TenantConfig slot layer.
            bsSlotFirstLongDayMinutes: tenantConfig.bsSlotFirstLongDayMinutes ?? undefined,
            bsSlotSecondLongDayMinutes: tenantConfig.bsSlotSecondLongDayMinutes ?? undefined,
            bsSlotShortDayMinutes: tenantConfig.bsSlotShortDayMinutes ?? undefined,
            bsSlotBlockWeekMinutes: tenantConfig.bsSlotBlockWeekMinutes ?? undefined,
          }
        : null,
      // Phase 76.31 (D-06) — Employee/Pattern slot layers (null → fallback).
      employeeSlots,
      patternSlots,
      // Phase 76.38 (D-11) — Pattern per-DOW Unterrichtszeit fallback.
      patternUnterrichtsMinutenByDow,
    });

    const { workedMinutes, balanceMinutes, effectiveCarryOverOut, snapshotExpectedMinutes } = r;
    const carryOver = effectiveCarryOverOut;

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
          workedMinutes,
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
        workedMinutes,
        expectedMinutes: snapshotExpectedMinutes,
        balanceMinutes,
        carryOver,
        superseded: true,
        reason: "retroactive recalculation",
      },
    });

    // Thread carryOver chain: each month's carryOverIn = prior month's effectiveCarryOverOut.
    runningCarryOver = effectiveCarryOverOut;
  }

  // Update the OvertimeAccount with the final carry-over.
  // Note: P3 upsert is OUTSIDE the per-snapshot $tx (existing behaviour per RESEARCH §2 last row —
  // preserved intentionally; do NOT change atomicity in this phase).
  await app.prisma.overtimeAccount.upsert({
    where: { employeeId },
    create: { employeeId, balanceHours: runningCarryOver / 60 },
    update: { balanceHours: runningCarryOver / 60 },
  });
}
