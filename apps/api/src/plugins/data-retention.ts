import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";

/**
 * Data retention scheduler: annually soft-deletes time entries, leave requests,
 * and absences that have exceeded the configured retention period.
 *
 * Prerequisites:
 * - SaldoSnapshots must exist for the affected periods (to preserve saldo integrity)
 * - Only soft-deletes (sets deletedAt), does NOT hard-delete
 *
 * Schedule: Runs on January 2nd at 03:00 (gives a day buffer after New Year)
 * Can also be triggered manually via POST /api/v1/admin/retention/run
 */
export const dataRetentionPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  async function runRetention() {
    app.log.info("Data-Retention: Starte jährliche Aufbewahrungsprüfung");

    const tenants = await app.prisma.tenant.findMany({
      include: { config: true },
    });

    for (const tenant of tenants) {
      const retentionYears = tenant.config?.dataRetentionYears ?? 10;
      if (retentionYears <= 0) continue; // Disabled

      // Cutoff: end of calendar year that is retentionYears ago
      // e.g., retentionYears=10, now=2026 → cutoff = 2015-12-31
      const now = new Date();
      const cutoffYear = now.getFullYear() - retentionYears;
      const cutoffDate = new Date(`${cutoffYear}-12-31T23:59:59.999Z`);

      const employees = await app.prisma.employee.findMany({
        where: { tenantId: tenant.id },
        select: { id: true },
      });
      const employeeIds = employees.map((e) => e.id);

      if (employeeIds.length === 0) continue;

      // Verify snapshots exist for the cutoff period
      // We only archive if there are snapshots covering the data we're about to soft-delete
      const snapshotCount = await app.prisma.saldoSnapshot.count({
        where: {
          employeeId: { in: employeeIds },
          periodEnd: { lte: cutoffDate },
        },
      });

      if (snapshotCount === 0) {
        app.log.warn(
          `Data-Retention: Tenant ${tenant.name} — keine Snapshots vor ${cutoffYear}, überspringe Archivierung`,
        );
        continue;
      }

      // Soft-delete time entries older than retention period
      const archivedEntries = await app.prisma.timeEntry.updateMany({
        where: {
          employeeId: { in: employeeIds },
          deletedAt: null,
          date: { lte: cutoffDate },
        },
        data: { deletedAt: new Date() },
      });

      // Soft-delete leave requests older than retention period
      const archivedLeave = await app.prisma.leaveRequest.updateMany({
        where: {
          employeeId: { in: employeeIds },
          deletedAt: null,
          endDate: { lte: cutoffDate },
        },
        data: { deletedAt: new Date() },
      });

      // Soft-delete absences older than retention period
      const archivedAbsences = await app.prisma.absence.updateMany({
        where: {
          employeeId: { in: employeeIds },
          deletedAt: null,
          endDate: { lte: cutoffDate },
        },
        data: { deletedAt: new Date() },
      });

      const total = archivedEntries.count + archivedLeave.count + archivedAbsences.count;

      if (total > 0) {
        app.log.info(
          `Data-Retention: Tenant ${tenant.name} — ${archivedEntries.count} Zeiteinträge, ${archivedLeave.count} Urlaubsanträge, ${archivedAbsences.count} Abwesenheiten archiviert (vor ${cutoffYear})`,
        );

        await app.audit({
          userId: "SYSTEM",
          action: "ARCHIVE",
          entity: "DataRetention",
          newValue: {
            tenantId: tenant.id,
            cutoffDate: cutoffDate.toISOString(),
            retentionYears,
            archivedEntries: archivedEntries.count,
            archivedLeave: archivedLeave.count,
            archivedAbsences: archivedAbsences.count,
          },
        });
      } else {
        app.log.info(
          `Data-Retention: Tenant ${tenant.name} — keine Daten älter als ${retentionYears} Jahre`,
        );
      }
    }
  }

  // Schedule: January 2nd at 03:00
  const task = cron.schedule("0 3 2 1 *", () => {
    runRetention().catch((err) => app.log.error({ err }, "Data-Retention fehlgeschlagen"));
  });
  tasks.push(task);
  app.log.info("Data-Retention: Jährliche Archivierung geplant (2. Januar, 03:00)");

  // Expose for manual trigger
  (app as any).runRetention = runRetention;

  app.addHook("onClose", () => {
    tasks.forEach((t) => void t.stop());
  });
});
