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
    // v1.8 fix — Tracking handle for fire-and-forget generator runs triggered by
    // the PUT pattern handler (vocational-school-pattern.ts:244). Production code
    // uses `void`-discard for snappy UX, but tests need a way to await pending
    // background work before asserting on DB state. Returns a Promise that resolves
    // when ALL currently-pending bg generator runs complete (rejected ones are
    // logged inside the generator and resolve to undefined here).
    waitForPendingBSGenerations?: () => Promise<void>;
    // Internal — public only because the PUT handler in routes/ needs to register
    // its fire-and-forget Promise here. Do not call from application code; use the
    // existing `void runVocationalSchoolGeneration(...)` pattern directly.
    trackPendingBSGeneration?: (p: Promise<unknown>) => void;
  }
}

export const vocationalSchoolGeneratorPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  // v1.8 fix — Tracker for fire-and-forget bg generator runs (see
  // declare-module comment above). Promises are removed from the set
  // once they settle (resolve OR reject) so the set only contains
  // genuinely-pending work.
  const pendingBgRuns = new Set<Promise<unknown>>();

  app.decorate("trackPendingBSGeneration", (p: Promise<unknown>) => {
    pendingBgRuns.add(p);
    void p.finally(() => pendingBgRuns.delete(p));
  });

  app.decorate("waitForPendingBSGenerations", async () => {
    // Snapshot — new runs registered after this point are NOT awaited.
    // Tests should call this AFTER all triggering operations have returned.
    const snapshot = Array.from(pendingBgRuns);
    if (snapshot.length === 0) return;
    // allSettled so a single rejected bg run doesn't make the wait throw.
    await Promise.allSettled(snapshot);
  });

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
