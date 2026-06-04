// Phase 62 — Berufsschultag Auto-Generator Cron Plugin.
//
// Runs runVocationalSchoolGeneration daily at 02:30 for every tenant, pre-populating
// the next N weeks (configurable via TenantConfig.vocationalSchoolPreviewWeeks).
//
// Exposes app.runVocationalSchoolGeneration() decorator for manual trigger from
// tests + admin tooling. Per-tenant errors are logged but do not abort the loop
// (same pattern as data-retention).

import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import { runVocationalSchoolGeneration } from "../utils/vocational-school-generator";

declare module "fastify" {
  interface FastifyInstance {
    runVocationalSchoolGeneration?: () => Promise<void>;
  }
}

export const vocationalSchoolGeneratorPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  async function runAllTenants() {
    app.log.info("Berufsschule-Auto-Gen: Starte tägliche Vorab-Generierung");

    const tenants = await app.prisma.tenant.findMany({
      include: { config: true },
    });

    for (const tenant of tenants) {
      try {
        const weeksAhead = tenant.config?.vocationalSchoolPreviewWeeks ?? 13;
        const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
          tenantId: tenant.id,
          weeksAhead,
        });
        app.log.info(
          `Berufsschule-Auto-Gen: Tenant ${tenant.name} — ${result.created} erstellt, ${result.skipped.existing} bereits vorhanden, ${result.skipped.locked} im Monatsabschluss, ${result.skipped.preHire + result.skipped.postExit} außerhalb Anstellungszeit, ${result.skipped.outOfWindow} außerhalb Pattern-Gültigkeit`,
        );
      } catch (err) {
        app.log.error({ err, tenantId: tenant.id }, "Berufsschule-Auto-Gen: Tenant fehlgeschlagen");
      }
    }
  }

  // Schedule: daily at 02:30
  const task = cron.schedule("30 2 * * *", () => {
    runAllTenants().catch((err) => app.log.error({ err }, "Berufsschule-Auto-Gen fehlgeschlagen"));
  });
  tasks.push(task);
  app.log.info("Berufsschule-Auto-Gen: Täglich 02:30 geplant");

  app.decorate("runVocationalSchoolGeneration", runAllTenants);

  app.addHook("onClose", () => {
    tasks.forEach((t) => void t.stop());
  });
});
