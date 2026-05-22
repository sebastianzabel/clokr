import fp from "fastify-plugin";
import cron, { type ScheduledTask } from "node-cron";
import type { FastifyInstance } from "fastify";

/**
 * BUrlG § 7 Hinweispflicht (EuGH C-684/16 "Max-Planck").
 *
 * Per the EuGH ruling, accrued vacation does NOT expire automatically — the
 * employer must proactively warn the employee about an upcoming deadline.
 * Without a documented warning, the deadline is legally ineffective.
 *
 * This plugin runs daily at 06:00 server time and issues per-threshold
 * warnings (default 60/30/14/7 days before the carry-over deadline). Each
 * warning is recorded as an AuditLog entry FIRST (audit-before-action) so the
 * legal proof exists even if the notification transport later fails.
 *
 * Dedup: AuditLog is the source of truth — we skip employees who already have
 * a CARRYOVER_WARNED entry for the same year + threshold.
 *
 * Use `runCarryoverWarningOnce(app)` to trigger the same logic manually
 * (tests, on-demand admin button). Returns counts for assertions.
 */

export interface CarryoverWarningRunResult {
  scanned: number; // entitlements considered
  warned: number; // new warnings issued (one per employee-threshold)
  skippedDedup: number; // already warned for same year+threshold
  skippedDisabled: number; // tenants where the feature is disabled
}

const SOURCE_TAG = "carryover-warning-cron";

