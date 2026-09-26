import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { monthRangeUtc, monthDayBounds, dateStrInTz } from "../timezone";
import {
  holidaysAtWorkLocation, // Phase 71b (issue #71) — work-location resolution
  userIdsHoldingPermission, // Phase 75b Plan 10 (#75), D-16
  resolveScopedHolderIds, // Phase 91b Plan 09 (#91), D-17
  isStammsalonScopeMatch, // Phase 91b Plan 09 (#91), D-10/D-17
} from "../../platform";
import { periodStartWindow } from "../snapshot-period";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../../../utils/with-advisory-lock";
import { closeEmployeeMonth, toCloseMonthApprovedLeave } from "../close-employee-month"; // Phase 76.26 — shared pure saldo core
import { detectMonthGaps } from "../month-gap-check"; // Phase 292 (#292) — the shared gap definition
import {
  MONTH_CLOSE_DEFERRAL_RELATED_TYPE,
  blockedSetFingerprint,
  monthCloseDeepLink,
  monthLabelDe,
  oldestMonth,
} from "../month-close-notification"; // Phase 292 (#292) — shared naming/linking/dedup
import {
  DEFAULT_RETRO_ENTRY_WINDOW_DAYS,
  buildMonthRange,
  computeFirstOpenMonth,
  computePrevMonthInLoop,
  isMonthPastItsWindow,
} from "../month-close-window"; // Phase 292 (#292) — shared with deferred-month-close.ts
import { getCarryOverBase } from "../carry-over-base"; // Phase 99 (OB-02) — shared chain-head seed
import { getShiftsInRange } from "../../scheduling"; // Phase 100B Plan 05 — S1
import {
  getValidWorkedEntriesInRange,
  getWorkedEntriesInRange, // Phase 71b (issue #71) — T2, fed into the holiday resolver
  lockEntriesForMonth,
  getEffectiveSchedule,
  findUnconfirmedBreakDays, // Phase 92 Plan 04 — BREAK-05 single source of truth
} from "../../time-tracking"; // Phase 100B Plan 08 — T1/T7; Phase 101B wave 8 merged in
import {
  getAbsencesOverlapping, // Phase 100B Plan 12 — A4
  getApprovedLeaveOverlapping, // Phase 100B Plan 13 — A1
  loadBsSlotOverrides, // Phase 76.31 — D-06 slot overrides
} from "../../absence"; // Phase 101B (Issue #101, wave 7) — merged from two deep imports

declare module "fastify" {
  interface FastifyInstance {
    tryAutoCloseMonth: () => Promise<void>;
  }
}

/**
 * Auto-Monatsabschluss: runs daily at 06:00.
 *
 * For each tenant, closes ALL unclosed prior months for each active employee via a
 * bounded backward backfill loop (SNAP-02 / Phase 76.27):
 *   1. Find the employee's last active snapshot → compute first open month.
 *   2. Iterate oldest→newest [firstOpen .. prevMonth]:
 *      a. If month has an active (superseded=false) snapshot → skip + thread carryOver.
 *         This idempotency check also preserves bridge/zero opening snapshots (Pitfall B3).
 *      b. If month is gap-FREE → close immediately (no day-N wait).
 *      c. If month has gaps:
 *         - Within window (today < day N of M+1, N=retroEntryWindowDays) → DEFER (F-02 BREAK + notify).
 *           Do NOT continue past a gap — closing later months on stale carryOver corrupts the chain.
 *         - At/after day N AND closeMonthWithGapsAllowed=true → force-close (gaps=0h).
 *         - At/after day N AND closeMonthWithGapsAllowed=false → DEFER forever (manual-only).
 *      d. Otherwise → close via closeEmployeeMonth(), write snapshot + audit.
 *   3. Sends notifications about remaining gaps.
 *
 * Cross-year (Dec→Jan): handled via computePrevMonthInLoop (month=1 → month=12, year-1).
 * carryOver base: always the IMMEDIATELY preceding month's active snapshot (periodStartWindow
 * + superseded=false — never orderBy:desc which could pick a stale far-earlier row; Pitfall B2).
 *
 * Phase 76.29 Plan 04 (Variante A — Tag-N-Fenster):
 *   Supersedes the hardcoded DEFAULT_CLOSE_AFTER_DAY=15 outer grace guard.
 *   Gap-free months close whenever processed (no day-N wait).
 *   Gap months defer while employees can self-service; force-close on/after day N of M+1.
 */
