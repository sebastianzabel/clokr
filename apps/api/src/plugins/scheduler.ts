import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { withAdvisoryLock, tenantAdvisoryKey } from "../utils/with-advisory-lock";
import { syncPhorestShifts } from "../services/phorest/sync-shifts";

/**
 * Background scheduler for recurring tasks.
 * Currently: Phorest shift sync (per-tenant cron).
 *
 * Phase 85 (SS-07): the sync body now lives in the ONE shared service
 * services/phorest/sync-shifts.ts — this plugin only owns cron registration and the
 * per-tenant advisory lock. The manual endpoint (routes/integrations.ts) calls the same
 * function, so there is no behavior drift.
 */
export const schedulerPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  async function setupSchedules() {
    // Cancel existing tasks
    for (const task of tasks) void task.stop();
    tasks.length = 0;

    // Load all tenants with auto-sync enabled
    const configs = await app.prisma.tenantConfig.findMany({
      where: { phorestAutoSync: true },
      select: { tenantId: true, phorestSyncCron: true },
    });

    for (const cfg of configs) {
      const cronExpr = cfg.phorestSyncCron ?? "0 3 * * *";
      if (!cron.validate(cronExpr)) {
        app.log.warn({ tenantId: cfg.tenantId, cronExpr }, "Ungültiger Cron-Ausdruck, überspringe");
        continue;
      }

      const task = cron.schedule(
        cronExpr,
        () => {
          // Per-tenant leader lock — each tenant's Phorest sync is independently locked.
          withAdvisoryLock(
            app.prisma,
            tenantAdvisoryKey(cfg.tenantId),
            async () => {
              await syncPhorestShifts(app, cfg.tenantId);
            },
            app.log,
          ).catch((err) => app.log.error({ err, tenantId: cfg.tenantId }, "Scheduler-Fehler"));
        },
        { timezone: "Europe/Berlin", noOverlap: true },
      );
      tasks.push(task);
      app.log.info({ tenantId: cfg.tenantId, cronExpr }, "Phorest Auto-Sync geplant");
    }
  }

  // Initial setup after DB is ready
  app.addHook("onReady", async () => {
    try {
      await setupSchedules();
    } catch (err) {
      app.log.error({ err }, "Scheduler konnte nicht gestartet werden");
    }
  });

  // Cleanup on close
  app.addHook("onClose", async () => {
    for (const task of tasks) void task.stop();
  });

  // Expose for manual re-init (e.g. when config changes)
  app.decorate("refreshScheduler", setupSchedules);
});
