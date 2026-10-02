/**
 * Issue #449 (D-3) — RED-then-GREEN + zero-mutation proof for
 * audit-multi-day-half-day-leave.ts.
 *
 * Fixture, tenant A:
 *   - multi-day halfDay PENDING   -> finding
 *   - multi-day halfDay APPROVED  -> finding
 *   - single-day halfDay          -> not a finding
 *   - multi-day full-day          -> not a finding
 *   - multi-day halfDay, deletedAt set -> not a finding
 * Tenant B: one multi-day halfDay row — a finding only in --all-tenants mode.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import {
  main,
  EXIT_OK,
  EXIT_FINDINGS,
  parseCli,
  formatFindingLine,
} from "../audit-multi-day-half-day-leave";
import type { FastifyInstance } from "fastify";

describe("audit-multi-day-half-day-leave (Issue #449, D-3)", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;

  let pendingFindingId: string;
  let approvedFindingId: string;
  let singleDayId: string;
  let multiDayFullDayId: string;
  let deletedId: string;
  let tenantBFindingId: string;

  beforeAll(async () => {
    app = await getTestApp();
    dataA = await seedTestData(app, "audit449a");
    dataB = await seedTestData(app, "audit449b");

    const mk = async (
      data: Awaited<ReturnType<typeof seedTestData>>,
      opts: {
        start: string;
        end: string;
        halfDay: boolean;
        status: "PENDING" | "APPROVED";
        deletedAt?: Date | null;
      },
    ) => {
      const row = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${opts.start}T00:00:00Z`),
          endDate: new Date(`${opts.end}T00:00:00Z`),
          days: opts.halfDay ? 0.5 : 1,
          halfDay: opts.halfDay,
          status: opts.status,
          reviewedBy: opts.status === "APPROVED" ? "system" : null,
          reviewedAt: opts.status === "APPROVED" ? new Date() : null,
          deletedAt: opts.deletedAt ?? null,
        },
      });
      return row.id;
    };

    pendingFindingId = await mk(dataA, {
      start: "2027-03-01",
      end: "2027-03-05",
      halfDay: true,
      status: "PENDING",
    });
    approvedFindingId = await mk(dataA, {
      start: "2027-04-01",
      end: "2027-04-05",
      halfDay: true,
      status: "APPROVED",
    });
    singleDayId = await mk(dataA, {
      start: "2027-05-01",
      end: "2027-05-01",
      halfDay: true,
      status: "PENDING",
    });
    multiDayFullDayId = await mk(dataA, {
      start: "2027-06-01",
      end: "2027-06-05",
      halfDay: false,
      status: "PENDING",
    });
    deletedId = await mk(dataA, {
      start: "2027-07-01",
      end: "2027-07-05",
      halfDay: true,
      status: "PENDING",
      deletedAt: new Date(),
    });
    tenantBFindingId = await mk(dataB, {
      start: "2027-08-01",
      end: "2027-08-05",
      halfDay: true,
      status: "PENDING",
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, dataA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("--tenant-id A finds exactly the two tenant-A multi-day half-day rows (exitCode 2)", async () => {
    const logSpy = (await import("vitest")).vi.spyOn(console, "info").mockImplementation(() => {});
    let code: number;
    try {
      code = await main(["--tenant-id", dataA.tenant.id], app.prisma);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(EXIT_FINDINGS);

    // Re-run capturing the findings via the printed lines (no exported array — black-box via
    // formatFindingLine's own shape, same technique dry-run-429's own test uses).
    const lines: string[] = [];
    const spy2 = (await import("vitest")).vi
      .spyOn(console, "info")
      .mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });
    try {
      await main(["--tenant-id", dataA.tenant.id], app.prisma);
    } finally {
      spy2.mockRestore();
    }
    const ids = lines
      .filter((l) => l.startsWith("leaveRequestId="))
      .map((l) => l.match(/leaveRequestId=([0-9a-f-]+)/)?.[1]);
    expect(ids.sort()).toEqual([pendingFindingId, approvedFindingId].sort());
    expect(ids).not.toContain(singleDayId);
    expect(ids).not.toContain(multiDayFullDayId);
    expect(ids).not.toContain(deletedId);
  });

  it("--all-tenants finds both tenant-A findings AND the tenant-B one (contains, not equal — shared worker DB)", async () => {
    const lines: string[] = [];
    const vi_ = (await import("vitest")).vi;
    const spy = vi_.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
    let code: number;
    try {
      code = await main(["--all-tenants"], app.prisma);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(EXIT_FINDINGS);
    const ids = lines
      .filter((l) => l.startsWith("leaveRequestId="))
      .map((l) => l.match(/leaveRequestId=([0-9a-f-]+)/)?.[1]);
    expect(ids).toEqual(
      expect.arrayContaining([pendingFindingId, approvedFindingId, tenantBFindingId]),
    );
  });

  it("a tenant with no findings returns EXIT_OK", async () => {
    const other = await app.prisma.tenant.create({
      data: {
        name: `audit449-empty-${Date.now().toString(36)}`,
        slug: `audit449-empty-${Date.now().toString(36)}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    try {
      const code = await main(["--tenant-id", other.id], app.prisma);
      expect(code).toBe(EXIT_OK);
    } finally {
      await app.prisma.tenant.delete({ where: { id: other.id } });
    }
  });

  it("main([]) throws the German tenant-selection error", async () => {
    await expect(main([], app.prisma)).rejects.toThrow(/Tenant-Auswahl erforderlich/);
  });

  it("parseCli throws on an unknown write flag (--confirm, --apply)", () => {
    expect(() => parseCli(["--confirm"])).toThrow();
    expect(() => parseCli(["--apply"])).toThrow();
  });

  it("formatFindingLine contains no PII (no employeeNumber, no name)", () => {
    const line = formatFindingLine({
      leaveRequestId: "11111111-1111-1111-1111-111111111111",
      employeeId: "22222222-2222-2222-2222-222222222222",
      tenantId: "33333333-3333-3333-3333-333333333333",
      status: "PENDING",
      typeCode: "VACATION",
      startDate: "2027-03-01",
      endDate: "2027-03-05",
      days: 0.5,
    });
    expect(line).toContain("leaveRequestId=11111111-1111-1111-1111-111111111111");
    expect(line).toContain("employeeId=22222222-2222-2222-2222-222222222222");
    expect(line).toContain("status=PENDING");
    expect(line).toContain("type=VACATION");
    expect(line).toContain("start=2027-03-01");
    expect(line).toContain("end=2027-03-05");
    expect(line).toContain("days=0.5");
    expect(line).not.toMatch(/emp-?\d+@/); // no seeded login-email-shaped fragment
  });

  it("zero mutations: updatedAt of every seeded row is unchanged after both runs", async () => {
    const ids = [
      pendingFindingId,
      approvedFindingId,
      singleDayId,
      multiDayFullDayId,
      deletedId,
      tenantBFindingId,
    ];
    const before = await app.prisma.leaveRequest.findMany({
      where: { id: { in: ids } },
      select: { id: true, updatedAt: true },
    });
    await main(["--tenant-id", dataA.tenant.id], app.prisma);
    await main(["--all-tenants"], app.prisma);
    const after = await app.prisma.leaveRequest.findMany({
      where: { id: { in: ids } },
      select: { id: true, updatedAt: true },
    });
    expect(after).toEqual(before);
  });

  it("the script source calls no Prisma write method", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../audit-multi-day-half-day-leave.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/\.(update|create|delete|updateMany|deleteMany|upsert)\(/);
  });
});
