import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import {
  monthRangeUtc,
  getDayOfWeekInTz,
  getDayHoursFromSchedule,
  calcExpectedMinutesTz,
  dateStrInTz,
} from "../utils/timezone";
import { getEffectiveSchedule } from "../routes/time-entries";
import { getHolidays, STATE_MAP } from "../utils/holidays";

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
    const now = new Date();
    const dayOfMonth = now.getDate();

    // Only run during first 10 days of each month (give time for corrections)
    if (dayOfMonth > 10) return;

    app.log.info("Auto-Monatsabschluss: Prüfe Vormonat");

    const tenants = await app.prisma.tenant.findMany({
      include: { config: true },
    });

    for (const tenant of tenants) {
      const tz = tenant.config?.timezone ?? "Europe/Berlin";

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
        // Check if already closed
        const existingSnapshot = await app.prisma.saldoSnapshot.findFirst({
          where: {
            employeeId: emp.id,
            periodType: "MONTHLY",
            periodStart: { gte: new Date(`${prevYear}-${String(prevMonth).padStart(2, "0")}-01`) },
            periodEnd: {
              lte: new Date(`${prevYear}-${String(prevMonth).padStart(2, "0")}-28T23:59:59Z`),
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
          const holidayMinutes = allSnapHolidays.reduce((sum, hDate) => {
            const dow = getDayOfWeekInTz(hDate, tz);
            return sum + getDayHoursFromSchedule(schedule, dow) * 60;
          }, 0);

          const approvedLeave = await app.prisma.leaveRequest.findMany({
            where: {
              employeeId: emp.id,
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

          const prevSnapshot = await app.prisma.saldoSnapshot.findFirst({
            where: {
              employeeId: emp.id,
              periodType: "MONTHLY",
              periodStart: { lt: monthStart },
            },
            orderBy: { periodStart: "desc" },
          });
          const carryOver = (prevSnapshot?.carryOver ?? 0) + balanceMinutes;

          await app.prisma.$transaction(async (tx) => {
            await tx.saldoSnapshot.create({
              data: {
                employeeId: emp.id,
                periodType: "MONTHLY",
                periodStart: monthStart,
                periodEnd: monthEnd,
                workedMinutes: Math.round(workedMinutes),
                expectedMinutes: Math.round(netExpected),
                balanceMinutes,
                carryOver,
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
          });

          await app.prisma.overtimeAccount.upsert({
            where: { employeeId: emp.id },
            create: { employeeId: emp.id, balanceHours: carryOver / 60 },
            update: { balanceHours: carryOver / 60 },
          });

          await app.audit({
            userId: "SYSTEM",
            action: "CREATE",
            entity: "SaldoSnapshot",
            entityId: emp.id,
            newValue: {
              employeeId: emp.id,
              periodType: "MONTHLY",
              year: prevYear,
              month: prevMonth,
              workedMinutes: Math.round(workedMinutes),
              expectedMinutes: Math.round(netExpected),
              balanceMinutes,
              carryOver,
              auto: true,
            },
          });

          app.log.info(
            `Auto-Monatsabschluss: ${emp.firstName} ${emp.lastName} — ${prevMonth}/${prevYear} abgeschlossen (${Math.round(workedMinutes / 60)}h Ist, ${Math.round(netExpected / 60)}h Soll)`,
          );
        } catch (err) {
          app.log.error({ err, employeeId: emp.id }, "Auto-Monatsabschluss: Fehler beim Abschluss");
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

            await app.prisma.saldoSnapshot.create({
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

            await app.prisma.overtimeAccount.upsert({
              where: { employeeId: emp.id },
              create: { employeeId: emp.id, balanceHours: appliedCarryOver / 60 },
              update: { balanceHours: appliedCarryOver / 60 },
            });

            await app.audit({
              userId: "SYSTEM",
              action: "CREATE",
              entity: "SaldoSnapshot",
              entityId: emp.id,
              newValue: {
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
            link: "/admin/monatsabschluss",
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
    }
  }

  // Run daily at 06:00
  const task = cron.schedule("0 6 * * *", () => {
    tryAutoCloseMonth().catch((err) =>
      app.log.error({ err }, "Auto-Monatsabschluss fehlgeschlagen"),
    );
  });
  tasks.push(task);
  app.log.info("Auto-Monatsabschluss: Tägliche Prüfung geplant (06:00)");

  app.addHook("onClose", () => {
    tasks.forEach((t) => void t.stop());
  });
});
