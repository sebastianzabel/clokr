/**
 * Issue #780 - audit-780-hire-before-contract.ts is a read-only listing: it names the person whose
 * hireDate lies before the first contract with the live-saldo delta the change causes, and writes
 * nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData } from "../../src/__tests__/setup";
import { createPopulationPerson } from "../../src/__tests__/population-fixtures-613";
import {
  seedMonthlyExportFixture,
  type MonthlyExportFixture,
} from "../../src/__tests__/monthly-export-fixture-617";
import { main, EXIT_FINDINGS } from "../audit-780-hire-before-contract";

describe("audit-780-hire-before-contract (Issue #780)", { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let fx: MonthlyExportFixture;
  let employeeId: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T10:00:00.000Z"));
    app = await getTestApp();
    fx = await seedMonthlyExportFixture(app, "au780");
    const p = await createPopulationPerson(app, {
      tenantId: fx.tenantId,
      salonId: fx.salonId,
      tag: "AU",
      hireDate: new Date("2026-09-01T00:00:00Z"),
    });
    employeeId = p.employeeId;
    await app.prisma.workSchedule.updateMany({
      where: { employeeId },
      data: { validFrom: new Date("2026-10-26T00:00:00Z") },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    await cleanupTestData(app, fx.tenantId);
    await closeTestApp();
  });

  it("lists the person with the September tenant-default Soll as delta and writes nothing", async () => {
    const before = await app.prisma.saldoSnapshot.count({ where: { employeeId } });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((m: unknown) => {
      lines.push(String(m));
    });
    try {
      expect(await main(["--tenant-id", fx.tenantId], app.prisma)).toBe(EXIT_FINDINGS);
    } finally {
      spy.mockRestore();
    }
    // 22 September workdays x 8 h = 10560 min.
    expect(lines.some((l) => l.includes(`employeeId=${employeeId} deltaMinutes=10560`))).toBe(true);
    expect(await app.prisma.saldoSnapshot.count({ where: { employeeId } })).toBe(before);
  });
});
