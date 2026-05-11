import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";

declare module "fastify" {
  interface FastifyInstance {
    runRetention?: () => Promise<void>;
    runPurgeableAuditLogs?: () => Promise<void>;
  }
}

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

  // ── Purgeable AuditLog Purge ────────────────────────────────────────────────
  // DSGVO Art. 5(1)(e) Datensparsamkeit: WiFi-Presence-only AuditLog entries
  // (purgeable=true) that never produced a TimeEntry are not payroll-relevant
  // and must not accumulate indefinitely. Entries with purgeable=true are purged
  // after the configured window. §147 AO 10-year retention applies only to
  // payroll-relevant entries (purgeable=false). Ref: Phase 25 CONTEXT.md.
  async function runPurgeableAuditLogs() {
    app.log.info("AuditLog-Purge: Starte Bereinigung purgeable Einträge");

    // Determine the minimum configured retention across all tenants.
    // AuditLog has no tenantId column, so we apply the shortest window
    // (most privacy-preserving) as the global cutoff.
    const tenants = await app.prisma.tenant.findMany({
      include: { config: true },
    });

    // Default to 90 days if no tenant has a custom config.
    // WR-03: purgeableAuditRetentionDays is not yet a schema field — the cast
    // below always resolves to undefined, so the fallback of 90 is always used.
    // A safety floor of 7 days is applied as a defence-in-depth measure: a single
    // misconfigured tenant (value=1) cannot cause all purgeable audit logs across
    // ALL tenants to be purged after 1 day (AuditLog has no tenantId column).
    const PURGEABLE_MIN_FLOOR_DAYS = 7; // Never purge in less than 7 days regardless of config
    const minRetentionDays = Math.max(
      PURGEABLE_MIN_FLOOR_DAYS,
      tenants.reduce<number>((min, t) => {
        const configured =
          (t.config as { purgeableAuditRetentionDays?: number } | null)
            ?.purgeableAuditRetentionDays ?? 90;
        return Math.min(min, Math.max(1, configured));
      }, 90),
    );

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - minRetentionDays);

    const result = await app.prisma.auditLog.deleteMany({
      where: {
        purgeable: true,
        createdAt: { lt: cutoff },
      },
    });

    app.log.info(
      `AuditLog-Purge: ${result.count} purgeable Einträge gelöscht (Cutoff: ${cutoff.toISOString()}, Fenster: ${minRetentionDays} Tage)`,
    );
  }

  // Schedule: January 2nd at 03:00
  const task = cron.schedule("0 3 2 1 *", () => {
    runRetention().catch((err) => app.log.error({ err }, "Data-Retention fehlgeschlagen"));
  });
  tasks.push(task);
  app.log.info("Data-Retention: Jährliche Archivierung geplant (2. Januar, 03:00)");

  // Daily purgeable AuditLog purge — 03:00 every day
  const purgeTask = cron.schedule("0 3 * * *", () => {
    runPurgeableAuditLogs().catch((err) => app.log.error({ err }, "AuditLog-Purge fehlgeschlagen"));
  });
  tasks.push(purgeTask);
  app.log.info("AuditLog-Purge: Tägl. Bereinigung geplant (03:00)");

  // Expose for manual trigger
  app.decorate("runRetention", runRetention);
  app.decorate("runPurgeableAuditLogs", runPurgeableAuditLogs);

  app.addHook("onClose", () => {
    tasks.forEach((t) => void t.stop());
  });
});
