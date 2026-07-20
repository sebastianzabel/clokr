import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../utils/with-advisory-lock";
import { getTenantTimezone, dateStrInTz, monthRangeUtc, monthDayBounds } from "../utils/timezone";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { fetchCloseMonthData } from "../utils/close-month-data";
import { findMissingWorkdays } from "../utils/find-missing-workdays";

declare module "fastify" {
  interface FastifyInstance {
    /** Phase 76.21-08 (COMP-V1814-08): exposed for integration tests — invokes the
     *  auto-invalidate scan synchronously without the cron/advisory-lock wrapper. */
    tryAutoInvalidate: () => Promise<void>;
    /** Phase 76.28-03 (UX-03): exposed for integration tests — invokes the
     *  end-of-month employee gap reminder scan (Feature 7) without cron/advisory-lock. */
    tryEndOfMonthGapReminder: () => Promise<void>;
    /** Phase 76.28-03 (UX-03): exposed for integration tests — invokes the
     *  beginning-of-month manager gap reminder scan (Feature 8) without cron/advisory-lock. */
    tryBeginningOfMonthGapReminder: () => Promise<void>;
  }
}

/**
 * Background scheduler for attendance-related notifications:
 * 1. Clock-out reminder: hourly check for open time entries
 * 2. Missing entries reminder: daily check for employees without recent entries
 * 3. Auto-invalidate stale open entries: hourly invalidation of entries without clock-out
 */
