/**
 * Phase 76.6 regression test — TZ-duplicate SaldoSnapshot cleanup.
 *
 * Asserts:
 *   1. cleanupTzDuplicateSnapshots() marks the UTC-midnight duplicate `superseded`,
 *      preserves the tenant-TZ-anchored canonical row, and writes an AuditLog row.
 *   2. After cleanup, findFirst(orderBy: periodStart desc, where: superseded=false)
 *      returns the canonical row (the root-cause fix for prod 2026-06-08).
 *   3. The cleanup is idempotent (re-runs produce zero changes).
 *   4. Dry-run mode writes nothing.
 *   5. Groups with no canonical match are skipped (warn, not crash).
 *   6. Single-row groups are skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { cleanupTzDuplicateSnapshots, SUPERSEDED_REASON } from "../utils/saldo-snapshot-cleanup";
import { monthRangeUtc } from "../utils/timezone";

let app: FastifyInstance;
let data: Awaited<ReturnType<typeof seedTestData>>;
let employeeId: string;
let actorUserId: string;

const TZ = "Europe/Berlin";

beforeAll(async () => {
  app = await getTestApp();
  data = await seedTestData(app, "snap-sup");
  employeeId = data.employee.id;
  actorUserId = data.adminUser.id;
});

afterAll(async () => {
  try {
    await app.prisma.auditLog.deleteMany({
      where: { entity: "SaldoSnapshot", userId: actorUserId },
    });
    await app.prisma.saldoSnapshot.deleteMany({
      where: { employeeId: { in: [data.employee.id, data.adminEmployee.id] } },
    });
    await cleanupTestData(app, data.tenant.id);
  } catch (err) {
    console.error("Test cleanup failed:", err);
  }
  await closeTestApp();
});

beforeEach(async () => {
  // Clean up SaldoSnapshot + AuditLog for this employee between tests
  await app.prisma.auditLog.deleteMany({
    where: { entity: "SaldoSnapshot", userId: actorUserId },
  });
  await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId } });
});

async function seedTzDuplicate(year: number, month: number) {
  const { start: canonicalStart, end: canonicalEnd } = monthRangeUtc(year, month, TZ);
  const lastDay = new Date(year, month, 0).getDate();

  const utcMidnightStart = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00.000Z`);
  const utcMidnightEnd = new Date(
    `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}T00:00:00.000Z`,
  );

  // Two snapshots in the same calendar month: canonical + UTC-midnight duplicate.
  // The unique constraint is (employeeId, periodType, periodStart) so different periodStart
  // values are allowed — that's exactly the bug we're cleaning up.
  const canonical = await app.prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: canonicalStart,
      periodEnd: canonicalEnd,
      workedMinutes: 9600,
      expectedMinutes: 9600,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date(),
    },
  });
  const duplicate = await app.prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: utcMidnightStart,
      periodEnd: utcMidnightEnd,
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date(),
    },
  });
  return { canonical, duplicate };
}

// ── Phase 76.25 regression fixtures ──────────────────────────────────────────

/**
 * Seeds two rows in the same calendar month that form the v1.8.15 prod pattern:
 *   - A bridge row (expectedMinutes==0, workedMinutes==0, balanceMinutes==0, carryOver=750)
 *     with periodStart = UTC-midnight YYYY-MM-01 (the spurious non-TZ-anchored position).
 *   - An auto-close row (normal worked/expected values, carryOver=0)
 *     with periodStart = monthRangeUtc(year, month, TZ).start (the TZ anchor).
 *
 * Both rows share the same periodEnd so they bucket into the same cleanup group
 * (the grouping key uses utcMonthStr(periodEnd)).
 *
 * Under pure-anchor selection the auto-close row would be kept and the bridge (and its
 * carryOver) destroyed — the 76.25 hardening must reverse this.
 */
