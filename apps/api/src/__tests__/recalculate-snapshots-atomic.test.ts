/**
 * CR-01 regression — atomic supersede+create in recalculateSnapshots.
 *
 * Proves that after recalculateSnapshots() runs, the period has:
 *   - exactly one NON-superseded (active) snapshot
 *   - the original snapshot is now superseded:true
 *
 * This guards against the pre-fix bug where two bare Prisma calls (update +
 * create) could leave the period with NO active snapshot if the process died
 * between them — silently corrupting the carry-over chain.
 *
 * Direct atomicity (crash-between-calls) cannot be simulated in a unit test,
 * but the state assertion is the authoritative proxy: if the $transaction
 * succeeds, both operations apply; if it fails, neither does.  The test
 * proves the success path produces a consistent one-active-row state.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";

describe("recalculateSnapshots — atomic supersede+create (CR-01)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let seedSnapshotId: string;

  // Use a historical period well outside any other test's date range.
  const PERIOD_START = new Date("2023-06-01T00:00:00.000Z");
  const PERIOD_END = new Date("2023-06-30T23:59:59.999Z");

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rs-atomic");
  });

  afterAll(async () => {
    // Clean up snapshots created by this suite
    await app.prisma.saldoSnapshot.deleteMany({
      where: { employeeId: data.employee.id },
    });
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("recalculate-snapshots-atomic test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("after recalc, old snapshot is superseded and exactly one active snapshot exists for the period (no orphan gap)", async () => {
    // Seed one closed snapshot for June 2023
    const original = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2023-07-01T00:00:00.000Z"),
        closedBy: data.adminUser.id,
        superseded: false,
      },
    });
    seedSnapshotId = original.id;

    // Confirm pre-condition: 1 active, 0 superseded for this period
    const activeBefore = await app.prisma.saldoSnapshot.count({
      where: { employeeId: data.employee.id, periodStart: PERIOD_START, superseded: false },
    });
    expect(activeBefore).toBe(1);

    // Trigger recalculation (the function that wraps supersede+create in a tx)
    await recalculateSnapshots(app, data.employee.id, PERIOD_START);

    // Post-condition: original row is superseded
    const originalAfter = await app.prisma.saldoSnapshot.findUnique({
      where: { id: original.id },
    });
    expect(originalAfter?.superseded).toBe(true);
    expect(originalAfter?.supersededReason).toBe("retroactive recalculation");

    // Post-condition: exactly one active (superseded:false) snapshot for this period
    // — no orphan gap where the period has zero active rows
    const activeAfter = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: data.employee.id, periodStart: PERIOD_START, superseded: false },
    });
    expect(activeAfter.length).toBe(1);

    // The active row must be a NEW row (different id from the superseded original)
    expect(activeAfter[0].id).not.toBe(original.id);

    // Audit log entry for the SUPERSEDE action must exist
    const auditEntries = await app.prisma.auditLog.findMany({
      where: { entity: "SaldoSnapshot", action: "SUPERSEDE", entityId: original.id },
    });
    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("recalculation is idempotent — running twice produces exactly one active snapshot", async () => {
    // Reset: clean previous snapshots and seed a fresh one
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: data.employee.id } });

    const fresh = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2023-07-01T00:00:00.000Z"),
        closedBy: data.adminUser.id,
        superseded: false,
      },
    });

    // First run
    await recalculateSnapshots(app, data.employee.id, PERIOD_START);
    // Second run
    await recalculateSnapshots(app, data.employee.id, PERIOD_START);

    const activeAfter = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: data.employee.id, periodStart: PERIOD_START, superseded: false },
    });
    // Must still have exactly one active snapshot — no duplication, no gap
    expect(activeAfter.length).toBe(1);
    // The original must be superseded
    const origAfter = await app.prisma.saldoSnapshot.findUnique({ where: { id: fresh.id } });
    expect(origAfter?.superseded).toBe(true);
  });
});
