/**
 * TDD tests for the purgeable AuditLog purge cron (REQ-13 / WIFI-04).
 *
 * Tests the runPurgeableAuditLogs() function directly (exposed via app.decorate).
 * Uses the real DB — inserts rows with controlled createdAt, asserts presence/absence.
 *
 * DSGVO rationale: AuditLog entries with purgeable=true are WiFi-presence-only events
 * that never produced a TimeEntry. They are not payroll-relevant and must be purged
 * after the configured retention window (default 90 days) per DSGVO Art. 5(1)(e).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp } from "./setup";
import type { FastifyInstance } from "fastify";

describe("data-retention — purgeable AuditLog purge (REQ-13)", () => {
  let app: FastifyInstance;
  const insertedIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    // Clean up all test rows regardless of test outcome
    if (insertedIds.length > 0) {
      await app.prisma.auditLog.deleteMany({ where: { id: { in: insertedIds } } });
    }
  });

  // Helper: create AuditLog row with explicit createdAt
  async function createAuditLog(opts: { purgeable: boolean; daysAgo: number; entity?: string }) {
    const createdAt = new Date();
    createdAt.setDate(createdAt.getDate() - opts.daysAgo);
    const row = await app.prisma.auditLog.create({
      data: {
        action: "WIFI_PRESENCE_OUT_OF_WINDOW",
        entity: opts.entity ?? "WifiPresence",
        purgeable: opts.purgeable,
        createdAt,
      },
    });
    insertedIds.push(row.id);
    return row;
  }

  it("hard-deletes purgeable entries older than retention days", async () => {
    const rows = await Promise.all([
      createAuditLog({ purgeable: true, daysAgo: 91 }),
      createAuditLog({ purgeable: true, daysAgo: 95 }),
      createAuditLog({ purgeable: true, daysAgo: 120 }),
    ]);
    const ids = rows.map((r) => r.id);

    await (app as any).runPurgeableAuditLogs();

    const remaining = await app.prisma.auditLog.findMany({ where: { id: { in: ids } } });
    expect(remaining).toHaveLength(0);
  });

  it("does NOT delete non-purgeable entries regardless of age", async () => {
    const rows = await Promise.all([
      createAuditLog({ purgeable: false, daysAgo: 91 }),
      createAuditLog({ purgeable: false, daysAgo: 365 }),
    ]);
    const ids = rows.map((r) => r.id);

    await (app as any).runPurgeableAuditLogs();

    const remaining = await app.prisma.auditLog.findMany({ where: { id: { in: ids } } });
    expect(remaining).toHaveLength(2);
  });

  it("does NOT delete purgeable entries younger than retention window", async () => {
    const rows = await Promise.all([
      createAuditLog({ purgeable: true, daysAgo: 89 }),
      createAuditLog({ purgeable: true, daysAgo: 1 }),
    ]);
    const ids = rows.map((r) => r.id);

    await (app as any).runPurgeableAuditLogs();

    const remaining = await app.prisma.auditLog.findMany({ where: { id: { in: ids } } });
    expect(remaining).toHaveLength(2);
  });
});
