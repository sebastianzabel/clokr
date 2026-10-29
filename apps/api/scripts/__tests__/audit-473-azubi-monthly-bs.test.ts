/**
 * Issue #473 - audit-473-azubi-monthly-bs.ts is a read-only listing.
 *
 * The integration case runs `main` against a seeded tenant with a closed MONTHLY_HOURS month that
 * holds a Berufsschultag. The release rehearsal of v1.17.0 on a production copy found that the
 * snapshot query selected a field SaldoSnapshot does not have (`isLocked`); the scripts typecheck
 * did not see it and no test ever executed the query, so this case executes it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { saldoSnapshotPeriodBounds } from "../../src/__tests__/test-dates";
import { EXIT_FINDINGS, main } from "../audit-473-azubi-monthly-bs";

describe("main (read-only)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "a473");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } finally {
      await closeTestApp();
    }
  });

  it("lists a closed MONTHLY_HOURS month with a Berufsschultag and changes no row", async () => {
    const employeeId = data.employee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        type: "MONTHLY_HOURS",
        monthlyHours: 80,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2026-09-01T00:00:00Z"),
      },
    });
    // 2026-09-07 is a Monday, a contractual workday.
    await app.prisma.absence.create({
      data: {
        employeeId,
        type: "VOCATIONAL_SCHOOL",
        source: "MANUAL",
        startDate: new Date("2026-09-07T00:00:00Z"),
        endDate: new Date("2026-09-07T00:00:00Z"),
        days: 1,
        createdBy: "system",
      },
    });
    const bounds = saldoSnapshotPeriodBounds(new Date("2026-09-01T00:00:00Z"));
    const closedAt = new Date("2026-10-01T05:00:00Z");
    const snap = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: bounds.start,
        periodEnd: bounds.end,
        workedMinutes: 4800,
        expectedMinutes: 4800,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt,
      },
    });

    const rows = () =>
      app.prisma.saldoSnapshot.findMany({
        where: { employee: { tenantId: data.tenant.id } },
        orderBy: { id: "asc" },
      });
    const before = await rows();

    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    let code: number;
    try {
      code = await main(["--tenant-id", data.tenant.id], app.prisma);
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(EXIT_FINDINGS);
    expect(await rows()).toEqual(before);
    const finding = lines.find((l) => l.startsWith("finding "));
    expect(finding).toContain(`snapshotId=${snap.id}`);
    expect(finding).toContain("month=2026-09");
    expect(finding).toContain("bsWorkdays=1");
    expect(finding).toContain(`closedAt=${closedAt.toISOString()}`);
    // Ids only: the fixture person's name never appears.
    expect(lines.join("\n")).not.toContain(data.employee.firstName);
  });
});