async function seedBridgePlusAutoClose(year: number, month: number) {
  const { start: canonicalStart, end: canonicalEnd } = monthRangeUtc(year, month, TZ);

  // Bridge: UTC-midnight periodStart (the non-TZ-anchored variant the old script produced),
  // all work fields zero, non-zero carryOver (+750 — the v1.8.15 opening-balance case).
  const bridgeStart = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00.000Z`);
  const bridge = await app.prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: bridgeStart,
      periodEnd: canonicalEnd, // same periodEnd → same group bucket
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: 750,
      closedAt: new Date(),
    },
  });

  // Auto-close: TZ-anchored periodStart (what the old pure-anchor code would have kept),
  // normal worked/expected values, zero carryOver.
  const autoClose = await app.prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: canonicalStart,
      periodEnd: canonicalEnd,
      workedMinutes: 9600,
      expectedMinutes: 9600,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date(),
    },
  });

  return { bridge, autoClose, canonicalStart, canonicalEnd };
}

describe("cleanupTzDuplicateSnapshots — Phase 76.25 bridge hardening", () => {
  it("retains the opening bridge as canonical and supersedes the auto-close duplicate (v1.8.15 case)", async () => {
    const { bridge, autoClose } = await seedBridgePlusAutoClose(2026, 3);

    const report = await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      { info: () => {}, warn: () => {} },
    );

    expect(report.applied).toBe(true);
    expect(report.bridgePreservedGroups).toBe(1);
    expect(report.supersededRowCount).toBe(1);
    expect(report.auditLogRowCount).toBe(1);
    expect(report.duplicateGroups.length).toBe(1);
    expect(report.duplicateGroups[0].canonicalRowId).toBe(bridge.id);

    // Bridge must NOT be superseded — its carryOver must survive.
    const bridgeAfter = await app.prisma.saldoSnapshot.findUnique({ where: { id: bridge.id } });
    expect(bridgeAfter?.superseded).toBe(false);
    expect(bridgeAfter?.carryOver).toBe(750);

    // Auto-close row IS superseded.
    const autoCloseAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: autoClose.id },
    });
    expect(autoCloseAfter?.superseded).toBe(true);
    expect(autoCloseAfter?.supersededReason).toBe(SUPERSEDED_REASON);

    // findFirst with superseded:false returns the bridge (opening carry-in survives).
    // This is the assertion that FAILS under pure-anchor behaviour.
    const surfaced = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId, periodType: "MONTHLY", superseded: false },
      orderBy: { periodStart: "desc" },
    });
    expect(surfaced?.id).toBe(bridge.id);
    expect(surfaced?.carryOver).toBe(750);

    // AuditLog written for the auto-close row, NOT the bridge.
    const auditLogs = await app.prisma.auditLog.findMany({
      where: { entity: "SaldoSnapshot", userId: actorUserId },
    });
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].entityId).toBe(autoClose.id);
    expect(auditLogs[0].action).toBe("UPDATE");
    expect((auditLogs[0].newValue as { superseded: boolean }).superseded).toBe(true);
  });

  it("skips an ambiguous multi-bridge group and supersedes nothing (D-03)", async () => {
    const { start: canonicalStart, end: canonicalEnd } = monthRangeUtc(2026, 4, TZ);
    // Two bridge rows in the same month (different periodStart, same periodEnd).
    const bridgeA = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: new Date("2026-04-01T00:00:00.000Z"),
        periodEnd: canonicalEnd,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 540,
        closedAt: new Date(),
      },
    });
    const bridgeB = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: canonicalStart, // TZ-anchored — still a bridge by shape
        periodEnd: canonicalEnd,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 750,
        closedAt: new Date(),
      },
    });

    let warned = false;
    const report = await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      {
        info: () => {},
        warn: () => {
          warned = true;
        },
      },
    );

    // Group must be skipped entirely — nothing superseded.
    expect(report.duplicateGroups.length).toBe(0);
    expect(report.supersededRowCount).toBe(0);
    expect(report.bridgePreservedGroups).toBe(0);
    expect(warned).toBe(true);

    // Both rows remain untouched.
    const aAfter = await app.prisma.saldoSnapshot.findUnique({ where: { id: bridgeA.id } });
    const bAfter = await app.prisma.saldoSnapshot.findUnique({ where: { id: bridgeB.id } });
    expect(aAfter?.superseded).toBe(false);
    expect(bAfter?.superseded).toBe(false);
  });

  it("no-bridge groups are unchanged — anchor selection still applies (D-04 regression guard)", async () => {
    // seedTzDuplicate produces two rows with carryOver=0 (not bridge shape).
    // The canonical row (TZ-anchored) must be kept; the UTC-midnight duplicate superseded.
    const { canonical, duplicate } = await seedTzDuplicate(2026, 5);

    const report = await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      { info: () => {}, warn: () => {} },
    );

    expect(report.bridgePreservedGroups).toBe(0);
    expect(report.supersededRowCount).toBe(1);
    expect(report.duplicateGroups.length).toBe(1);
    expect(report.duplicateGroups[0].canonicalRowId).toBe(canonical.id);

    const canonicalAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: canonical.id },
    });
    const duplicateAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: duplicate.id },
    });
    expect(canonicalAfter?.superseded).toBe(false);
    expect(duplicateAfter?.superseded).toBe(true);
  });

  it("bridge preservation is idempotent — second run is a no-op", async () => {
    await seedBridgePlusAutoClose(2026, 6);

    // First run: auto-close superseded, bridge kept.
    await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      { info: () => {}, warn: () => {} },
    );
    const auditCountAfterFirst = await app.prisma.auditLog.count({
      where: { entity: "SaldoSnapshot", userId: actorUserId },
    });

    // Second run: bridge is the only non-superseded row → group size < 2 → skipped.
    const secondReport = await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      { info: () => {}, warn: () => {} },
    );
    expect(secondReport.duplicateGroups.length).toBe(0);
    expect(secondReport.supersededRowCount).toBe(0);
    expect(secondReport.auditLogRowCount).toBe(0);
    expect(secondReport.bridgePreservedGroups).toBe(0);

    const auditCountAfterSecond = await app.prisma.auditLog.count({
      where: { entity: "SaldoSnapshot", userId: actorUserId },
    });
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);
  });
});

describe("cleanupTzDuplicateSnapshots — Phase 76.6", () => {
  it("marks the UTC-midnight duplicate superseded, preserves the canonical row, writes AuditLog", async () => {
    const { canonical, duplicate } = await seedTzDuplicate(2026, 5);

    const report = await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      { info: () => {}, warn: () => {} },
    );

    expect(report.applied).toBe(true);
    expect(report.duplicateGroups.length).toBe(1);
    expect(report.supersededRowCount).toBe(1);
    expect(report.auditLogRowCount).toBe(1);

    const canonicalAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: canonical.id },
    });
    const duplicateAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: duplicate.id },
    });
    expect(canonicalAfter?.superseded).toBe(false);
    expect(duplicateAfter?.superseded).toBe(true);
    expect(duplicateAfter?.supersededReason).toBe(SUPERSEDED_REASON);

    const auditLogs = await app.prisma.auditLog.findMany({
      where: { entity: "SaldoSnapshot", entityId: duplicate.id },
    });
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].action).toBe("UPDATE");
    expect(auditLogs[0].userId).toBe(actorUserId);
    expect((auditLogs[0].oldValue as { superseded: boolean }).superseded).toBe(false);
    expect((auditLogs[0].newValue as { superseded: boolean }).superseded).toBe(true);
    expect((auditLogs[0].newValue as { supersededReason: string }).supersededReason).toBe(
      SUPERSEDED_REASON,
    );
  });

  it("post-cleanup, findFirst(orderBy: periodStart desc, superseded: false) returns the canonical row (DATA-V19-01c)", async () => {
    const { canonical, duplicate } = await seedTzDuplicate(2026, 5);

    // BEFORE cleanup — without the filter, the WRONG row is picked (control assertion).
    const beforeNoFilter = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId, periodType: "MONTHLY" },
      orderBy: { periodStart: "desc" },
    });
    expect(beforeNoFilter?.id).toBe(duplicate.id); // proves the bug exists without the filter

    await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      { info: () => {}, warn: () => {} },
    );

    // AFTER cleanup — with the filter, the CANONICAL row is picked.
    const afterFiltered = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId, periodType: "MONTHLY", superseded: false },
      orderBy: { periodStart: "desc" },
    });
    expect(afterFiltered?.id).toBe(canonical.id);
  });

  it("is idempotent — re-runs produce zero changes and zero new AuditLog rows", async () => {
    await seedTzDuplicate(2026, 5);
    await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      { info: () => {}, warn: () => {} },
    );
    const auditCountAfterFirst = await app.prisma.auditLog.count({
      where: { entity: "SaldoSnapshot", userId: actorUserId },
    });

    const secondReport = await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      { info: () => {}, warn: () => {} },
    );
    expect(secondReport.duplicateGroups.length).toBe(0);
    expect(secondReport.supersededRowCount).toBe(0);
    expect(secondReport.auditLogRowCount).toBe(0);

    const auditCountAfterSecond = await app.prisma.auditLog.count({
      where: { entity: "SaldoSnapshot", userId: actorUserId },
    });
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);
  });

  it("dry-run mode writes nothing", async () => {
    const { canonical, duplicate } = await seedTzDuplicate(2026, 5);
    const report = await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: true },
      { info: () => {}, warn: () => {} },
    );

    expect(report.applied).toBe(false);
    expect(report.supersededRowCount).toBe(1); // report still computed
    expect(report.auditLogRowCount).toBe(0); // but no writes

    const canonicalAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: canonical.id },
    });
    const duplicateAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: duplicate.id },
    });
    expect(canonicalAfter?.superseded).toBe(false);
    expect(duplicateAfter?.superseded).toBe(false);

    const auditCount = await app.prisma.auditLog.count({
      where: { entity: "SaldoSnapshot", userId: actorUserId },
    });
    expect(auditCount).toBe(0);
  });

  it("skips single-row groups (no duplicate to clean up)", async () => {
    const { start: canonicalStart, end: canonicalEnd } = monthRangeUtc(2026, 6, TZ);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: canonicalStart,
        periodEnd: canonicalEnd,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    const report = await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      { info: () => {}, warn: () => {} },
    );
    expect(report.duplicateGroups.length).toBe(0);
    expect(report.supersededRowCount).toBe(0);
  });

  it("skips groups where no row matches the canonical UTC value (warn, not crash)", async () => {
    // Seed two snapshots in the same calendar month, but NEITHER matches monthRangeUtc().start.
    // (e.g. both 1-day off — defensive case for unaudited TZ edge cases)
    const offByOneA = new Date("2026-07-15T00:00:00.000Z");
    const offByOneB = new Date("2026-07-16T00:00:00.000Z");
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: offByOneA,
        periodEnd: new Date("2026-07-31T00:00:00.000Z"),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: offByOneB,
        periodEnd: new Date("2026-07-31T00:00:00.000Z"),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    let warned = false;
    const report = await cleanupTzDuplicateSnapshots(
      app.prisma,
      { actorId: actorUserId, dryRun: false },
      {
        info: () => {},
        warn: () => {
          warned = true;
        },
      },
    );
    expect(report.duplicateGroups.length).toBe(0);
    expect(report.supersededRowCount).toBe(0);
    expect(warned).toBe(true);
  });
});