function ceilDaysUntil(deadline: Date, now: Date): number {
  const diffMs = deadline.getTime() - now.getTime();
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function formatDeDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/**
 * Core logic — extracted so the cron tick AND the manual trigger
 * (`POST /reports/carryover-warn`) can both call it.
 *
 * If `onlyEntitlementId` is given, only that single entitlement is processed
 * (used by the manual trigger). The dedup behaviour is the same.
 */
export async function runCarryoverWarningOnce(
  app: FastifyInstance,
  opts: { onlyEntitlementId?: string } = {},
): Promise<CarryoverWarningRunResult> {
  const result: CarryoverWarningRunResult = {
    scanned: 0,
    warned: 0,
    skippedDedup: 0,
    skippedDisabled: 0,
  };

  const now = new Date();

  const tenants = await app.prisma.tenant.findMany({
    select: { id: true },
  });

  for (const tenant of tenants) {
    const cfg = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: tenant.id },
    });

    if (cfg && cfg.carryoverWarningEnabled === false) {
      result.skippedDisabled++;
      continue;
    }

    const thresholds =
      cfg?.carryoverWarningThresholds && cfg.carryoverWarningThresholds.length > 0
        ? [...cfg.carryoverWarningThresholds]
        : [60, 30, 14, 7];

    // Find entitlements with active carry-over and a future deadline
    const where: Record<string, unknown> = {
      employee: { tenantId: tenant.id, exitDate: null },
      carryOverDeadline: { gt: now },
      carriedOverDays: { gt: 0 },
    };
    if (opts.onlyEntitlementId) {
      where.id = opts.onlyEntitlementId;
    }

    const entitlements = await app.prisma.leaveEntitlement.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            employeeNumber: true,
            userId: true,
            tenantId: true,
            user: { select: { id: true, isActive: true } },
          },
        },
      },
    });

    if (entitlements.length === 0) continue;

    // Tenant admins → manager CC. Single fetch per tenant.
    const admins = await app.prisma.user.findMany({
      where: {
        role: "ADMIN",
        isActive: true,
        employee: { tenantId: tenant.id },
      },
      select: { id: true },
    });

    for (const ent of entitlements) {
      result.scanned++;
      if (!ent.carryOverDeadline) continue;

      const daysUntil = ceilDaysUntil(ent.carryOverDeadline, now);
      if (daysUntil <= 0) continue;

      // Find a matching threshold. If multiple match (e.g. when the manual
      // trigger runs the same day as a cron tick), the first match wins.
      const matchedThreshold = thresholds.find((t) => t === daysUntil);
      if (matchedThreshold === undefined) continue;

      // Dedup via AuditLog — the audit trail IS the legal proof.
      const existing = await app.prisma.auditLog.findFirst({
        where: {
          action: "CARRYOVER_WARNED",
          entity: "LeaveEntitlement",
          entityId: ent.id,
          newValue: {
            path: ["thresholdDays"],
            equals: matchedThreshold,
          },
        },
      });

      if (existing) {
        result.skippedDedup++;
        continue;
      }

      // Also dedup on year, in case a manual reset happens. Because
      // entitlement.year is part of the recorded newValue, the path filter
      // above already ties dedup to a specific year (one entitlement = one
      // year). No additional check needed.

      const carriedOverDays = Number(ent.carriedOverDays);
      const deadlineDe = formatDeDate(ent.carryOverDeadline);

      // 1) Write AuditLog FIRST — audit-before-action so the legal proof
      //    exists even if email transport fails.
      await app.audit({
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: ent.id,
        newValue: {
          source: SOURCE_TAG,
          employeeId: ent.employee.id,
          employeeName: `${ent.employee.firstName} ${ent.employee.lastName}`,
          employeeNumber: ent.employee.employeeNumber,
          year: ent.year,
          deadline: ent.carryOverDeadline.toISOString().split("T")[0],
          thresholdDays: matchedThreshold,
          daysUntilDeadline: daysUntil,
          carriedOverDays,
        },
        request: { ip: "cron", headers: { "user-agent": SOURCE_TAG } },
      });

      result.warned++;

      // 2) Employee notification — skip if the user is inactive
      if (ent.employee.user.isActive) {
        const empMessage =
          `Ihr Resturlaub aus ${ent.year - 1} (${carriedOverDays} Tage) verfällt am ` +
          `${deadlineDe}. Sie haben noch ${daysUntil} Tage Zeit, um diesen Urlaub zu nehmen. ` +
          `Gemäß § 7 Abs. 3 BUrlG (EuGH C-684/16 "Max-Planck") wurden Sie hiermit ausdrücklich ` +
          `auf den drohenden Verfall hingewiesen.`;

        await app
          .notify({
            userId: ent.employee.userId,
            type: "CARRYOVER_EXPIRING",
            title: `Resturlaub verfällt am ${deadlineDe}`,
            message: empMessage,
            link: "/leave",
            tenantId: tenant.id,
            relatedType: "LeaveEntitlement",
            relatedId: ent.id,
          })
          .catch((err: unknown) => {
            app.log.warn(
              { err, entitlementId: ent.id, userId: ent.employee.userId },
              "Hinweispflicht: Mitarbeiter-Notification fehlgeschlagen — AuditLog bleibt bestehen",
            );
          });
      }

      // 3) Manager CC — different message, link to admin view
      const mgrMessage =
        `${ent.employee.firstName} ${ent.employee.lastName} ` +
        `(Mitarbeiter-Nr. ${ent.employee.employeeNumber}) hat noch ${carriedOverDays} Tage ` +
        `Resturlaub aus ${ent.year - 1}, der am ${deadlineDe} verfällt (in ${daysUntil} Tagen). ` +
        `Eine Hinweis-Mail wurde dem Mitarbeiter automatisch zugestellt.`;

      for (const admin of admins) {
        // Don't double-notify if the affected employee IS the admin
        if (admin.id === ent.employee.userId) continue;
        await app
          .notify({
            userId: admin.id,
            type: "CARRYOVER_EXPIRING",
            title: `Resturlaub-Verfall: ${ent.employee.firstName} ${ent.employee.lastName}`,
            message: mgrMessage,
            link: "/reports",
            tenantId: tenant.id,
            relatedType: "LeaveEntitlement",
            relatedId: ent.id,
          })
          .catch((err: unknown) => {
            app.log.warn(
              { err, entitlementId: ent.id, adminId: admin.id },
              "Hinweispflicht: Admin-Notification fehlgeschlagen — AuditLog bleibt bestehen",
            );
          });
      }

      app.log.info(
        {
          entitlementId: ent.id,
          employeeId: ent.employee.id,
          year: ent.year,
          thresholdDays: matchedThreshold,
          daysUntil,
          carriedOverDays,
        },
        "Hinweispflicht: Resturlaub-Verfall-Warnung ausgestellt",
      );
    }
  }

  return result;
}

export const carryoverWarningPlugin = fp(async (app) => {
  const tasks: ScheduledTask[] = [];

  app.addHook("onReady", async () => {
    try {
      // Daily at 06:00 — early enough that morning standups can act on it,
      // late enough that overnight DB maintenance is done.
      const dailyTask = cron.schedule("0 6 * * *", () => {
        runCarryoverWarningOnce(app)
          .then((res) => {
            app.log.info({ ...res }, "Hinweispflicht: tägliche Carry-over-Warnung abgeschlossen");
          })
          .catch((err) => app.log.error({ err }, "Hinweispflicht: tägliche Job fehlgeschlagen"));
      });
      tasks.push(dailyTask);
      app.log.info("Hinweispflicht: Carry-over-Warnung geplant (täglich 06:00)");
    } catch (err) {
      app.log.error({ err }, "Hinweispflicht: Plugin-Start fehlgeschlagen");
    }
  });

  app.addHook("onClose", async () => {
    for (const task of tasks) void task.stop();
  });
});
