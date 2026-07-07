import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import {
  monthRangeUtc,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
  calcExpectedMinutesTz,
  calcLeaveAbsenceMinutesTz,
  dateStrInTz,
} from "../utils/timezone";
import { getEffectiveSchedule } from "../routes/time-entries";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { getVocationalSchoolMinutesForDate } from "../utils/vocational-school-saldo";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../utils/with-advisory-lock";

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
          // Check if already closed — use unique index on (employeeId, periodType, periodStart)
          // so months with 29/30/31 days are correctly detected (periodEnd-based check misses them).
          // Composite key — superseded filter unnecessary (unique constraint guarantees specificity).
          const existingSnapshot = await app.prisma.saldoSnapshot.findUnique({
            where: {
              employeeId_periodType_periodStart: {
                employeeId: emp.id,
                periodType: "MONTHLY",
                periodStart: monthStart,
              },
            },
          });
          if (existingSnapshot) continue; // Already closed

          // Skip employees hired after this month
          if (emp.hireDate > monthEnd) continue;

          const schedule = emp.workSchedules[0];
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

        // Auto-close employees that are ready
        for (const emp of readyToClose) {
          try {
            const schedule = await getEffectiveSchedule(app, emp.id);
            const hireDateNorm = emp.hireDate
              ? new Date(dateStrInTz(emp.hireDate, tz) + "T00:00:00Z")
              : null;
            const effectiveStart =
              hireDateNorm && hireDateNorm > monthStart ? hireDateNorm : monthStart;

            const entries = await app.prisma.timeEntry.findMany({
              where: {
                employeeId: emp.id,
                deletedAt: null,
                date: { gte: monthStart, lte: monthEnd },
                endTime: { not: null },
                type: "WORK",
                isInvalid: false,
              },
            });

            const workedMinutes = entries.reduce((sum, e) => {
              if (!e.endTime) return sum;
              return (
                sum + (e.endTime.getTime() - e.startTime.getTime()) / 60000 - Number(e.breakMinutes)
              );
            }, 0);

            const expectedMinutes = calcExpectedMinutesTz(schedule, effectiveStart, monthEnd, tz);

            // Holiday minutes: merge computed Feiertage + manual DB entries, dedup by date string
            const effectiveStartStr = dateStrInTz(effectiveStart, tz);
            const monthEndStr = dateStrInTz(monthEnd, tz);
            const acmComputedForSnap = getHolidays(prevYear, acmStateCode).filter(
              (h) => h.date >= effectiveStartStr && h.date <= monthEndStr,
            );
            const computedSnapDateSet = new Set(acmComputedForSnap.map((h) => h.date));
            const acmDbForSnap = await app.prisma.publicHoliday.findMany({
              where: {
                tenant: { employees: { some: { id: emp.id } } },
                date: { gte: effectiveStart, lte: monthEnd },
              },
            });
            // Build unified list of holiday dates as Date objects (no duplicates)
            const allSnapHolidays: Date[] = [
              ...acmComputedForSnap.map((h) => new Date(h.date + "T00:00:00Z")),
              ...acmDbForSnap
                .filter((h) => !computedSnapDateSet.has(dateStrInTz(h.date, tz)))
                .map((h) => h.date),
            ];
            // MONTHLY_HOURS Feiertagsabzug (Phase 15 — TENANT-01)
            const isMonthlyHoursDeduction =
              String(schedule.type ?? "") === "MONTHLY_HOURS" &&
              Number(schedule.monthlyHours ?? 0) > 0 &&
              tenant.config?.monthlyHoursHolidayDeduction === true;

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

            const holidayMinutes = allSnapHolidays.reduce((sum, hDate) => {
              const dow = getDayOfWeekInTz(hDate, tz);
              if (isMonthlyHoursDeduction) {
                return getDayHoursFromSchedule(schedule, dow) > 0 ? sum + dailySollMin : sum;
              }
              return sum + getDayHoursFromSchedule(schedule, dow) * 60;
            }, 0);

            // D-06: exclude holidays inside leave/absence so a holiday-in-leave day is
            // deducted once (holidayMinutes subtracts it separately — same source).
            const snapHolidayStrs = new Set(allSnapHolidays.map((h) => dateStrInTz(h, tz)));

            const approvedLeave = await app.prisma.leaveRequest.findMany({
              where: {
                employeeId: emp.id,
                deletedAt: null, // required by soft-delete convention
                status: "APPROVED",
                startDate: { lte: monthEnd },
                endDate: { gte: monthStart },
              },
            });
            const isPureTracking =
              String(schedule.type) === "MONTHLY_HOURS" &&
              (!schedule.monthlyHours || Number(schedule.monthlyHours) === 0);
            let leaveMinutes = 0;
            if (!isPureTracking) {
              leaveMinutes = approvedLeave.reduce((sum, lr) => {
                const leaveStart = lr.startDate < effectiveStart ? effectiveStart : lr.startDate;
                const leaveEnd = lr.endDate > monthEnd ? monthEnd : lr.endDate;
                if (leaveStart > leaveEnd) return sum;
                // Phase 76.12 D-14 — Ø-Methode (BAG 9 AZR 406/17) honors lr.halfDay.
                return (
                  sum +
                  calcLeaveAbsenceMinutesTz(schedule, leaveStart, leaveEnd, tz, {
                    halfDay: Boolean(lr.halfDay),
                    excludeHolidays: snapHolidayStrs,
                  })
                );
              }, 0);
            }

            // Phase 63 — Berufsschule (BS) doubling for the auto-snapshot path.
            // Per D-01..D-04: VOCATIONAL_SCHOOL absences contribute the same minutes to
            // BOTH workedMinutes AND expectedMinutes for FIXED_SCHEDULE / SHIFT_BASED
            // (balance neutral). MONTHLY_HOURS only adds to workedMinutes (D-04).
            // Note: this snapshot path historically does not subtract general absences from
            // expected (unlike close-month in overtime.ts) — but BS-doubling stays
            // consistent across both paths so live + snapshot saldo agree (RESEARCH Pitfall #2).
            const bsAbsences = await app.prisma.absence.findMany({
              where: {
                employeeId: emp.id,
                deletedAt: null, // CLAUDE.md soft-delete rule
                type: "VOCATIONAL_SCHOOL",
                startDate: { lte: monthEnd },
                endDate: { gte: effectiveStart },
              },
            });
            let bsWorkedMinutes = 0;
            let bsExpectedMinutes = 0;
            const acmScheduleType = String(schedule.type ?? "");
            for (const ab of bsAbsences) {
              const start = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
              const end = ab.endDate > monthEnd ? monthEnd : ab.endDate;
              const cur = new Date(start);
              while (cur <= end) {
                const bsMin = await getVocationalSchoolMinutesForDate(
                  app.prisma,
                  emp.id,
                  cur,
                  tenant.config,
                );
                bsWorkedMinutes += bsMin;
                if (acmScheduleType !== "MONTHLY_HOURS") {
                  bsExpectedMinutes += bsMin;
                }
                cur.setUTCDate(cur.getUTCDate() + 1);
              }
            }

            // D-02: subtract general absences from expected (parity with manual overtime.ts close).
            // Exclude VOCATIONAL_SCHOOL (balance-neutral via BS-doubling above) and PATTERN-source
            // (auto-generated). Mirrors the leave day-sum (no holiday exclusion — auto-close is out
            // of D-06 scope; keeps this path internally consistent).
            const generalAbsences = await app.prisma.absence.findMany({
              where: {
                employeeId: emp.id,
                deletedAt: null,
                type: { not: "VOCATIONAL_SCHOOL" },
                source: { not: "PATTERN" },
                startDate: { lte: monthEnd },
                endDate: { gte: effectiveStart },
              },
            });
            let absenceMinutes = 0;
            if (!isPureTracking) {
              absenceMinutes = generalAbsences.reduce((sum, ab) => {
                const absStart = ab.startDate < effectiveStart ? effectiveStart : ab.startDate;
                const absEnd = ab.endDate > monthEnd ? monthEnd : ab.endDate;
                if (absStart > absEnd) return sum;
                return (
                  sum +
                  calcLeaveAbsenceMinutesTz(schedule, absStart, absEnd, tz, {
                    excludeHolidays: snapHolidayStrs,
                  })
                );
              }, 0);
            }

            const totalWorked = workedMinutes + bsWorkedMinutes;
            const totalExpected = expectedMinutes + bsExpectedMinutes;
            const netExpected = Math.max(
              0,
              totalExpected - holidayMinutes - leaveMinutes - absenceMinutes,
            );
            const balanceMinutes = Math.round(totalWorked - netExpected);

            // Note: if months are not contiguous (gap in snapshots), carryOver from the most recent
            // prior snapshot is used. This is intentional — incomplete months before hire are not snapshotted.
            const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
              where: {
                employeeId: emp.id,
                periodType: "MONTHLY",
                periodStart: { lt: monthStart },
                superseded: false,
              },
              orderBy: { periodStart: "desc" },
            });
            const carryOver = (prevSnapshot?.carryOver ?? 0) + balanceMinutes;

            // D-05/D-06: Bifurcate on overtimeMode
            const isTrackOnly =
              String(schedule.type) === "MONTHLY_HOURS" && schedule.overtimeMode === "TRACK_ONLY";
            const effectiveCarryOver = isTrackOnly ? 0 : carryOver;

            await app.prisma.$transaction(async (tx) => {
              await tx.saldoSnapshot.create({
                data: {
                  employeeId: emp.id,
                  periodType: "MONTHLY",
                  periodStart: monthStart,
                  periodEnd: monthEnd,
                  workedMinutes: Math.round(totalWorked),
                  expectedMinutes: Math.round(netExpected),
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
                  date: { gte: monthStart, lte: monthEnd },
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
                workedMinutes: Math.round(totalWorked),
                expectedMinutes: Math.round(netExpected),
                balanceMinutes,
                carryOver,
                auto: true,
              },
            });

            app.log.info(
              `Auto-Monatsabschluss: ${emp.firstName} ${emp.lastName} — ${prevMonth}/${prevYear} abgeschlossen (${Math.round(totalWorked / 60)}h Ist, ${Math.round(netExpected / 60)}h Soll)`,
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

              if (monthSnapshots.length < 12) continue; // Not all months closed yet

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
