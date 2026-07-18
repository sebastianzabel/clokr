import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import {
  monthRangeUtc,
  monthDayBounds,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
  dateStrInTz,
} from "../utils/timezone";
import { getEffectiveSchedule } from "../routes/time-entries";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { periodStartWindow } from "../utils/snapshot-period";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../utils/with-advisory-lock";
import { closeEmployeeMonth } from "../utils/close-employee-month"; // Phase 76.26 — shared pure saldo core

declare module "fastify" {
  interface FastifyInstance {
    tryAutoCloseMonth: () => Promise<void>;
  }
}

/**
 * Auto-Monatsabschluss: runs daily at 06:00 during the first 10 days of each month.
 *
 * For each tenant, checks if the previous month is already closed for all active employees.
 * If not:
 *   1. Check if all employees have time entries for all workdays
 *   2. If complete → auto-close the month (create SaldoSnapshot, lock entries)
 *   3. If incomplete → send notification to managers listing missing entries
 *   4. Retry next day
 */
export const autoCloseMonthPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  async function tryAutoCloseMonth() {
    // D-11: Grace period — auto-close only runs if we are past the configurable threshold.
    // TenantConfig.closeAfterDay is not yet in the schema; hardcoded default is 15.
    // (Future: add closeAfterDay: Int @default(15) to TenantConfig and read it per-tenant below)
    const DEFAULT_CLOSE_AFTER_DAY = 15;

    const now = new Date();

    app.log.info("Auto-Monatsabschluss: Prüfe Vormonat");

    const tenants = await app.prisma.tenant.findMany({
      include: { config: true },
    });

    for (const tenant of tenants) {
      try {
        const tz = tenant.config?.timezone ?? "Europe/Berlin";

        // D-11: Grace period — evaluated PER TENANT in the tenant's local timezone.
        // A UTC day-of-month guard would close a tenant's month a day early/late on
        // the boundary; `dateStrInTz` gives the tenant-local calendar day. `continue`
        // skips only THIS tenant, not all subsequent tenants.
        const dayOfMonthInTz = parseInt(dateStrInTz(now, tz).split("-")[2], 10);
        if (dayOfMonthInTz < DEFAULT_CLOSE_AFTER_DAY) {
          app.log.info(
            `Auto-Monatsabschluss: Tenant ${tenant.name} — Warte bis Tag ${DEFAULT_CLOSE_AFTER_DAY} des Monats (aktuell: ${dayOfMonthInTz})`,
          );
          continue;
        }

        // Calculate previous month
        const zonedNow = new Date(dateStrInTz(now, tz) + "T12:00:00Z");
        let prevYear = zonedNow.getUTCFullYear();
        let prevMonth = zonedNow.getUTCMonth(); // 0-based, so this IS previous month (1-based)
        if (prevMonth === 0) {
          prevMonth = 12;
          prevYear -= 1;
        }

        const { start: monthStart, end: monthEnd } = monthRangeUtc(prevYear, prevMonth, tz);

        // Pre-compute holiday date strings for this month: computed Feiertage + manual DB entries
        const acmStateCode = STATE_MAP[tenant.federalState] ?? "NI";
        const acmHolidayDateStrings = new Set<string>(
          getHolidays(prevYear, acmStateCode).map((h) => h.date),
        );
        const acmDbHolidays = await app.prisma.publicHoliday.findMany({
          where: { tenantId: tenant.id, date: { gte: monthStart, lte: monthEnd } },
        });
        for (const h of acmDbHolidays) {
          acmHolidayDateStrings.add(dateStrInTz(h.date, tz));
        }

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

        // Get managers for notifications
        const managers = employees.filter(
          (e) => e.user.role === "ADMIN" || e.user.role === "MANAGER",
        );

        const missing: { employee: (typeof employees)[0]; missingDates: string[] }[] = [];
        const readyToClose: (typeof employees)[0][] = [];

        for (const emp of employees) {
          // Check if already closed — use findFirst with superseded:false.
          // The @@unique was replaced by a partial unique index (COMP-V1814-04); the compound
          // accessor no longer exists. superseded:false ensures only the active snapshot is checked.
          // Convention-robust: periodStartWindow matches both the TZ-converted date
          // (e.g. 2026-05-31 for June/Berlin) AND legacy UTC-naive rows (2026-06-01),
          // so a manually/script-closed month is never re-closed by the cron.
          const existingSnapshot = await app.prisma.saldoSnapshot.findFirst({
            where: {
              employeeId: emp.id,
              periodType: "MONTHLY",
              periodStart: periodStartWindow(monthStart),
              superseded: false,
            },
          });
          if (existingSnapshot) continue; // Already closed

          // Skip employees hired after this month
          if (emp.hireDate > monthEnd) continue;

          // Sequential-close guard (parity with the manual close-month route, which
          // rejects with "Bitte zuerst {Monat} abschließen"): NEVER close month N when
          // month N-1 has no active snapshot — otherwise the prevSnapshot carry-over
          // lookup silently skips over the open month and its entire balance is
          // dropped from the saldo chain. Only exempt: employee was hired during or
          // after the target month (no prior month exists for them).
          {
            let guardPrevYear = prevYear;
            let guardPrevMonth = prevMonth - 1;
            if (guardPrevMonth === 0) {
              guardPrevMonth = 12;
              guardPrevYear -= 1;
            }
            const { start: guardStart, end: guardEnd } = monthRangeUtc(
              guardPrevYear,
              guardPrevMonth,
              tz,
            );
            const hireDateNormGuard = new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z");
            // Guard applies only if the employee was already employed in month N-1.
            if (hireDateNormGuard <= guardEnd) {
              const prevMonthSnapshot = await app.prisma.saldoSnapshot.findFirst({
                where: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: periodStartWindow(guardStart),
                  superseded: false,
                },
              });
              if (!prevMonthSnapshot) {
                app.log.warn(
                  { employeeId: emp.id, month: prevMonth, year: prevYear },
                  `Auto-Monatsabschluss: übersprungen — Vormonat ${guardPrevMonth}/${guardPrevYear} ist nicht abgeschlossen (sequentieller Abschluss erforderlich)`,
                );
                continue;
              }
            }
          }

          // Schedule valid FOR the target month (not the newest row): after a contract
          // change (validFrom = 1st of a later month) the readiness check must use the
          // schedule that governed the month being closed.
          const schedule = emp.workSchedules.find((ws) => ws.validFrom <= monthEnd);
          if (!schedule) {
            readyToClose.push(emp); // No schedule = no expected hours, can close
            continue;
          }

          // MONTHLY_HOURS employees work flexibly — no daily checks needed
          if (String(schedule.type) === "MONTHLY_HOURS") {
            readyToClose.push(emp);
            continue;
          }

          // Find workdays without time entries
          const entries = await app.prisma.timeEntry.findMany({
            where: {
              employeeId: emp.id,
              deletedAt: null,
              date: { gte: monthStart, lte: monthEnd },
              endTime: { not: null },
              type: "WORK",
            },
            select: { date: true },
          });
          const entryDates = new Set(entries.map((e) => dateStrInTz(e.date, tz)));

          // Check approved leave and absences
          const approvedLeave = await app.prisma.leaveRequest.findMany({
            where: {
              employeeId: emp.id,
              deletedAt: null,
              status: "APPROVED",
              startDate: { lte: monthEnd },
              endDate: { gte: monthStart },
            },
          });
          const absences = await app.prisma.absence.findMany({
            where: {
              employeeId: emp.id,
              deletedAt: null,
              startDate: { lte: monthEnd },
              endDate: { gte: monthStart },
            },
          });

          // Build set of leave/absence dates (TZ-aware)
          const coveredDates = new Set<string>();
          for (const lr of approvedLeave) {
            const s = lr.startDate < monthStart ? monthStart : lr.startDate;
            const e = lr.endDate > monthEnd ? monthEnd : lr.endDate;
            const cur = new Date(s);
            while (cur <= e) {
              coveredDates.add(dateStrInTz(cur, tz));
              cur.setDate(cur.getDate() + 1);
            }
          }
          for (const ab of absences) {
            const s = ab.startDate < monthStart ? monthStart : ab.startDate;
            const e = ab.endDate > monthEnd ? monthEnd : ab.endDate;
            const cur = new Date(s);
            while (cur <= e) {
              coveredDates.add(dateStrInTz(cur, tz));
              cur.setDate(cur.getDate() + 1);
            }
          }

          // Add holidays (computed Feiertage + manual DB entries) to coveredDates
          for (const dateStr of acmHolidayDateStrings) {
            coveredDates.add(dateStr);
          }

          // Iterate workdays and find missing ones (TZ-aware date strings)
          const missingDates: string[] = [];
          const effectiveStart = emp.hireDate > monthStart ? emp.hireDate : monthStart;
          const cur = new Date(effectiveStart);
          while (cur <= monthEnd) {
            const dateStr = dateStrInTz(cur, tz);
            const dow = getDayOfWeekInTz(cur, tz);
            const expectedHours = getDayHoursFromSchedule(schedule as Record<string, unknown>, dow);

            // Only check workdays (expected hours > 0)
            if (expectedHours > 0 && !entryDates.has(dateStr) && !coveredDates.has(dateStr)) {
              missingDates.push(dateStr);
            }

            cur.setDate(cur.getDate() + 1);
          }

          if (missingDates.length > 0) {
            missing.push({ employee: emp, missingDates });
          } else {
            readyToClose.push(emp);
          }
        }

        // Tenant-local day bounds for @db.Date column filters (TimeEntry.date,
        // Shift.date, PublicHoliday.date). monthStart/monthEnd timestamps cast to
        // the PREVIOUS month's last day for UTC+ tenants — using them directly
        // double-counts the boundary day (prod evidence: a May-31 entry counted
        // in BOTH the May and the June snapshot).
        const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
          monthStart,
          monthEnd,
          tz,
        );

        // Auto-close employees that are ready
        for (const emp of readyToClose) {
          try {
            // Schedule valid for the MIDDLE of the target month — closing a past
            // month after a contract change must use the historical schedule
            // (parity with recalculate-snapshots.ts).
            const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);
            const schedule = await getEffectiveSchedule(app, emp.id, midMonth);

            // Phase 76.26 — P2 cron rewire: pre-fetch all data needed by closeEmployeeMonth.
            // The inline saldo computation (~395 lines) is replaced by the shared pure core.
            // $transaction + app.audit + SYSTEM user + isLocked guard stay here (caller owns
            // DB atomicity). Byte-identical values to the previous inline path are guaranteed
            // by the four-path parity test suite (shift-based-saldo-parity, saldo-invariant-e2e).

            // Build holiday set for this employee: merge computed Feiertage + DB manual holidays.
            // acmHolidayDateStrings (computed + DB) is already available for the whole tenant;
            // the per-employee DB query below adds any employee-scoped overrides (same as before).
            const empHireDateNorm = emp.hireDate
              ? new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z")
              : null;
            const empEffectiveStart =
              empHireDateNorm && empHireDateNorm > monthFirstDay ? empHireDateNorm : monthFirstDay;

            const closeMonthComputedHolidays = getHolidays(prevYear, acmStateCode).filter(
              (h) =>
                h.date >= dateStrInTz(empEffectiveStart, tz) && h.date <= dateStrInTz(monthEnd, tz),
            );
            const closeMonthDbHolidays = await app.prisma.publicHoliday.findMany({
              where: {
                tenant: { employees: { some: { id: emp.id } } },
                date: { gte: empEffectiveStart, lte: monthLastDay },
              },
            });
            const closeMonthHolidayDateSet = new Set<string>(
              closeMonthComputedHolidays.map((h) => h.date),
            );
            const closeHolidayDateStrings = new Set<string>([
              ...closeMonthComputedHolidays.map((h) => h.date),
              ...closeMonthDbHolidays
                .filter((h) => !closeMonthHolidayDateSet.has(dateStrInTz(h.date, tz)))
                .map((h) => dateStrInTz(h.date, tz)),
            ]);

            // Pre-fetch all collections needed by closeEmployeeMonth.
            const [closeEntries, closeShifts, closeApprovedLeave, closeAbsences] =
              await Promise.all([
                // WORK entries (effectiveStart..monthLastDay, soft-delete + isInvalid filter)
                app.prisma.timeEntry.findMany({
                  where: {
                    employeeId: emp.id,
                    deletedAt: null,
                    date: { gte: empEffectiveStart, lte: monthLastDay },
                    endTime: { not: null },
                    type: "WORK",
                    isInvalid: false,
                  },
                  select: { date: true, startTime: true, endTime: true, breakMinutes: true },
                }),
                // Shifts (SHIFT_BASED only — also fetch for non-SHIFT; core ignores them)
                app.prisma.shift.findMany({
                  where: {
                    employeeId: emp.id,
                    date: { gte: empEffectiveStart, lte: monthLastDay },
                    deletedAt: null,
                  },
                  select: { date: true, startTime: true, endTime: true },
                }),
                // Approved leave
                app.prisma.leaveRequest.findMany({
                  where: {
                    employeeId: emp.id,
                    deletedAt: null,
                    status: "APPROVED",
                    startDate: { lte: monthEnd },
                    endDate: { gte: monthStart },
                  },
                  select: { startDate: true, endDate: true, halfDay: true },
                }),
                // All absences (including VOCATIONAL_SCHOOL — BS-doubling handled in core)
                app.prisma.absence.findMany({
                  where: {
                    employeeId: emp.id,
                    deletedAt: null,
                    startDate: { lte: monthEnd },
                    endDate: { gte: empEffectiveStart },
                  },
                  select: { startDate: true, endDate: true, type: true, source: true },
                }),
              ]);

            // Previous snapshot carry-over (most recent prior month, or 0 for first month).
            const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
              where: {
                employeeId: emp.id,
                periodType: "MONTHLY",
                periodStart: { lt: monthStart },
                superseded: false,
              },
              orderBy: { periodStart: "desc" },
            });
            const carryOverIn = prevSnapshot?.carryOver ?? 0;

            // ── Phase 76.26: call the shared pure saldo core ──────────────────────────
            // BS-doubling (Phase 76.12 D-14): the old inline `const bsAbsences = await app.prisma.absence.findMany`
            // with `type: "VOCATIONAL_SCHOOL"` filter is now handled inside closeEmployeeMonth (via the
            // absences array passed below — all absence types including VOCATIONAL_SCHOOL are included).
            // Leave-reduce (D-14): `calcLeaveAbsenceMinutesTz(` with `halfDay: Boolean(lr.halfDay)` is now
            // inside closeEmployeeMonth; the `halfDay: Boolean(lr.halfDay)` mapping below preserves it.
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
              approvedLeave: closeApprovedLeave.map((lr) => ({
                startDate: lr.startDate,
                endDate: lr.endDate,
                halfDay: Boolean(lr.halfDay),
              })),
              absences: closeAbsences.map((ab) => ({
                startDate: ab.startDate,
                endDate: ab.endDate,
                type: ab.type,
                source: ab.source,
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
                  }
                : null,
            });

            const {
              workedMinutes: closeWorkedMinutes,
              balanceMinutes,
              carryOverOut,
              effectiveCarryOverOut,
              snapshotExpectedMinutes,
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
                  note: "Automatischer Monatsabschluss",
                },
              });

              await tx.timeEntry.updateMany({
                where: {
                  employeeId: emp.id,
                  deletedAt: null,
                  // Day bounds (not the monthStart/monthEnd timestamps): the timestamp
                  // lower bound casts to the previous month's last day for UTC+ tenants.
                  date: { gte: monthFirstDay, lte: monthLastDay },
                },
                data: { isLocked: true, lockedAt: new Date() },
              });

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
                year: prevYear,
                month: prevMonth,
                workedMinutes: closeWorkedMinutes,
                expectedMinutes: snapshotExpectedMinutes,
                balanceMinutes,
                carryOver,
                auto: true,
              },
            });

            app.log.info(
              `Auto-Monatsabschluss: ${emp.firstName} ${emp.lastName} — ${prevMonth}/${prevYear} abgeschlossen (${Math.round(closeWorkedMinutes / 60)}h Ist, ${Math.round(snapshotExpectedMinutes / 60)}h Soll)`,
            );
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
              const monthSnapshots = await app.prisma.saldoSnapshot.findMany({
                where: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: { gte: yearStart, lte: yearEnd },
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

        // Notify managers about missing entries
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
            return `${name}: ${dates}`;
          });

          const monthName = new Date(
            `${prevYear}-${String(prevMonth).padStart(2, "0")}-15`,
          ).toLocaleDateString("de-DE", { month: "long", year: "numeric" });

          for (const mgr of managers) {
            await app.notify({
              userId: mgr.user.id,
              type: "MONTH_CLOSE_BLOCKED",
              title: `Monatsabschluss ${monthName} nicht möglich`,
              message: `Fehlende Zeiteinträge:\n${lines.join("\n")}`,
              link: "/admin/month-close",
            });
          }

          app.log.info(
            `Auto-Monatsabschluss: Tenant ${tenant.name} — ${missing.length} MA mit fehlenden Einträgen, ${readyToClose.length} abgeschlossen`,
          );
        } else if (readyToClose.length > 0) {
          app.log.info(
            `Auto-Monatsabschluss: Tenant ${tenant.name} — alle ${readyToClose.length} MA abgeschlossen`,
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
