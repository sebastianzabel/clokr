/**
 * Issue #450 (D-09) — RED-then-GREEN proof that backfill-missing-vacation-entitlements.ts's
 * dry-run preview and --confirm write both compute the proposed/written `totalDays` per contract
 * segment, not from the newest `WorkSchedule` row alone (the exact bug Issue #450 fixes
 * elsewhere in this phase). Own seeded tenant, separate from
 * backfill-missing-vacation-entitlements.test.ts's "bfve" tenant — cleaned up in afterAll.
 *
 * Fixture: an active employee hired 2024-01-01 with a Mo-Mi (3-day) contract, changing to Mo-Fr
 * (5-day) from 1 July of the current year, and NO VACATION LeaveEntitlement row for the current
 * year. The per-segment target is 24 (Jan-Jun at 3-day = 18, scaled to 9 months'-worth... see
 * below); the pre-#450 newest-row-only formula answers 30 (the full 5-day base).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { main } from "../backfill-missing-vacation-entitlements";
import type { FastifyInstance } from "fastify";

describe("backfill-missing-vacation-entitlements — per-segment computation (Issue #450)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const currentYear = new Date().getFullYear();
  let employeeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bfve450");

    const user = await app.prisma.user.create({
      data: { email: `bfve450@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: "BFVE450-1",
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    employeeId = employee.id;

    // First contract row — Mo-Mi (3-day), hire-time (exempt from the 1st-of-month rule).
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "FIXED_SCHEDULE",
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3],
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    // Mid-year change to Mo-Fr (5-day), from the 1st of July of the CURRENT year.
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "FIXED_SCHEDULE",
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date(Date.UTC(currentYear, 6, 1)),
      },
    });
    // No VACATION LeaveEntitlement row for the current year — the exact missing-row shape this
    // script repairs.
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("dry-run proposes the per-segment value (24), never the newest-row-only value (30), and writes nothing", async () => {
    const summary = await main(["--tenant-id", data.tenant.id], app.prisma);
    const candidate = summary.candidates.find((c) => c.employeeId === employeeId);
    expect(candidate).toBeDefined();
    expect(candidate!.proposedTotalDays).toBe(24);

    const row = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId, year: currentYear },
    });
    expect(row).toBeNull();
  });

  it("--confirm creates the row with the SAME per-segment value (24) and one CREATE audit — dry-run/--confirm parity", async () => {
    const summary = await main(["--tenant-id", data.tenant.id, "--confirm"], app.prisma);
    expect(summary.created).toBeGreaterThanOrEqual(1);

    const row = await app.prisma.leaveEntitlement.findFirstOrThrow({
      where: { employeeId, year: currentYear },
    });
    expect(Number(row.totalDays)).toBe(24);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: row.id, action: "CREATE" },
    });
    expect(audits).toHaveLength(1);
  });
});
