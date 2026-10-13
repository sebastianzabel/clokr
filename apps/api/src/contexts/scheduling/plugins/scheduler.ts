import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { withAdvisoryLock, tenantAdvisoryKey } from "../../../utils/with-advisory-lock";
import { syncPhorestForTenant } from "../../../services/phorest/sync-tenant";
import { ACTIVE_TENANT_WHERE } from "../../platform"; // Phase 88 (D-05a)

/**
 * Background scheduler for recurring tasks.
 * Currently: Phorest shift sync (per-tenant cron).
 *
 * Phase 85 (SS-07): the sync body now lives in the ONE shared service
 * services/phorest/sync-shifts.ts — this plugin only owns cron registration and the
 * per-tenant advisory lock. The manual endpoint (routes/integrations.ts) calls the same
 * function, so there is no behavior drift.
 *
 * Phase 65b (issue #65): the lock body calls the ONE orchestrator services/phorest/sync-tenant.ts,
 * which runs the sync once per coupled ACTIVE salon (one PhorestSyncRun each). A tenant without a
 * coupled active salon syncs nothing — the orchestrator logs it.
 */
export const schedulerPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  async function setupSchedules() {
    // Cancel existing tasks
    for (const task of tasks) void task.stop();
    tasks.length = 0;

    // Load all ACTIVE tenants with auto-sync enabled (Phase 88, D-05a: a deactivated tenant is a
    // suspended customer — no Phorest sync). (De)activation refreshes this list.
    const configs = await app.prisma.tenantConfig.findMany({
      where: { phorestAutoSync: true, tenant: ACTIVE_TENANT_WHERE },
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
              // Phase 88 (D-05a, Pitfall 5): tasks registered before a deactivation keep firing until the
              // next refresh, so every run re-checks the tenant itself (cached at most 10 s). It runs
              // inside the lock body so a failing lookup is logged by the catch below.
              if (!(await app.tenantIsActive(cfg.tenantId))) return;
              // Phase 86 (SA-03) / Phase 65b (D-12): per coupled salon, shifts + appointments sync
              // under this ONE tenant lock and record onto that salon's PhorestSyncRun row.
              // Cron actor = SYSTEM (no actorUserId).
              await syncPhorestForTenant(app, cfg.tenantId);
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