export const autoCloseMonthPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  // ── Month-step helpers ────────────────────────────────────────────────────────
  //
  // Phase 292 (GitHub issue #292): `computePrevMonthInLoop`, `buildMonthRange`,
  // `computeFirstOpenMonth` and `isMonthPastItsWindow` moved to `../month-close-window.ts`.
  // They are now shared with `../deferred-month-close.ts`, which has to decide which months are
  // past their window using EXACTLY this arithmetic — a second derivation would report a
  // deferral this loop does not have, or miss one it does.

  async function tryAutoCloseMonth() {
    const now = new Date();

    app.log.info("Auto-Monatsabschluss: Prüfe Vormonat");

    const tenants = await app.prisma.tenant.findMany({
      include: { config: true },
    });

    for (const tenant of tenants) {
      try {
        const tz = tenant.config?.timezone ?? "Europe/Berlin";

        // Calculate previous month (the CEILING of the backfill range — never close the current month)
        const zonedNow = new Date(dateStrInTz(now, tz) + "T12:00:00Z");
        let prevYear = zonedNow.getUTCFullYear();
        let prevMonth = zonedNow.getUTCMonth(); // 0-based, so this IS previous month (1-based)
        if (prevMonth === 0) {
          prevMonth = 12;
          prevYear -= 1;
        }

        const { start: prevMonthStart, end: prevMonthEnd } = monthRangeUtc(prevYear, prevMonth, tz);

        // Get all active employees
        const employees = await app.prisma.employee.findMany({
          where: {
            tenantId: tenant.id,
            user: { isActive: true },
            isTimeTrackingExempt: false, // D-02: §18 ArbZG-exempt employees are not snapshotted (parity with manual close)
          },
          include: {
            user: true,
            workSchedules: { orderBy: { validFrom: "desc" } },
          },
        });

        // Get managers for notifications.
        //
        // Phase 292 (GitHub issue #292): this used to be `employees.filter(role is ADMIN/MANAGER)`
        // — and `employees` above is filtered by `isTimeTrackingExempt: false`, because that is
        // the right filter for deciding WHOSE month to close. It is the wrong filter for deciding
        // WHO to tell. A § 18 ArbZG-exempt owner or manager — the normal shape for the person who
        // actually runs the Monatsabschluss — was silently not a recipient, so on such a tenant
        // the "Monatsabschluss nicht möglich" notification was written for nobody at all. Measured
        // while building the test fixture for #292: with an exempt ADMIN as the only manager, zero
        // notifications were created. Recipients are therefore selected by PERMISSION only
        // (Phase 75b Plan 10, #75, D-16: holders of month-close:close — the recorded recipient
        // set is unchanged), never by `isTimeTrackingExempt`.
        const monthCloseCloseHolderIds = await userIdsHoldingPermission(
          app.prisma,
          tenant.id,
          "month-close:close:ZUGEWIESEN",
        );
        // Phase 91b Plan 09 (Issue #91), D-17: `managers` is resolved (and narrowed) further
        // below, once `missing` — the tenant-wide list of gap-blocked employees this run's
        // notification is actually about — is known; narrowing needs that list as its Stichtag
        // source (see the block below `if (missing.length > 0)`).

        const missing: {
          employee: (typeof employees)[0];
          missingDates: string[];
          month: number;
          year: number;
        }[] = [];

        // ── SNAP-02 / Phase 76.27: Bounded backward backfill loop ─────────────────
        // Replaces the single-month sequential guard (which was :138-170).
        // For each employee, close ALL unclosed prior months oldest→newest.
        // The loop bounds are: [max(hireMonth, lastSnapshot+1) .. prevMonth].
        // carryOver base for each month = immediately-preceding month's active snapshot
        // (periodStartWindow + superseded:false, NOT orderBy:desc — Pitfall B2).
        // Bridge/zero opening snapshots are preserved: idempotency skip (Pitfall B3).
        // Gap-blocked month → BREAK (F-02): never close later months on stale carryOver.

        for (const emp of employees) {
          try {
            // Find the newest active snapshot to determine where backfill starts.
            // orderBy:desc IS correct here (finding the most recent closed month, not the carryOver base).
            const lastSnap = await app.prisma.saldoSnapshot.findFirst({
              where: {
                employeeId: emp.id,
                periodType: "MONTHLY",
                superseded: false, // Pitfall B5: always filter superseded=false
              },
              orderBy: { periodStart: "desc" },
            });

            // Skip employees hired after the ceiling month
            if (emp.hireDate > prevMonthEnd) continue;

            // Compute the first open month = max(hireMonth, lastSnapshot+1)
            const firstOpen = computeFirstOpenMonth(emp.hireDate, lastSnap, tz);

            // Build the ordered range [firstOpen .. prevMonth]
            const monthsToClose = buildMonthRange(firstOpen, { year: prevYear, month: prevMonth });

            // Thread carryOver through the loop: seeded from the lastSnap before the loop starts.
            // Will be updated as each month is closed or idempotency-skipped.
            //
            // Phase 99 (OB-02) — TRUE head-of-chain seed. `lastSnap === null` means this employee
            // has never had any snapshot at all, which is exactly where an OpeningBalance applies.
            let carryOverIn = await getCarryOverBase(app.prisma, emp.id, lastSnap);

            // ⚠️ The three later `carryOverIn = ...` reassignments in this loop are mid-chain
            // thread-forwards of already-resolved stored values. They MUST NOT route through
            // the shared chain-head-seed helper above — doing so would re-apply the opening
            // balance mid-chain. (Structural guard: auto-close-month.test.ts asserts the helper
            // call appears exactly once in this file.)
            for (const monthKey of monthsToClose) {
              const { start: monthStart, end: monthEnd } = monthRangeUtc(
                monthKey.year,
                monthKey.month,
                tz,
              );
              const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
                monthStart,
                monthEnd,
                tz,
              );

              // ── Idempotency check ──────────────────────────────────────────────
              // If this month already has an active (superseded=false) snapshot, skip it
              // and thread its carryOver to the next month. This preserves bridge/zero
              // opening balance snapshots (Pitfall B3) — they ARE active snapshots and
              // this check naturally skips them without any balanceMinutes==0 heuristic.
              // SNAP-04: bridge snapshots MUST NOT be superseded; the sole guard is this check.
              const existingSnap = await app.prisma.saldoSnapshot.findFirst({
                where: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: periodStartWindow(monthStart), // convention-robust (B5)
                  superseded: false, // Pitfall B5: always filter superseded=false
                },
              });
              if (existingSnap) {
                // Skip — thread existing snapshot's carryOver as the next month's base.
                carryOverIn = existingSnap.carryOver;
                continue;
              }

              // Skip months that started after the employee's hire date check
              if (emp.hireDate > monthEnd) continue;

              // ── Per-month gap readiness check ──────────────────────────────────
              // Phase 292 (GitHub issue #292): the fetch + findMissingWorkdays body moved to
              // `../month-gap-check.ts`. `detectMonthGaps()` is now the ONE definition of "gap"
              // that this loop and the deferral escalation (`../deferred-month-close.ts`) share —
              // see its docblock for what counts, in particular that an entry without a clock-out
              // is NOT an entry here and its day therefore IS a gap.
              const scheduleForMonth = emp.workSchedules.find((ws) => ws.validFrom <= monthEnd);

              if (scheduleForMonth) {
                const gapCheck = await detectMonthGaps(app.prisma, {
                  tenantId: tenant.id,
                  employeeId: emp.id,
                  hireDate: emp.hireDate,
                  schedule: scheduleForMonth as unknown as Record<string, unknown>,
                  month: monthKey,
                  tz,
                });

                // gapRuleApplies === false for MONTHLY_HOURS / FLEXTIME (D-01) — such an
                // employee can never be gap-blocked, whatever their entries look like.
                if (gapCheck.gapRuleApplies) {
                  const missingDates = gapCheck.gapDates;

                  if (missingDates.length > 0) {
                    // Phase 76.29 Plan 04 — Variante A (Tag-N-Fenster):
                    // Read real typed TenantConfig fields (column added by Plan 01).
                    const retroWindowDays =
                      tenant.config?.retroEntryWindowDays ?? DEFAULT_RETRO_ENTRY_WINDOW_DAYS;
                    const closeAllowed = tenant.config?.closeMonthWithGapsAllowed ?? true;
                    const pastWindow = isMonthPastItsWindow(
                      monthKey.year,
                      monthKey.month,
                      tz,
                      retroWindowDays,
                      now,
                    );

                    if (!pastWindow) {
                      // Within the retro self-service window (today < day N of M+1).
                      // Defer: BREAK + notify. Do NOT close later months on stale carryOver.
                      app.log.warn(
                        { employeeId: emp.id, month: monthKey.month, year: monthKey.year },
                        `Auto-Monatsabschluss: Lücken in ${monthKey.month}/${monthKey.year} — innerhalb Selbstbearbeitungsfenster (Tag ${retroWindowDays}), verschoben`,
                      );
                      missing.push({
                        employee: emp,
                        missingDates,
                        month: monthKey.month,
                        year: monthKey.year,
                      });
                      break; // F-02: defer while in-window
                    }

                    if (!closeAllowed) {
                      // Past window but flag=false → defer forever (manual-only, never auto-finalize).
                      app.log.warn(
                        { employeeId: emp.id, month: monthKey.month, year: monthKey.year },
                        `Auto-Monatsabschluss: Lücken nach Fenster-Ende — closeMonthWithGapsAllowed=false, verschoben (manuell)`,
                      );
                      missing.push({
                        employee: emp,
                        missingDates,
                        month: monthKey.month,
                        year: monthKey.year,
                      });
                      break; // defer forever
                    }
                    // pastWindow && closeAllowed → fall through to force-close (gaps=0h)
                  }
                }
              }

              // Phase 104 (D-21): a Karenztage-Überschreitung has NO analogue here — see
              // overtime.ts's GET /close-month/status wiring for the (hint-only) equivalent.
              // No `break`, nothing pushed to `missing` — the month closes regardless.

              // ── BREAK-05: unconfirmed-break defer (mirrors the gap-defer above) ──
              // Only runs when the tenant explicitly opted into the hard block. The
              // master gate (enforceBreakConfirmation) is inherited from
              // findUnconfirmedBreakDays — it returns [] for an un-opted tenant, so no
              // silent behavior change ever occurs (BREAK-05 Gesamt-Opt-in, CLAUDE.md).
              if (tenant.config?.blockMonthCloseOnUnconfirmedBreak) {
                const breakScheduleType = scheduleForMonth ? String(scheduleForMonth.type) : "";
                const unconfirmedBreakDays = await findUnconfirmedBreakDays(app.prisma, {
                  employeeId: emp.id,
                  monthFirstDay,
                  monthLastDay,
                  tz,
                  scheduleType: breakScheduleType,
                  enforceBreakConfirmation: tenant.config?.enforceBreakConfirmation ?? false,
                });

                if (unconfirmedBreakDays.length > 0) {
                  app.log.warn(
                    { employeeId: emp.id, month: monthKey.month, year: monthKey.year },
                    "Auto-Monatsabschluss: unbestätigte Pflichtpausen — verschoben (manuell)",
                  );
                  missing.push({
                    employee: emp,
                    missingDates: unconfirmedBreakDays,
                    month: monthKey.month,
                    year: monthKey.year,
                  });
                  break; // defer — never auto-finalize over unconfirmed breaks (F-02/B2 parity)
                }
              }

              // ── Close this month ───────────────────────────────────────────────
              // Pre-fetch the carryOver base from the IMMEDIATELY preceding month
              // (Pitfall B2 — NOT orderBy:desc which could pick a far-earlier snapshot).
              const prevMonthKeyInLoop = computePrevMonthInLoop(monthKey.month, monthKey.year);
              const { start: prevMonthStartInLoop } = monthRangeUtc(
                prevMonthKeyInLoop.year,
                prevMonthKeyInLoop.month,
                tz,
              );
              const prevSnapForCarryOver = await app.prisma.saldoSnapshot.findFirst({
                where: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: periodStartWindow(prevMonthStartInLoop), // immediately-preceding month
                  superseded: false, // Pitfall B5: always filter superseded=false
                },
                // NO orderBy here — periodStartWindow narrows to exactly one month
              });
              // Use the immediately-preceding snapshot's carryOver if available,
              // otherwise fall back to the threaded carryOverIn (which may differ if
              // the prev snapshot was just created in this same loop iteration).
              // The threaded carryOverIn is equally correct since it was set to
              // effectiveCarryOverOut of the previously closed month.
              if (prevSnapForCarryOver) {
                carryOverIn = prevSnapForCarryOver.carryOver;
              }
              // (else: carryOverIn remains the threaded value from the prior iteration)

              // ── Schedule valid FOR this month (historical schedule awareness) ──
              const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
              const schedule = await getEffectiveSchedule(app, emp.id, midMonth);

              // Build holiday set for this month
              const empHireDateNorm = emp.hireDate
                ? new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z")
                : null;
              const empEffectiveStart =
                empHireDateNorm && empHireDateNorm > monthFirstDay
                  ? empHireDateNorm
                  : monthFirstDay;

              // Phase 71b (issue #71): holiday set by WORK LOCATION (§ 2 EFZG) instead of a
              // tenant-wide federal state — fed with this employee's own closed work entries (T2).
              const closeMonthEntries = await getWorkedEntriesInRange(
                app.prisma,
                { kind: "employee", employeeId: emp.id, tenantId: tenant.id },
                empEffectiveStart,
                monthLastDay,
              );
              const closeMonthHolidaysByEmployee = await holidaysAtWorkLocation(
                app.prisma,
                tenant.id,
                [emp.id],
                dateStrInTz(empEffectiveStart, tz),
                dateStrInTz(monthEnd, tz),
                closeMonthEntries,
              );
              const closeHolidayDateStrings = new Set<string>(
                closeMonthHolidaysByEmployee.get(emp.id)?.keys() ?? [],
              );

              // Pre-fetch all collections needed by closeEmployeeMonth
              const [closeEntries, closeShifts, closeApprovedLeave, closeAbsences] =
                await Promise.all([
                  // WORK entries (effectiveStart..monthLastDay, soft-delete + isInvalid filter)
                  // Phase 100B Plan 08 — T1, contexts/time-tracking facade. THE SALDO INPUT.
                  getValidWorkedEntriesInRange(
                    app.prisma,
                    { kind: "employee", employeeId: emp.id, tenantId: tenant.id },
                    empEffectiveStart,
                    monthLastDay,
                  ),
                  // Shifts (SHIFT_BASED only — also fetch for non-SHIFT; core ignores them)
                  // Phase 100B Plan 05 — S1, contexts/scheduling facade.
                  getShiftsInRange(
                    app.prisma,
                    { kind: "employee", employeeId: emp.id, tenantId: tenant.id },
                    empEffectiveStart,
                    monthLastDay,
                  ),
                  // Approved leave
                  // Phase 100B Plan 13 — A1, contexts/absence facade. THE SALDO INPUT.
                  getApprovedLeaveOverlapping(
                    app.prisma,
                    { kind: "employee", employeeId: emp.id, tenantId: tenant.id },
                    monthStart,
                    monthEnd,
                  ),
                  // All absences (including VOCATIONAL_SCHOOL — BS-doubling handled in core)
                  // Phase 100B Plan 12 — A4, contexts/absence facade. THE SALDO INPUT.
                  getAbsencesOverlapping(
                    app.prisma,
                    { kind: "employee", employeeId: emp.id, tenantId: tenant.id },
                    empEffectiveStart,
                    monthEnd,
                  ),
                ]);

              // Phase 76.31 (D-06): load Employee + active-Pattern bsSlot* overrides.
              const { employeeSlots, patternSlots, patternUnterrichtsMinutenByDow } =
                await loadBsSlotOverrides(app.prisma, emp.id, monthFirstDay);

              // ── Phase 76.26: call the shared pure saldo core ──────────────────
              const r = closeEmployeeMonth({
                employeeId: emp.id,
                monthStart,
                monthEnd,
                monthFirstDay,
                monthLastDay,
                tz,
                carryOverIn,
                schedule: schedule as Record<string, unknown>,
                hireDate: emp.hireDate,
                exitDate: emp.exitDate ?? null,
                isTimeTrackingExempt: false, // already short-circuited above
                breakOver6hOverride: emp.breakOver6hOverride ?? null,
                breakOver9hOverride: emp.breakOver9hOverride ?? null,
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
                // Issue #220: the shared mapper also derives isOvertimeCompensation from
                // LeaveType.code — never inline it, see toCloseMonthApprovedLeave's doc block.
                approvedLeave: toCloseMonthApprovedLeave(closeApprovedLeave),
                absences: closeAbsences.map((ab) => ({
                  startDate: ab.startDate,
                  endDate: ab.endDate,
                  type: ab.type,
                  source: ab.source,
                  halfDay: ab.halfDay,
                  unterrichtsMinutes: ab.unterrichtsMinutes ?? null,
                })),
                holidayDateStrings: closeHolidayDateStrings,
                tenantConfig: tenant.config
                  ? {
                      defaultBreakOver6h: tenant.config.defaultBreakOver6h,
                      defaultBreakOver9h: tenant.config.defaultBreakOver9h,
                      monthlyHoursHolidayDeduction:
                        tenant.config.monthlyHoursHolidayDeduction ?? undefined,
                      vocationalSchoolMinutesPerDay:
                        tenant.config.vocationalSchoolMinutesPerDay ?? undefined,
                      vocationalSchoolBlockMinutesPerWeek:
                        tenant.config.vocationalSchoolBlockMinutesPerWeek ?? undefined,
                      // Phase 76.31 (D-06) — TenantConfig slot layer.
                      bsSlotFirstLongDayMinutes:
                        tenant.config.bsSlotFirstLongDayMinutes ?? undefined,
                      bsSlotSecondLongDayMinutes:
                        tenant.config.bsSlotSecondLongDayMinutes ?? undefined,
                      bsSlotShortDayMinutes: tenant.config.bsSlotShortDayMinutes ?? undefined,
                      bsSlotBlockWeekMinutes: tenant.config.bsSlotBlockWeekMinutes ?? undefined,
                    }
                  : null,
                // Phase 76.31 (D-06) — Employee/Pattern slot layers (null → fallback).
                employeeSlots,
                patternSlots,
                // Phase 76.38 (D-11) — Pattern per-DOW Unterrichtszeit fallback.
                patternUnterrichtsMinutenByDow,
              });

              const {
                workedMinutes: closeWorkedMinutes,
                balanceMinutes,
                carryOverOut,
                effectiveCarryOverOut,
                snapshotExpectedMinutes,
                gaps,
              } = r;

              // Alias for the $transaction and audit log below (mirrors P1 manual-close variable names)
              const effectiveCarryOver = effectiveCarryOverOut;
              const carryOver = carryOverOut;

              await app.prisma.$transaction(async (tx) => {
                await tx.saldoSnapshot.create({
                  data: {
                    employeeId: emp.id,
                    periodType: "MONTHLY",
                    periodStart: monthStart,
                    periodEnd: monthEnd,
                    workedMinutes: closeWorkedMinutes,
                    expectedMinutes: snapshotExpectedMinutes,
                    balanceMinutes,
                    carryOver: effectiveCarryOver,
                    closedAt: new Date(),
                    closedBy: null, // SYSTEM
                    note:
                      gaps.length > 0
                        ? `Automatischer Monatsabschluss — ${gaps.length} Lücke(n) als 0h geschlossen: ${gaps.map((g) => g.date).join(", ")}`
                        : "Automatischer Monatsabschluss",
                  },
                });

                // Day bounds (not the monthStart/monthEnd timestamps): the timestamp
                // lower bound casts to the previous month's last day for UTC+ tenants.
                // Phase 100B Plan 08 — T7, contexts/time-tracking facade.
                await lockEntriesForMonth(tx, emp.id, tenant.id, monthFirstDay, monthLastDay);

                // PERF-V1814-02: overtimeAccount.upsert inside the same tx as snapshot + entry-lock.
                // A crash between snapshot commit and upsert can no longer leave a stale live balance.
                // effectiveCarryOver=0 for TRACK_ONLY employees.
                await tx.overtimeAccount.upsert({
                  where: { employeeId: emp.id },
                  create: { employeeId: emp.id, balanceHours: effectiveCarryOver / 60 },
                  update: { balanceHours: effectiveCarryOver / 60 },
                });
              });

              await app.audit({
                userId: undefined,
                action: "CREATE",
                entity: "SaldoSnapshot",
                entityId: emp.id,
                newValue: {
                  origin: "SYSTEM",
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  year: monthKey.year,
                  month: monthKey.month,
                  workedMinutes: closeWorkedMinutes,
                  expectedMinutes: snapshotExpectedMinutes,
                  balanceMinutes,
                  carryOver,
                  auto: true,
                },
              });

              app.log.info(
                `Auto-Monatsabschluss: ${emp.firstName} ${emp.lastName} — ${monthKey.month}/${monthKey.year} abgeschlossen (${Math.round(closeWorkedMinutes / 60)}h Ist, ${Math.round(snapshotExpectedMinutes / 60)}h Soll)`,
              );

              // Thread the effectiveCarryOverOut to the next month in the loop
              carryOverIn = effectiveCarryOverOut;
            }
          } catch (err) {
            app.log.error(
              { err, employeeId: emp.id },
              "Auto-Monatsabschluss: Fehler beim Abschluss",
            );
          }
        }

        // Auto-Jahresabschluss: if all 12 months of the previous year are closed, create yearly snapshot
        if (prevMonth === 12) {
          for (const emp of employees) {
            try {
              // Check if yearly snapshot already exists
              const yearlyExists = await app.prisma.saldoSnapshot.findFirst({
                where: {
                  employeeId: emp.id,
                  periodType: "YEARLY",
                  periodStart: {
                    gte: new Date(`${prevYear}-01-01`),
                    lte: new Date(`${prevYear}-01-02`),
                  },
                  superseded: false,
                },
              });
              if (yearlyExists) continue;

              // Check all 12 months are closed
              const yearStart = new Date(`${prevYear}-01-01T00:00:00Z`);
              const yearEnd = new Date(`${prevYear}-12-31T23:59:59Z`);

              // MONTHLY read filter ONLY — tenant-TZ-aware (Issue #242). yearStart/yearEnd
              // above stay naive UTC on purpose: they are the STORED identity of the YEARLY
              // snapshot written below AND the value the idempotency guard a few lines up
              // (:741-744) searches for. Unifying the two (the ticket's literal proposal)
              // would write future YEARLY rows at a different instant, the guard would stop
              // matching them, and an already-closed year could be closed a second time —
              // unattended, per employee (CLAUDE.md § Audit-Proof / Revisionssicherheit).
              // For a Europe/Berlin tenant, MONTHLY periodStart is the tenant-local month
              // start, e.g. January's is stored as `${prevYear - 1}-12-31` — before the
              // naive yearStart above, so the naive filter silently dropped January.
              const { start: monthlyRangeStart } = monthRangeUtc(prevYear, 1, tz);
              const { end: monthlyRangeEnd } = monthRangeUtc(prevYear, 12, tz);
              const monthSnapshots = await app.prisma.saldoSnapshot.findMany({
                where: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: { gte: monthlyRangeStart, lte: monthlyRangeEnd },
                  superseded: false,
                },
                orderBy: { periodStart: "asc" },
              });

              // COMP-V1814-08: mid-year hires only need their share of months.
              // A July hire has 6 months in the year (Jul-Dec); requiring 12 would
              // prevent their yearly carry-over from ever running.
              const hireYear = emp.hireDate ? new Date(emp.hireDate).getFullYear() : null;
              const hireMonth = emp.hireDate ? new Date(emp.hireDate).getMonth() + 1 : 1; // 1-12
              const firstMonth = hireYear === prevYear ? hireMonth : 1;
              const expectedMonths = 12 - firstMonth + 1;
              if (monthSnapshots.length < expectedMonths) continue; // Not all expected months closed yet

              const yearWorked = monthSnapshots.reduce((s, m) => s + m.workedMinutes, 0);
              const yearExpected = monthSnapshots.reduce((s, m) => s + m.expectedMinutes, 0);
              const yearBalance = monthSnapshots.reduce((s, m) => s + m.balanceMinutes, 0);
              const decSnapshot = monthSnapshots[monthSnapshots.length - 1];
              const finalCarryOver = decSnapshot.carryOver;

              // Apply carry-over rules
              const mode = tenant.config?.overtimeCarryOverMode ?? "FULL";
              const cap = tenant.config?.overtimeCarryOverCap;
              let appliedCarryOver = finalCarryOver;
              if (mode === "RESET") {
                appliedCarryOver = 0;
              } else if (mode === "CAPPED" && cap != null && finalCarryOver > cap) {
                appliedCarryOver = cap;
              }

              // PERF-V1814-02: saldoSnapshot.create + overtimeAccount.upsert in ONE $transaction.
              // A crash between snapshot commit and balance upsert can no longer leave stale data
              // (previously there was NO transaction at all around these two writes).
              await app.prisma.$transaction(async (tx) => {
                await tx.saldoSnapshot.create({
                  data: {
                    employeeId: emp.id,
                    periodType: "YEARLY",
                    periodStart: yearStart,
                    periodEnd: yearEnd,
                    workedMinutes: yearWorked,
                    expectedMinutes: yearExpected,
                    balanceMinutes: yearBalance,
                    carryOver: appliedCarryOver,
                    closedAt: new Date(),
                    closedBy: null,
                    note:
                      mode === "RESET"
                        ? "Automatischer Jahresübertrag: Reset auf 0"
                        : mode === "CAPPED" && cap != null && finalCarryOver > cap
                          ? `Automatischer Jahresübertrag: gedeckelt auf ${Math.round(cap / 60)}h`
                          : `Automatischer Jahresübertrag: ${Math.round(appliedCarryOver / 60)}h`,
                  },
                });

                await tx.overtimeAccount.upsert({
                  where: { employeeId: emp.id },
                  create: { employeeId: emp.id, balanceHours: appliedCarryOver / 60 },
                  update: { balanceHours: appliedCarryOver / 60 },
                });
              });

              await app.audit({
                userId: undefined,
                action: "CREATE",
                entity: "SaldoSnapshot",
                entityId: emp.id,
                newValue: {
                  origin: "SYSTEM",
                  employeeId: emp.id,
                  periodType: "YEARLY",
                  year: prevYear,
                  mode,
                  originalCarryOver: finalCarryOver,
                  appliedCarryOver,
                  auto: true,
                },
              });

              app.log.info(
                `Auto-Jahresabschluss: ${emp.firstName} ${emp.lastName} — ${prevYear} abgeschlossen (Übertrag: ${Math.round(appliedCarryOver / 60)}h)`,
              );
            } catch (err) {
              app.log.error({ err, employeeId: emp.id }, "Auto-Jahresabschluss: Fehler");
            }
          }
        }

        // Notify managers about missing entries (from gap-blocked months in the backfill loop)
        if (missing.length > 0) {
          const lines = missing.map((m) => {
            const name = `${m.employee.firstName} ${m.employee.lastName}`;
            const dates = m.missingDates
              .map((d) =>
                new Date(d).toLocaleDateString("de-DE", {
                  day: "2-digit",
                  month: "2-digit",
                }),
              )
              .join(", ");
            return `${name} (${m.month}/${m.year}): ${dates}`;
          });

          // Phase 292 (GitHub issue #292): name and link the OLDEST blocked month, not the
          // ceiling month of the backfill range. See month-close-notification.ts — the old title
          // reported `prevMonth`, which for a months-old deferral is a month that closed fine.
          const blockedMonth = oldestMonth(missing.map((m) => ({ year: m.year, month: m.month })));
          const monthName = monthLabelDe(blockedMonth);
          const link = monthCloseDeepLink(blockedMonth);

          // Phase 91b Plan 09 (Issue #91), D-10/D-17: `missing` spans potentially several
          // employees — a holder is kept if their reach covers AT LEAST ONE of them, Stichtag =
          // this run's own oldest blocked month's end (one Stichtag for the whole batch, same
          // simplification as the sibling weekly-escalation plugin).
          const blockedMonthEnd = monthRangeUtc(blockedMonth.year, blockedMonth.month, tz).end;
          const scopedMonthCloseCloseHolderIds = await resolveScopedHolderIds(
            app.prisma,
            tenant.id,
            monthCloseCloseHolderIds,
            "month-close:close:ZUGEWIESEN",
            async (reach) => {
              for (const m of missing) {
                if (
                  await isStammsalonScopeMatch(
                    app.prisma,
                    tenant.id,
                    reach,
                    m.employee.id,
                    blockedMonthEnd,
                  )
                ) {
                  return true;
                }
              }
              return false;
            },
          );
          const managers = await app.prisma.employee.findMany({
            where: {
              tenantId: tenant.id,
              user: { isActive: true, id: { in: scopedMonthCloseCloseHolderIds } },
            },
            include: { user: true },
          });

          // Phase 292: one notification per CHANGE of the blocked set, not one per run. The
          // recurring duty belongs to the weekly MONTH_CLOSE_DEFERRED escalation
          // (plugins/deferred-month-close-reminder.ts) — repeating an identical message every
          // morning is what made this state invisible in the first place.
          const fingerprint = blockedSetFingerprint(
            missing.map((m) => ({ employeeId: m.employee.id, year: m.year, month: m.month })),
          );

          for (const mgr of managers) {
            const alreadyOpen = await app.prisma.notification.findFirst({
              where: {
                userId: mgr.user.id,
                type: "MONTH_CLOSE_BLOCKED",
                relatedType: MONTH_CLOSE_DEFERRAL_RELATED_TYPE,
                relatedId: fingerprint,
                dismissedAt: null,
              },
              select: { id: true },
            });
            if (alreadyOpen) continue;

            await app.notify({
              userId: mgr.user.id,
              type: "MONTH_CLOSE_BLOCKED",
              title: `Monatsabschluss ${monthName} nicht möglich`,
              message: `Fehlende Zeiteinträge:\n${lines.join("\n")}`,
              link,
              tenantId: tenant.id,
              relatedType: MONTH_CLOSE_DEFERRAL_RELATED_TYPE,
              relatedId: fingerprint,
            });
          }

          app.log.info(
            `Auto-Monatsabschluss: Tenant ${tenant.name} — ${missing.length} MA mit fehlenden Einträgen`,
          );
        } else {
          app.log.info(
            `Auto-Monatsabschluss: Tenant ${tenant.name} — Backfill-Durchlauf abgeschlossen`,
          );
        }
      } catch (err) {
        // D-04: one tenant's failure logs (audit-traceable) and continues — it must
        // not abort the Monatsabschluss run for every subsequent tenant.
        app.log.error(
          { err, tenant: tenant.id },
          "Auto-Monatsabschluss: Tenant fehlgeschlagen, fahre fort",
        );
        continue;
      }
    }
  }

  // Phase 66 (DEBT-01): expose tryAutoCloseMonth as a Fastify decorator so the
  // D-11 grace-period guard test can invoke it directly. Previously the test
  // intercepted `cron.schedule("0 6 * * *", ...)`, but `carryoverWarningPlugin`
  // registers the SAME cron expression (in its `onReady` hook, which runs after
  // plugin registration) and overwrote the captured callback — the test then
  // exercised the carryover-warning path instead of the auto-close path.
  // The cron registration below is unchanged: production behavior is identical.
  app.decorate("tryAutoCloseMonth", tryAutoCloseMonth);

  // Run daily at 06:00 Berlin time. Leader-locked so only one replica runs the
  // Monatsabschluss per window; noOverlap skips a tick if the previous run is still active.
  const task = cron.schedule(
    "0 6 * * *",
    () => {
      withAdvisoryLock(
        app.prisma,
        ADVISORY_LOCK_KEYS.AUTO_CLOSE_MONTH,
        () => tryAutoCloseMonth(),
        app.log,
      ).catch((err) => app.log.error({ err }, "Auto-Monatsabschluss fehlgeschlagen"));
    },
    { timezone: "Europe/Berlin", noOverlap: true },
  );
  tasks.push(task);
  app.log.info("Auto-Monatsabschluss: Tägliche Prüfung geplant (06:00)");

  app.addHook("onClose", () => {
    tasks.forEach((t) => void t.stop());
  });
});