export const attendanceCheckerPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  /**
   * Feature 1: "Forgot to clock out" — runs every hour.
   * Finds TimeEntries where endTime IS NULL and startTime > X hours ago.
   * Sends one notification per open entry (deduplicates via link field).
   */
  async function checkOpenClockEntries() {
    app.log.info("Attendance-Checker: Prüfe offene Stempelungen");

    try {
      const tenants = await app.prisma.tenant.findMany({
        select: { id: true },
      });

      for (const tenant of tenants) {
        try {
          const cfg = await app.prisma.tenantConfig.findUnique({
            where: { tenantId: tenant.id },
          });
          const thresholdHours = cfg?.clockOutReminderHours ?? 10;
          const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);

          // Find open time entries older than threshold
          const openEntries = await app.prisma.timeEntry.findMany({
            where: {
              deletedAt: null,
              endTime: null,
              startTime: { lt: cutoff },
              employee: { tenantId: tenant.id },
            },
            include: {
              employee: {
                select: { userId: true, firstName: true },
              },
            },
          });

          for (const entry of openEntries) {
            // Deduplicate: check if notification already exists for this time entry
            const existing = await app.prisma.notification.findFirst({
              where: {
                userId: entry.employee.userId,
                type: "CLOCK_OUT_REMINDER",
                link: `/time-entries?highlight=${entry.id}`,
              },
            });

            if (existing) continue;

            const startStr = entry.startTime.toLocaleString("de-DE", {
              timeZone: cfg?.timezone ?? "Europe/Berlin",
              hour: "2-digit",
              minute: "2-digit",
              day: "2-digit",
              month: "2-digit",
            });

            await app.notify({
              userId: entry.employee.userId,
              type: "CLOCK_OUT_REMINDER",
              title: "Offene Stempelung",
              message: `Du bist seit ${startStr} eingestempelt. Bitte Arbeitszeit korrigieren.`,
              link: `/time-entries?highlight=${entry.id}`,
              relatedType: "TimeEntry",
              relatedId: entry.id,
            });

            app.log.info(
              { userId: entry.employee.userId, timeEntryId: entry.id },
              "Clock-out Erinnerung gesendet",
            );
          }
        } catch (err) {
          app.log.error({ err, tenant: tenant.id }, "Clock-out: Tenant fehlgeschlagen, fahre fort");
          continue;
        }
      }
    } catch (err) {
      app.log.error({ err }, "Attendance-Checker: Fehler bei offene Stempelungen");
    }
  }

  /**
   * Feature 2: "No time entries" — runs daily at 09:00.
   * Finds active employees with no time entries in the last X days.
   * Notifies both the employee and their managers.
   */
  async function checkMissingEntries() {
    app.log.info("Attendance-Checker: Prüfe fehlende Zeiteinträge");

    try {
      const tenants = await app.prisma.tenant.findMany({
        select: { id: true },
      });

      for (const tenant of tenants) {
        try {
          const cfg = await app.prisma.tenantConfig.findUnique({
            where: { tenantId: tenant.id },
          });
          const dayThreshold = cfg?.missingEntriesDays ?? 7;
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - dayThreshold);

          // Find all active employees for this tenant
          const employees = await app.prisma.employee.findMany({
            where: {
              tenantId: tenant.id,
              user: { isActive: true },
              exitDate: null,
            },
            include: {
              user: { select: { id: true, role: true } },
            },
          });

          // Find managers for this tenant
          const managers = employees.filter(
            (e) => e.user.role === "ADMIN" || e.user.role === "MANAGER",
          );

          for (const emp of employees) {
            // Count time entries in the last X days
            const recentEntryCount = await app.prisma.timeEntry.count({
              where: {
                employeeId: emp.id,
                deletedAt: null,
                date: { gte: cutoffDate },
              },
            });

            if (recentEntryCount > 0) continue;

            // Deduplicate: check if notification sent within last 7 days
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const existingNotification = await app.prisma.notification.findFirst({
              where: {
                userId: emp.user.id,
                type: "MISSING_ENTRIES",
                createdAt: { gte: sevenDaysAgo },
              },
            });

            if (existingNotification) continue;

            // Notify the employee
            await app.notify({
              userId: emp.user.id,
              type: "MISSING_ENTRIES",
              title: "Fehlende Zeiteinträge",
              message: `Du hast seit ${dayThreshold} Tagen keine Zeiteinträge erfasst.`,
              link: "/time-entries",
            });

            app.log.info(
              { userId: emp.user.id, employeeId: emp.id },
              "Fehlende-Einträge Erinnerung gesendet",
            );

            // Notify managers about this employee
            for (const mgr of managers) {
              if (mgr.user.id === emp.user.id) continue; // Don't notify manager about themselves

              // Deduplicate manager notification too
              const existingMgrNotif = await app.prisma.notification.findFirst({
                where: {
                  userId: mgr.user.id,
                  type: "MISSING_ENTRIES",
                  message: { contains: `${emp.firstName} ${emp.lastName}` },
                  createdAt: { gte: sevenDaysAgo },
                },
              });

              if (existingMgrNotif) continue;

              await app.notify({
                userId: mgr.user.id,
                type: "MISSING_ENTRIES",
                title: "Fehlende Zeiteinträge",
                message: `${emp.firstName} ${emp.lastName} hat seit ${dayThreshold} Tagen keine Zeiteinträge erfasst.`,
                link: "/time-entries",
              });
            }
          }
        } catch (err) {
          app.log.error(
            { err, tenant: tenant.id },
            "Fehlende-Einträge: Tenant fehlgeschlagen, fahre fort",
          );
          continue;
        }
      }
    } catch (err) {
      app.log.error({ err }, "Attendance-Checker: Fehler bei fehlende Einträge");
    }
  }

  /**
   * Feature 3: "Auto-invalidate stale open entries" — runs every hour.
   * Finds TimeEntries where endTime IS NULL and startTime > X hours ago and isInvalid = false.
   * Marks each entry as invalid and notifies the employee + managers/admins.
   */
  async function autoInvalidateOpenEntries() {
    app.log.info("Attendance-Checker: Prüfe veraltete offene Einträge");

    try {
      const tenants = await app.prisma.tenant.findMany({
        select: { id: true },
      });

      for (const tenant of tenants) {
        try {
          const cfg = await app.prisma.tenantConfig.findUnique({
            where: { tenantId: tenant.id },
          });
          const autoDeleteHours = cfg?.autoDeleteOpenHours ?? 14;
          if (autoDeleteHours === 0) continue; // Feature disabled for this tenant

          const cutoff = new Date(Date.now() - autoDeleteHours * 60 * 60 * 1000);

          // Find open, non-invalid time entries older than threshold
          const openEntries = await app.prisma.timeEntry.findMany({
            where: {
              deletedAt: null,
              endTime: null,
              startTime: { lt: cutoff },
              isInvalid: false,
              isLocked: false, // COMP-V1814-08: never invalidate locked entries (Revisionssicherheit)
              employee: { tenantId: tenant.id },
            },
            include: {
              employee: {
                select: {
                  id: true,
                  userId: true,
                  firstName: true,
                  lastName: true,
                  tenantId: true,
                },
              },
            },
          });

          if (openEntries.length === 0) continue;

          // Find managers/admins for this tenant
          const managers = await app.prisma.employee.findMany({
            where: {
              tenantId: tenant.id,
              user: { isActive: true, role: { in: ["ADMIN", "MANAGER"] } },
            },
            include: { user: { select: { id: true } } },
          });

          for (const entry of openEntries) {
            const startStr = entry.startTime.toLocaleString("de-DE", {
              timeZone: cfg?.timezone ?? "Europe/Berlin",
              day: "2-digit",
              month: "2-digit",
            });

            // Invalidate the entry instead of deleting
            await app.prisma.timeEntry.update({
              where: { id: entry.id },
              data: {
                isInvalid: true,
                invalidReason: "Ausstempeln fehlt",
              },
            });

            // Audit log
            await app.audit({
              userId: undefined,
              action: "UPDATE",
              entity: "TimeEntry",
              entityId: entry.id,
              oldValue: { isInvalid: false },
              newValue: { origin: "SYSTEM", isInvalid: true, invalidReason: "Ausstempeln fehlt" },
            });

            // Notify the employee
            await app.notify({
              userId: entry.employee.userId,
              type: "OPEN_ENTRY_INVALIDATED",
              title: "Zeiteintrag invalidiert",
              message: `Dein Eintrag vom ${startStr} wurde automatisch invalidiert, da kein Ausstempeln erfolgte. Bitte trage die Endzeit manuell nach.`,
              link: `/time-entries?highlight=${entry.id}`,
            });

            // Notify managers/admins
            for (const mgr of managers) {
              if (mgr.user.id === entry.employee.userId) continue;

              await app.notify({
                userId: mgr.user.id,
                type: "OPEN_ENTRY_INVALIDATED",
                title: "Zeiteintrag invalidiert",
                message: `Der Eintrag von ${entry.employee.firstName} ${entry.employee.lastName} vom ${startStr} wurde automatisch invalidiert (kein Ausstempeln).`,
                link: "/time-entries",
              });
            }

            app.log.info(
              { userId: entry.employee.userId, timeEntryId: entry.id },
              "Offener Zeiteintrag automatisch invalidiert",
            );
          }
        } catch (err) {
          app.log.error(
            { err, tenant: tenant.id },
            "Auto-Invalidierung: Tenant fehlgeschlagen, fahre fort",
          );
          continue;
        }
      }
    } catch (err) {
      app.log.error({ err }, "Attendance-Checker: Fehler bei Auto-Invalidierung offener Einträge");
    }
  }

  /**
   * Feature 4: Pending leave request reminder — runs daily at 09:00.
   * Reminds managers about leave requests that have been PENDING for too long.
   */
  async function checkPendingLeaveRequests() {
    app.log.info("Reminder: Prüfe offene Urlaubsanträge");
    try {
      const tenants = await app.prisma.tenant.findMany({ select: { id: true } });
      for (const tenant of tenants) {
        try {
          const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id } });
          if (!cfg?.reminderPendingLeaveEnabled) continue;

          const thresholdHours = cfg.reminderPendingLeaveHours ?? 48;
          const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);

          const pendingRequests = await app.prisma.leaveRequest.findMany({
            where: {
              deletedAt: null,
              status: "PENDING",
              createdAt: { lt: cutoff },
              employee: { tenantId: tenant.id },
            },
            include: {
              employee: { select: { firstName: true, lastName: true } },
              leaveType: { select: { name: true } },
            },
          });

          if (pendingRequests.length === 0) continue;

          const managers = await app.prisma.user.findMany({
            where: {
              role: { in: ["ADMIN", "MANAGER"] },
              isActive: true,
              employee: { tenantId: tenant.id },
            },
            select: { id: true },
          });

          for (const req of pendingRequests) {
            for (const mgr of managers) {
              const existing = await app.prisma.notification.findFirst({
                where: {
                  userId: mgr.id,
                  type: "PENDING_LEAVE_REMINDER",
                  link: `/leave?request=${req.id}`,
                },
              });
              if (existing) continue;

              await app.notify({
                userId: mgr.id,
                type: "PENDING_LEAVE_REMINDER",
                title: "Offener Urlaubsantrag",
                message: `${req.employee.firstName} ${req.employee.lastName}: ${req.leaveType.name} wartet seit über ${thresholdHours}h auf Genehmigung.`,
                link: `/leave?request=${req.id}`,
                tenantId: tenant.id,
              });
            }
          }
        } catch (err) {
          app.log.error(
            { err, tenant: tenant.id },
            "Offene-Anträge: Tenant fehlgeschlagen, fahre fort",
          );
          continue;
        }
      }
    } catch (err) {
      app.log.error({ err }, "Reminder: Fehler bei offenen Urlaubsanträgen");
    }
  }

  /**
   * Feature 5: Upcoming absence reminder — runs daily at 09:00.
   * Reminds employees about their approved absences starting soon.
   */
  async function checkUpcomingAbsences() {
    app.log.info("Reminder: Prüfe bevorstehende Abwesenheiten");
    try {
      const tenants = await app.prisma.tenant.findMany({ select: { id: true } });
      for (const tenant of tenants) {
        try {
          const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id } });
          if (!cfg?.reminderUpcomingAbsenceEnabled) continue;

          const daysAhead = cfg.reminderUpcomingAbsenceDays ?? 3;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const targetDate = new Date(today);
          targetDate.setDate(targetDate.getDate() + daysAhead);

          const upcoming = await app.prisma.leaveRequest.findMany({
            where: {
              deletedAt: null,
              status: "APPROVED",
              startDate: { gte: today, lte: targetDate },
              employee: { tenantId: tenant.id },
            },
            include: {
              employee: { select: { userId: true, firstName: true } },
              leaveType: { select: { name: true } },
            },
          });

          for (const req of upcoming) {
            const startStr = req.startDate.toLocaleDateString("de-DE", {
              day: "2-digit",
              month: "2-digit",
            });
            const dedupLink = `/leave?request=${req.id}&reminder=upcoming`;

            const existing = await app.prisma.notification.findFirst({
              where: { userId: req.employee.userId, type: "UPCOMING_ABSENCE", link: dedupLink },
            });
            if (existing) continue;

            await app.notify({
              userId: req.employee.userId,
              type: "UPCOMING_ABSENCE",
              title: "Bevorstehende Abwesenheit",
              message: `Dein ${req.leaveType.name} beginnt am ${startStr}.`,
              link: dedupLink,
              tenantId: tenant.id,
            });
          }
        } catch (err) {
          app.log.error(
            { err, tenant: tenant.id },
            "Bevorstehende-Abwesenheiten: Tenant fehlgeschlagen, fahre fort",
          );
          continue;
        }
      }
    } catch (err) {
      app.log.error({ err }, "Reminder: Fehler bei bevorstehenden Abwesenheiten");
    }
  }

  /**
   * Feature 6: Vacation expiry reminder (Hinweispflicht § 7 BUrlG / EuGH C-684/16).
   * Runs daily. In Q4 (from configured month), warns employees about expiring vacation.
   */
  async function checkVacationExpiry() {
    app.log.info("Reminder: Prüfe verfallenden Urlaub");
    try {
      const currentMonth = new Date().getMonth() + 1; // 1-12
      const currentYear = new Date().getFullYear();

      const tenants = await app.prisma.tenant.findMany({ select: { id: true } });
      for (const tenant of tenants) {
        try {
          const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id } });
          const startMonth = cfg?.vacationReminderStartMonth ?? 10;
          if (currentMonth < startMonth) continue;

          // Find employees with unused vacation this year
          const entitlements = await app.prisma.leaveEntitlement.findMany({
            where: {
              year: currentYear,
              employee: { tenantId: tenant.id },
              leaveType: { name: "Urlaub" },
            },
            include: {
              employee: { select: { id: true, userId: true, firstName: true } },
            },
          });

          for (const ent of entitlements) {
            const total = Number(ent.totalDays) + Number(ent.carriedOverDays);
            const used = Number(ent.usedDays);
            const remaining = total - used;
            if (remaining <= 0) continue;

            // Deduplicate: one reminder per month
            const dedupLink = `/leave?reminder=expiry-${currentYear}-${currentMonth}`;
            const existing = await app.prisma.notification.findFirst({
              where: { userId: ent.employee.userId, type: "VACATION_EXPIRY", link: dedupLink },
            });
            if (existing) continue;

            const urgency =
              currentMonth >= 12 ? "Letzter Monat" : currentMonth >= 11 ? "Dringend" : "Hinweis";

            await app.notify({
              userId: ent.employee.userId,
              type: "VACATION_EXPIRY",
              title: `${urgency}: ${remaining} Urlaubstage verfallen bald`,
              message: `Du hast noch ${remaining} Urlaubstage in ${currentYear}. Nicht genommener Urlaub verfällt am ${cfg?.carryOverDeadlineDay ?? 31}.${cfg?.carryOverDeadlineMonth ?? 3}.${currentYear + 1}.`,
              link: dedupLink,
              tenantId: tenant.id,
            });
          }
        } catch (err) {
          app.log.error(
            { err, tenant: tenant.id },
            "Urlaubsverfall: Tenant fehlgeschlagen, fahre fort",
          );
          continue;
        }
      }
    } catch (err) {
      app.log.error({ err }, "Reminder: Fehler bei Urlaubsverfall-Prüfung");
    }
  }

  /**
   * Feature 7: End-of-month gap reminder (employee) — runs daily at 09:00.
   * Active only during the last 3 days of the month (daysUntilMonthEnd <= 2).
   * Notifies employees with open gaps in the current month via GAP_WARNING_EMPLOYEE.
   * Excludes isTimeTrackingExempt + FLEXTIME/MONTHLY_HOURS employees (no daily gap).
   * Deduplicates via 7-day window.
   */
  async function checkEndOfMonthGaps() {
    app.log.info("Attendance-Checker: Prüfe Monatsend-Lückenerinnerungen (Feature 7)");
    try {
      const now = new Date();
      const tenants = await app.prisma.tenant.findMany({ select: { id: true } });

      for (const tenant of tenants) {
        try {
          const tz = await getTenantTimezone(app.prisma, tenant.id);
          const todayStr = dateStrInTz(now, tz);
          const [todayYear, todayMonth] = todayStr.split("-").map(Number);

          // Determine last day of current month in tenant TZ
          const lastDayOfMonth = new Date(todayYear, todayMonth, 0).getDate();
          const todayDayOfMonth = parseInt(todayStr.split("-")[2], 10);
          const daysUntilMonthEnd = lastDayOfMonth - todayDayOfMonth;

          // Only act in the last 3 days of the month (day >= lastDay - 2)
          if (daysUntilMonthEnd > 2) continue;

          const { start: monthStart, end: monthEnd } = monthRangeUtc(todayYear, todayMonth, tz);
          const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
            monthStart,
            monthEnd,
            tz,
          );

          // Load active, non-exempt employees for this tenant
          const employees = await app.prisma.employee.findMany({
            where: {
              tenantId: tenant.id,
              isTimeTrackingExempt: false,
              user: { isActive: true },
              exitDate: null,
            },
            include: {
              user: { select: { id: true } },
              workSchedules: { orderBy: { validFrom: "desc" } },
              tenant: { select: { federalState: true } },
            },
          });

          if (employees.length === 0) continue;

          const stateCode =
            STATE_MAP[employees[0]?.tenant?.federalState ?? "NIEDERSACHSEN"] ?? "NI";
          const holidayDateStrings = new Set<string>(
            getHolidays(todayYear, stateCode).map((h) => h.date),
          );
          const employeeIds = employees.map((e) => e.id);
          const {
            entriesByEmp,
            leaveByEmp,
            absencesByEmp,
            holidays: dbHolidays,
          } = await fetchCloseMonthData(app.prisma, tenant.id, employeeIds, monthStart, monthEnd);
          for (const h of dbHolidays) {
            holidayDateStrings.add(dateStrInTz(h.date, tz));
          }

          const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          const monthLabel = new Date(todayYear, todayMonth - 1, 1).toLocaleDateString("de-DE", {
            month: "long",
            year: "numeric",
          });

          for (const emp of employees) {
            // Skip employees hired after this month
            if (emp.hireDate > monthEnd) continue;

            const schedule = emp.workSchedules[0];
            if (!schedule) continue;

            // FLEXTIME / MONTHLY_HOURS: no daily gap rule (D-01)
            const scheduleType = String(schedule.type ?? "");
            if (scheduleType === "MONTHLY_HOURS" || scheduleType === "FLEXTIME") continue;

            // Build gap inputs (mirrors overtime.ts:356-397)
            const entries = entriesByEmp.get(emp.id) ?? [];
            const entryDates = new Set(entries.map((e) => dateStrInTz(e.date, tz)));
            const approvedLeave = leaveByEmp.get(emp.id) ?? [];
            const absences = absencesByEmp.get(emp.id) ?? [];

            let rosterDates: Set<string> | undefined;
            if (scheduleType === "SHIFT_BASED") {
              const shifts = await app.prisma.shift.findMany({
                where: {
                  employeeId: emp.id,
                  date: { gte: monthStart, lte: monthLastDay },
                  deletedAt: null,
                },
                select: { date: true },
              });
              rosterDates = new Set(shifts.map((sh) => dateStrInTz(sh.date, tz)));
            }

            const effectiveStart = emp.hireDate > monthFirstDay ? emp.hireDate : monthFirstDay;

            const { gaps } = findMissingWorkdays({
              schedule: schedule as Record<string, unknown>,
              effectiveStart,
              effectiveEnd: monthLastDay,
              tz,
              entryDates,
              approvedLeave: approvedLeave.map((lr) => ({
                startDate: lr.startDate,
                endDate: lr.endDate,
                halfDay: Boolean(lr.halfDay),
              })),
              absences: absences.map((ab) => ({ startDate: ab.startDate, endDate: ab.endDate })),
              holidayDateStrings,
              rosterDates,
            });

            if (gaps.length === 0) continue;

            // 7-day dedup: skip if already notified this window
            const existing = await app.prisma.notification.findFirst({
              where: {
                userId: emp.user.id,
                type: "GAP_WARNING_EMPLOYEE",
                createdAt: { gte: sevenDaysAgo },
              },
            });
            if (existing) continue;

            const dayWord = gaps.length === 1 ? "Tag" : "Tage";
            await app.notify({
              userId: emp.user.id,
              type: "GAP_WARNING_EMPLOYEE",
              title: "Fehlende Zeiteinträge vor Monatsabschluss",
              message: `Du hast ${gaps.length} ${dayWord} ohne Eintrag in ${monthLabel}. Trage diese nach, bevor der Monat abgeschlossen wird.`,
              link: `/time-entries?month=${todayYear}-${String(todayMonth).padStart(2, "0")}&reminder=gap`,
              tenantId: tenant.id,
            });

            app.log.info(
              { userId: emp.user.id, employeeId: emp.id, gapCount: gaps.length },
              "Monatsend-Lückenerinnerung gesendet (Feature 7)",
            );
          }
        } catch (err) {
          app.log.error(
            { err, tenant: tenant.id },
            "Monatsend-Lücken: Tenant fehlgeschlagen, fahre fort",
          );
          continue;
        }
      }
    } catch (err) {
      app.log.error({ err }, "Attendance-Checker: Fehler bei Monatsend-Lückenerinnerungen");
    }
  }

  /**
   * Feature 8: Beginning-of-month gap reminder (manager) — runs daily at 09:00.
   * Active only during the first 3 days of the month (dayOfMonth <= 3).
   * Notifies managers/admins about employees with gaps in the PREVIOUS month.
   * Deduplicates via 7-day window.
   */
  async function checkBeginningOfMonthGaps() {
    app.log.info("Attendance-Checker: Prüfe Monatsanfang-Lückenerinnerungen (Feature 8)");
    try {
      const now = new Date();
      const tenants = await app.prisma.tenant.findMany({ select: { id: true } });

      for (const tenant of tenants) {
        try {
          const tz = await getTenantTimezone(app.prisma, tenant.id);
          const todayStr = dateStrInTz(now, tz);
          const todayDayOfMonth = parseInt(todayStr.split("-")[2], 10);

          // Only act on days 1-3 of the month
          if (todayDayOfMonth > 3) continue;

          const [todayYear, todayMonth] = todayStr.split("-").map(Number);

          // Compute previous month
          const prevMonth = todayMonth === 1 ? 12 : todayMonth - 1;
          const prevYear = todayMonth === 1 ? todayYear - 1 : todayYear;

          const { start: prevMonthStart, end: prevMonthEnd } = monthRangeUtc(
            prevYear,
            prevMonth,
            tz,
          );
          const { firstDay: prevMonthFirstDay, lastDay: prevMonthLastDay } = monthDayBounds(
            prevMonthStart,
            prevMonthEnd,
            tz,
          );

          // Load active, non-exempt employees
          const employees = await app.prisma.employee.findMany({
            where: {
              tenantId: tenant.id,
              isTimeTrackingExempt: false,
              user: { isActive: true },
            },
            include: {
              user: { select: { id: true } },
              workSchedules: { orderBy: { validFrom: "desc" } },
              tenant: { select: { federalState: true } },
            },
          });

          if (employees.length === 0) continue;

          const stateCode =
            STATE_MAP[employees[0]?.tenant?.federalState ?? "NIEDERSACHSEN"] ?? "NI";
          const holidayDateStrings = new Set<string>(
            getHolidays(prevYear, stateCode).map((h) => h.date),
          );
          const employeeIds = employees.map((e) => e.id);
          const {
            entriesByEmp,
            leaveByEmp,
            absencesByEmp,
            holidays: dbHolidays,
          } = await fetchCloseMonthData(
            app.prisma,
            tenant.id,
            employeeIds,
            prevMonthStart,
            prevMonthEnd,
          );
          for (const h of dbHolidays) {
            holidayDateStrings.add(dateStrInTz(h.date, tz));
          }

          // Find managers/admins for this tenant
          const managers = await app.prisma.employee.findMany({
            where: {
              tenantId: tenant.id,
              user: { isActive: true, role: { in: ["ADMIN", "MANAGER"] } },
            },
            include: { user: { select: { id: true } } },
          });

          if (managers.length === 0) continue;

          // Count employees with gaps in the previous month
          let gapEmployeeCount = 0;

          for (const emp of employees) {
            // Skip hired after prev month ended
            if (emp.hireDate > prevMonthEnd) continue;

            const schedule = emp.workSchedules[0];
            if (!schedule) continue;

            const scheduleType = String(schedule.type ?? "");
            if (scheduleType === "MONTHLY_HOURS" || scheduleType === "FLEXTIME") continue;

            const entries = entriesByEmp.get(emp.id) ?? [];
            const entryDates = new Set(entries.map((e) => dateStrInTz(e.date, tz)));
            const approvedLeave = leaveByEmp.get(emp.id) ?? [];
            const absences = absencesByEmp.get(emp.id) ?? [];

            let rosterDates: Set<string> | undefined;
            if (scheduleType === "SHIFT_BASED") {
              const shifts = await app.prisma.shift.findMany({
                where: {
                  employeeId: emp.id,
                  date: { gte: prevMonthStart, lte: prevMonthLastDay },
                  deletedAt: null,
                },
                select: { date: true },
              });
              rosterDates = new Set(shifts.map((sh) => dateStrInTz(sh.date, tz)));
            }

            const effectiveStart =
              emp.hireDate > prevMonthFirstDay ? emp.hireDate : prevMonthFirstDay;

            const { gaps } = findMissingWorkdays({
              schedule: schedule as Record<string, unknown>,
              effectiveStart,
              effectiveEnd: prevMonthLastDay,
              tz,
              entryDates,
              approvedLeave: approvedLeave.map((lr) => ({
                startDate: lr.startDate,
                endDate: lr.endDate,
                halfDay: Boolean(lr.halfDay),
              })),
              absences: absences.map((ab) => ({ startDate: ab.startDate, endDate: ab.endDate })),
              holidayDateStrings,
              rosterDates,
            });

            if (gaps.length > 0) gapEmployeeCount++;
          }

          if (gapEmployeeCount === 0) continue;

          const prevMonthLabel = new Date(prevYear, prevMonth - 1, 1).toLocaleDateString("de-DE", {
            month: "long",
          });
          const mitarbeiterWord = gapEmployeeCount === 1 ? "Mitarbeiter hat" : "Mitarbeiter haben";
          const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

          for (const mgr of managers) {
            // 7-day dedup per manager
            const existing = await app.prisma.notification.findFirst({
              where: {
                userId: mgr.user.id,
                type: "GAP_WARNING_MANAGER",
                createdAt: { gte: sevenDaysAgo },
              },
            });
            if (existing) continue;

            await app.notify({
              userId: mgr.user.id,
              type: "GAP_WARNING_MANAGER",
              title: "Monatsabschluss mit Lücken",
              message: `${gapEmployeeCount} ${mitarbeiterWord} im ${prevMonthLabel} ${prevYear} Lücken. Bitte Monatsabschluss prüfen.`,
              link: `/admin/month-close?year=${prevYear}&month=${prevMonth}&reminder=gap`,
              tenantId: tenant.id,
            });

            app.log.info(
              { userId: mgr.user.id, gapEmployeeCount },
              "Monatsanfang-Lückenerinnerung gesendet (Feature 8)",
            );
          }
        } catch (err) {
          app.log.error(
            { err, tenant: tenant.id },
            "Monatsanfang-Lücken: Tenant fehlgeschlagen, fahre fort",
          );
          continue;
        }
      }
    } catch (err) {
      app.log.error({ err }, "Attendance-Checker: Fehler bei Monatsanfang-Lückenerinnerungen");
    }
  }

  // Phase 76.21-08: expose autoInvalidateOpenEntries as a Fastify decorator so
  // integration tests can invoke the scan directly without cron/advisory-lock overhead.
  // Pattern mirrors tryAutoCloseMonth in auto-close-month.ts.
  app.decorate("tryAutoInvalidate", autoInvalidateOpenEntries);

  // Phase 76.28-03 (UX-03): expose gap reminder functions as decorators for test invocability.
  // Pattern mirrors tryAutoInvalidate above.
  app.decorate("tryEndOfMonthGapReminder", checkEndOfMonthGaps);
  app.decorate("tryBeginningOfMonthGapReminder", checkBeginningOfMonthGaps);

  app.addHook("onReady", async () => {
    try {
      // Clock-out check: every hour at minute 0
      const clockOutTask = cron.schedule(
        "0 * * * *",
        () => {
          withAdvisoryLock(
            app.prisma,
            ADVISORY_LOCK_KEYS.ATTENDANCE_CLOCK_OUT,
            () => checkOpenClockEntries(),
            app.log,
          ).catch((err) =>
            app.log.error({ err }, "Attendance-Checker: Clock-out Job fehlgeschlagen"),
          );
        },
        { timezone: "Europe/Berlin", noOverlap: true },
      );
      tasks.push(clockOutTask);
      app.log.info("Attendance-Checker: Clock-out Erinnerung geplant (stündlich)");

      // Auto-invalidate stale open entries: every hour at minute 0
      const autoInvalidateTask = cron.schedule(
        "0 * * * *",
        () => {
          withAdvisoryLock(
            app.prisma,
            ADVISORY_LOCK_KEYS.ATTENDANCE_AUTO_INVALIDATE,
            () => autoInvalidateOpenEntries(),
            app.log,
          ).catch((err) =>
            app.log.error({ err }, "Attendance-Checker: Auto-Invalidierung Job fehlgeschlagen"),
          );
        },
        { timezone: "Europe/Berlin", noOverlap: true },
      );
      tasks.push(autoInvalidateTask);
      app.log.info("Attendance-Checker: Auto-Invalidierung offener Einträge geplant (stündlich)");

      // Missing entries check: daily at 09:00
      const missingTask = cron.schedule(
        "0 9 * * *",
        () => {
          withAdvisoryLock(
            app.prisma,
            ADVISORY_LOCK_KEYS.ATTENDANCE_MISSING,
            () => checkMissingEntries(),
            app.log,
          ).catch((err) =>
            app.log.error({ err }, "Attendance-Checker: Fehlende-Einträge Job fehlgeschlagen"),
          );
        },
        { timezone: "Europe/Berlin", noOverlap: true },
      );
      tasks.push(missingTask);
      app.log.info("Attendance-Checker: Fehlende-Einträge Erinnerung geplant (täglich 09:00)");

      // Pending leave requests: daily at 09:15
      const pendingLeaveTask = cron.schedule(
        "15 9 * * *",
        () => {
          withAdvisoryLock(
            app.prisma,
            ADVISORY_LOCK_KEYS.ATTENDANCE_PENDING_LEAVE,
            () => checkPendingLeaveRequests(),
            app.log,
          ).catch((err) => app.log.error({ err }, "Reminder: Offene-Anträge Job fehlgeschlagen"));
        },
        { timezone: "Europe/Berlin", noOverlap: true },
      );
      tasks.push(pendingLeaveTask);
      app.log.info("Reminder: Offene Urlaubsanträge geplant (täglich 09:15)");

      // Upcoming absences: daily at 08:00
      const upcomingTask = cron.schedule(
        "0 8 * * *",
        () => {
          withAdvisoryLock(
            app.prisma,
            ADVISORY_LOCK_KEYS.ATTENDANCE_UPCOMING,
            () => checkUpcomingAbsences(),
            app.log,
          ).catch((err) =>
            app.log.error({ err }, "Reminder: Bevorstehende-Abwesenheiten Job fehlgeschlagen"),
          );
        },
        { timezone: "Europe/Berlin", noOverlap: true },
      );
      tasks.push(upcomingTask);
      app.log.info("Reminder: Bevorstehende Abwesenheiten geplant (täglich 08:00)");

      // Vacation expiry: daily at 10:00
      const expiryTask = cron.schedule(
        "0 10 * * *",
        () => {
          withAdvisoryLock(
            app.prisma,
            ADVISORY_LOCK_KEYS.ATTENDANCE_EXPIRY,
            () => checkVacationExpiry(),
            app.log,
          ).catch((err) => app.log.error({ err }, "Reminder: Urlaubsverfall Job fehlgeschlagen"));
        },
        { timezone: "Europe/Berlin", noOverlap: true },
      );
      tasks.push(expiryTask);
      app.log.info("Reminder: Urlaubsverfall-Prüfung geplant (täglich 10:00)");

      // Feature 7: End-of-month employee gap reminder — daily at 09:00, window-gated (last 3 days)
      const endOfMonthGapTask = cron.schedule(
        "0 9 * * *",
        () => {
          withAdvisoryLock(
            app.prisma,
            ADVISORY_LOCK_KEYS.ATTENDANCE_GAP_EMPLOYEE,
            () => checkEndOfMonthGaps(),
            app.log,
          ).catch((err) => app.log.error({ err }, "Reminder: Monatsend-Lücken Job fehlgeschlagen"));
        },
        { timezone: "Europe/Berlin", noOverlap: true },
      );
      tasks.push(endOfMonthGapTask);
      app.log.info("Reminder: Monatsend-Lückenerinnerung geplant (täglich 09:00, letzte 3 Tage)");

      // Feature 8: Beginning-of-month manager gap reminder — daily at 09:00, window-gated (first 3 days)
      const beginningOfMonthGapTask = cron.schedule(
        "0 9 * * *",
        () => {
          withAdvisoryLock(
            app.prisma,
            ADVISORY_LOCK_KEYS.ATTENDANCE_GAP_MANAGER,
            () => checkBeginningOfMonthGaps(),
            app.log,
          ).catch((err) =>
            app.log.error({ err }, "Reminder: Monatsanfang-Lücken Job fehlgeschlagen"),
          );
        },
        { timezone: "Europe/Berlin", noOverlap: true },
      );
      tasks.push(beginningOfMonthGapTask);
      app.log.info("Reminder: Monatsanfang-Lückenerinnerung geplant (täglich 09:00, erste 3 Tage)");
    } catch (err) {
      app.log.error({ err }, "Attendance-Checker konnte nicht gestartet werden");
    }
  });

  app.addHook("onClose", async () => {
    for (const task of tasks) void task.stop();
  });
});
