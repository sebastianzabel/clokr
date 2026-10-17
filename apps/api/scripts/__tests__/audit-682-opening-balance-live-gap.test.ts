/**
 * Issue #682 - audit-682-opening-balance-live-gap.ts is a read-only listing.
 *
 * One integration case runs `main` against two seeded tenants and proves (a) exactly the persons
 * whose live saldo moves with #682 are listed, with the gap measured by the production live code,
 * (b) no row of any table the script could touch changes. Faked clock 2026-07-15, in the past of
 * every real run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  grantSystemRole,
} from "../../src/__tests__/setup";
import { saldoSnapshotPeriodBounds } from "../../src/__tests__/test-dates";
import { main, parseCli, EXIT_OK, EXIT_FINDINGS } from "../audit-682-opening-balance-live-gap";

const FAKE_NOW = new Date("2026-07-15T10:00:00.000Z");

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    return { code: await fn(), lines };
  } finally {
    spy.mockRestore();
  }
}

describe("audit-682-opening-balance-live-gap (Issue #682)", () => {
  let app: FastifyInstance;
  let tenantA: string;
  let tenantB: string;
  let adminUserId: string;
  const ids: Record<string, string> = {};
  const salonOf: Record<string, string> = {};

  async function person(
    tenantId: string,
    key: string,
    trackOnly = false,
    exempt = false,
  ): Promise<string> {
    const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `a682-${key}-${unique}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `A682-${key}-${unique}`,
        firstName: `Vorname${key}`,
        lastName: `A682${key}`,
        hireDate: new Date("2026-05-01T00:00:00Z"),
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
        isTimeTrackingExempt: exempt,
      },
    });
    await grantSystemRole(app.prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    await app.prisma.workSchedule.create({
      data: trackOnly
        ? {
            employeeId: employee.id,
            validFrom: new Date("2026-05-01T00:00:00Z"),
            type: "MONTHLY_HOURS",
            weeklyHours: 0,
            monthlyHours: 160,
            workDays: [1, 2, 3, 4, 5],
            overtimeMode: "TRACK_ONLY",
          }
        : {
            employeeId: employee.id,
            validFrom: new Date("2026-05-01T00:00:00Z"),
            type: "FIXED_SCHEDULE",
            weeklyHours: 40,
            mondayHours: 8,
            tuesdayHours: 8,
            wednesdayHours: 8,
            thursdayHours: 8,
            fridayHours: 8,
            saturdayHours: 0,
            sundayHours: 0,
            workDays: [1, 2, 3, 4, 5],
          },
    });
    // One worked day so the chain carries a balance of its own besides the OpeningBalance.
    const start = new Date("2026-06-02T06:00:00Z");
    await app.prisma.timeEntry.create({
      data: {
        employeeId: employee.id,
        date: new Date("2026-06-02T00:00:00Z"),
        startTime: start,
        endTime: new Date(start.getTime() + 9 * 60 * 60_000),
        breakMinutes: 30,
        type: "WORK",
        salonId: salonOf[tenantId]!,
      },
    });
    return employee.id;
  }

  async function ob(employeeId: string, minutes: number, superseded = false) {
    await app.prisma.openingBalance.create({
      data: {
        employeeId,
        minutes,
        effectiveFrom: new Date("2026-05-01T00:00:00Z"),
        reason: "Fixture 682 audit",
        source: "ADMIN_ENTRY",
        createdBy: adminUserId,
        superseded,
        supersededReason: superseded ? "Fixture 682 superseded" : null,
      },
    });
  }

  const tableState = async () => ({
    openingBalance: await app.prisma.openingBalance.findMany({ orderBy: { id: "asc" } }),
    saldoSnapshot: await app.prisma.saldoSnapshot.findMany({ orderBy: { id: "asc" } }),
    overtimeAccount: await app.prisma.overtimeAccount.findMany({ orderBy: { id: "asc" } }),
    auditLog: await app.prisma.auditLog.count(),
  });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    app = await getTestApp();
    const a = await seedTestData(app, "a682a");
    const b = await seedTestData(app, "a682b");
    tenantA = a.tenant.id;
    tenantB = b.tenant.id;
    salonOf[tenantA] = a.salonId;
    salonOf[tenantB] = b.salonId;
    adminUserId = a.adminUser.id;

    ids.listed = await person(tenantA, "L");
    await ob(ids.listed, 600);
    ids.negative = await person(tenantA, "N");
    await ob(ids.negative, -240);
    ids.closed = await person(tenantA, "C");
    await ob(ids.closed, 600);
    const may = saldoSnapshotPeriodBounds(new Date(Date.UTC(2026, 4, 1)));
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: ids.closed,
        periodType: "MONTHLY",
        periodStart: may.start,
        periodEnd: may.end,
        workedMinutes: 9000,
        expectedMinutes: 9000,
        balanceMinutes: 0,
        carryOver: 600,
        closedAt: new Date("2026-06-01T06:00:00Z"),
        superseded: false,
      },
    });
    ids.superseded = await person(tenantA, "S");
    await ob(ids.superseded, 900, true);
    ids.trackOnly = await person(tenantA, "T", true);
    await ob(ids.trackOnly, 600);
    ids.exempt = await person(tenantA, "E", false, true);
    await ob(ids.exempt, 600);
    ids.otherTenant = await person(tenantB, "B");
    await ob(ids.otherTenant, 300);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      for (const t of [tenantA, tenantB]) {
        await app.prisma.openingBalance.deleteMany({ where: { employee: { tenantId: t } } });
        await cleanupTestData(app, t);
      }
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("CLI: a tenant choice is required; write flags are rejected", async () => {
    await expect(main([])).rejects.toThrow(/Tenant-Auswahl/);
    expect(() => parseCli(["--all-tenants", "--confirm"])).toThrow();
    expect(() => parseCli(["--all-tenants", "--apply"])).toThrow();
  });

  it("lists exactly the persons without a closed month whose live saldo moves, with the measured gap; writes nothing", async () => {
    const before = await tableState();
    const { code, lines } = await capture(() => main(["--tenant-id", tenantA], app.prisma));
    expect(await tableState()).toEqual(before);

    expect(code).toBe(EXIT_FINDINGS);
    const findings = lines.filter((l) => l.startsWith("employee "));
    expect(findings.sort()).toEqual(
      [
        `employee tenantId=${tenantA} employeeId=${ids.listed} gapMinutes=600`,
        `employee tenantId=${tenantA} employeeId=${ids.negative} gapMinutes=-240`,
      ].sort(),
    );
    const text = lines.join("\n");
    expect(text).toMatch(/5 active opening balance\(s\) in 1 tenant\(s\): 1 with a closed month/);
    expect(text).toMatch(/1 without a closed month but no change/);
    expect(text).toMatch(/1 exempt/);
    // Ids only: no fixture name or employee number ever appears.
    expect(text).not.toMatch(/A682|Vorname/);
  });

  it("--all-tenants includes the other tenant; a tenant without findings exits 0", async () => {
    const all = await capture(() => main(["--all-tenants"], app.prisma));
    expect(all.lines.some((l) => l.includes(`employeeId=${ids.otherTenant} gapMinutes=300`))).toBe(
      true,
    );
    const onlyB = await capture(() => main(["--tenant-id", tenantB], app.prisma));
    expect(onlyB.code).toBe(EXIT_FINDINGS);
    const none = await capture(() =>
      main(["--tenant-id", "00000000-0000-4000-8000-000000000000"], app.prisma),
    );
    expect(none.code).toBe(EXIT_OK);
  });
});

describe("source (read-only)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../audit-682-opening-balance-live-gap.ts", import.meta.url)),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("contains no Prisma write call and no write flag", () => {
    expect(source.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(code).not.toMatch(/\$executeRaw|\$transaction/);
    expect(code).not.toMatch(/["'](apply|confirm)["']/);
  });
});
