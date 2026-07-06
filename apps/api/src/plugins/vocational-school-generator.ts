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
import { withAdvisoryLock, ADVISORY_LOCK_KEYS } from "../utils/with-advisory-lock";
import { runVocationalSchoolGeneration } from "../utils/vocational-school-generator";

declare module "fastify" {
  interface FastifyInstance {
    runVocationalSchoolGeneration?: () => Promise<void>;
    // v1.8 fix — Tracking handle for fire-and-forget background work triggered by
    // the PUT pattern handler (vocational-school-pattern.ts). Production code uses
    // `void`-discard for snappy UX, but tests need a way to await pending bg work
    // before asserting on DB state. Tracks BOTH the BS-generator promise AND the
    // OpenHolidays school-holidays sync promise — both can race into a later test
    // and corrupt its DB snapshot (Ferien-aware orphan-sweep deleting valid rows).
    // Returns a Promise that resolves when ALL currently-pending bg work settles.
    waitForPendingBSGenerations?: () => Promise<void>;
    // Internal — public only because the PUT handler in routes/ needs to register
    // its fire-and-forget Promises here. Accepts any Promise — name is historical
    // (originally for the BS-generator only). Do not call from application code.
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
    void p.finally(() => {
      pendingBgRuns.delete(p);
    });
  });

  app.decorate("waitForPendingBSGenerations", async () => {
    const snapshot = Array.from(pendingBgRuns);
    if (snapshot.length === 0) return;
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

  // Schedule: daily at 02:30 Berlin time
  const task = cron.schedule(
    "30 2 * * *",
    () => {
      withAdvisoryLock(
        app.prisma,
        ADVISORY_LOCK_KEYS.VOCATIONAL_SCHOOL_GEN,
        () => runAllTenants(),
        app.log,
      ).catch((err) => app.log.error({ err }, "Berufsschule-Auto-Gen fehlgeschlagen"));
    },
    { timezone: "Europe/Berlin", noOverlap: true },
  );
  tasks.push(task);
  app.log.info("Berufsschule-Auto-Gen: Täglich 02:30 geplant");

  app.decorate("runVocationalSchoolGeneration", runAllTenants);

  app.addHook("onClose", () => {
    tasks.forEach((t) => void t.stop());
  });
});
