import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { decryptSafe } from "../utils/crypto";

/**
 * Background scheduler for recurring tasks.
 * Currently: Phorest shift sync (per-tenant cron).
 */
export const schedulerPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  async function syncPhorestForTenant(tenantId: string) {
    const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
    if (
      !cfg?.phorestBusinessId ||
      !cfg?.phorestUsername ||
      !cfg?.phorestPassword ||
      !cfg?.phorestAutoSync
    ) {
      return;
    }

    const baseUrl = cfg.phorestBaseUrl ?? "https://api.phorest.com/third-party-api-server";
    const biz = cfg.phorestBusinessId;
    const branch = cfg.phorestBranchId;

    app.log.info({ tenantId }, "Phorest Auto-Sync gestartet");

    try {
      const phorestPwd = decryptSafe(cfg.phorestPassword) ?? "";
      const auth = Buffer.from(`global/${cfg.phorestUsername}:${phorestPwd}`).toString("base64");
      const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };

      // Sync next 7 days
      const today = new Date();
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 7);
      const startStr = today.toISOString().split("T")[0];
      const endStr = endDate.toISOString().split("T")[0];

      // 1. Load staff
      const staffRes = await fetch(
        `${baseUrl}/api/business/${biz}/branch/${branch}/staff?size=200&page=0`,
        { headers },
      );
      if (!staffRes.ok) throw new Error(`Staff API ${staffRes.status}`);
      const staffData = (await staffRes.json()) as Record<string, any>;
      const phorestStaff = staffData._embedded?.staff ?? staffData.staff ?? [];

      // 2. Map to Clokr employees
      const clokrEmployees = await app.prisma.employee.findMany({
        where: { tenantId },
        include: { user: { select: { email: true } } },
      });

      const staffMap = new Map<string, string>();
      for (const ps of phorestStaff) {
        const match = clokrEmployees.find(
          (ce) =>
            ce.user.email.toLowerCase() === (ps.email ?? "").toLowerCase() ||
            (ce.firstName.toLowerCase() === ps.firstName.toLowerCase() &&
              ce.lastName.toLowerCase() === ps.lastName.toLowerCase()),
        );
        if (match) staffMap.set(ps.staffId, match.id);
      }

      // 3. Load WorkTimeTables
      const wttRes = await fetch(
        `${baseUrl}/api/business/${biz}/branch/${branch}/staffworktimetables?start_date=${startStr}&end_date=${endStr}`,
        { headers },
      );
      if (!wttRes.ok) throw new Error(`WorkTimeTables API ${wttRes.status}`);
      const wttData = (await wttRes.json()) as Record<string, any>;
      const entries =
        wttData._embedded?.staffWorkTimeTables ?? wttData.staffWorkTimeTables ?? wttData ?? [];

      // 4. Create shifts
      let created = 0;
      for (const wt of Array.isArray(entries) ? entries : []) {
        const employeeId = staffMap.get(wt.staffId);
        if (!employeeId) continue;

        const date = wt.date ?? wt.startTime?.split("T")[0];
        if (!date) continue;

        const startH = wt.startTime ? new Date(wt.startTime).toISOString().slice(11, 16) : null;
        const endH = wt.endTime ? new Date(wt.endTime).toISOString().slice(11, 16) : null;
        if (!startH || !endH) continue;

        const existing = await app.prisma.shift.findFirst({
          where: { employeeId, date: new Date(date), startTime: startH, endTime: endH },
        });
        if (existing) continue;

        await app.prisma.shift.create({
          data: {
            employeeId,
            date: new Date(date),
            startTime: startH,
            endTime: endH,
            label: "Phorest",
          },
        });
        created++;
      }

      app.log.info({ tenantId, created, mapped: staffMap.size }, "Phorest Auto-Sync abgeschlossen");
    } catch (err) {
      app.log.error({ err, tenantId }, "Phorest Auto-Sync fehlgeschlagen");
    }
  }

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

      const task = cron.schedule(cronExpr, () => {
        syncPhorestForTenant(cfg.tenantId).catch((err) =>
          app.log.error({ err, tenantId: cfg.tenantId }, "Scheduler-Fehler"),
        );
      });
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
