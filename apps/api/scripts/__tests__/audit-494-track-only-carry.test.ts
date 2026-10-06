/**
 * Issue #494 (R6, D-06, D-13) — fixture matrix for audit-494-track-only-carry.ts.
 *
 * The script is a read-only dry-run: it lists the stored carry-over of closed MONTHLY snapshots
 * whose contract is track-only (MONTHLY_HOURS without monthly hours, or explicit TRACK_ONLY).
 * All values are minutes; snapshots are created directly (the script reads, it never closes).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  reissueTokenNow,
} from "../../src/__tests__/setup";
import { monthRangeUtc, monthDayBounds } from "../../src/contexts/working-time-account";
import { main, parseCli, EXIT_OK, EXIT_FINDINGS } from "../audit-494-track-only-carry";
import type { FastifyInstance } from "fastify";

const TZ = "Europe/Berlin";
const NOW = "2026-07-23T10:00:00.000Z";

const FIXED_40 = {
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
  overtimeMode: "CARRY_FORWARD",
  monthlyHours: null,
};

const MH_BASE = {
  type: "MONTHLY_HOURS",
  weeklyHours: 10,
  mondayHours: 1,
  tuesdayHours: 1,
  wednesdayHours: 1,
  thursdayHours: 1,
  fridayHours: 1,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5],
};

async function capture(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const code = await fn();
    return { code, lines };
  } finally {
    spy.mockRestore();
  }
}

describe("audit-494-track-only-carry (Issue #494, R6)", () => {
  let app: FastifyInstance;
  let dataA: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let n1: string;
  let n1b: string;
  let p1: string;
  let p2: string;
  let p3: string;
  let t1: string;
  let h1: string;
  let nB: string;
  let runA: { code: number; lines: string[] };
  let runAll: { code: number; lines: string[] };
  let fixtureEmpIds: string[];
  let stateBefore: string;

  // Every fixture row the script could conceivably touch, serialized. AuditLog has no tenantId
  // column — it is scoped by the fixture entity ids (ADR 0001-abweichungen, Eintrag W).
  async function fixtureState(): Promise<string> {
    const [snaps, schedules, entries] = await Promise.all([
      app.prisma.saldoSnapshot.findMany({
        where: { employeeId: { in: fixtureEmpIds } },
        orderBy: { id: "asc" },
      }),
      app.prisma.workSchedule.findMany({
        where: { employeeId: { in: fixtureEmpIds } },
        orderBy: { id: "asc" },
        select: { id: true, updatedAt: true },
      }),
      app.prisma.timeEntry.findMany({
        where: { employeeId: { in: fixtureEmpIds } },
        orderBy: { id: "asc" },
        select: { id: true, updatedAt: true, isLocked: true },
      }),
    ]);
    const entityIds = [
      ...fixtureEmpIds,
      ...snaps.map((r) => r.id),
      ...schedules.map((r) => r.id),
      ...entries.map((r) => r.id),
    ];
    const audit = await app.prisma.auditLog.count({ where: { entityId: { in: entityIds } } });
    return JSON.stringify({ snaps, schedules, entries, audit });
  }

  async function atClock<T>(fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }

  const lineFor = (lines: string[], prefix: string, id: string) =>
    lines.find((l) => l.startsWith(prefix) && l.includes(`employeeId=${id}`));

  async function createEmp(
    data: Awaited<ReturnType<typeof seedTestData>>,
    spec: {
      key: string;
      schedules: Array<{ validFrom: string; data: Record<string, unknown> }>;
      snapshots?: Array<{ month: number; carryOver: number; type?: "MONTHLY" | "YEARLY" }>;
      lockedEntry?: boolean;
    },
  ): Promise<string> {
    const s = `${spec.key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@a494.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `A494NUM-${s}`,
        firstName: `Vorname${spec.key}Zq`,
        lastName: `Nachname${spec.key}Zq`,
        hireDate: new Date("2026-03-01T00:00:00Z"),
        isTimeTrackingExempt: false,
      },
    });
    for (const sch of spec.schedules) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: emp.id,
          validFrom: new Date(`${sch.validFrom}T00:00:00Z`),
          ...sch.data,
        } as never,
      });
    }
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    for (const snap of spec.snapshots ?? []) {
      const { start, end } = monthRangeUtc(2026, snap.month, TZ);
      const { firstDay, lastDay } = monthDayBounds(start, end, TZ);
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: emp.id,
          periodType: snap.type ?? "MONTHLY",
          periodStart: firstDay,
          periodEnd: lastDay,
          workedMinutes: 300,
          expectedMinutes: 0,
          balanceMinutes: snap.carryOver,
          carryOver: snap.carryOver,
          closedAt: new Date(end.getTime() + 24 * 60 * 60_000),
          closedBy: "a494-seed",
        },
      });
    }
    if (spec.lockedEntry) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: emp.id,
          date: new Date("2026-03-10T00:00:00Z"),
          startTime: new Date("2026-03-10T08:00:00Z"),
          endTime: new Date("2026-03-10T13:00:00Z"),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          salonId: data.salonId,
          isLocked: true,
        },
      });
    }
    return emp.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    dataA = await seedTestData(app, "audit494a");
    n1 = await createEmp(dataA, {
      key: "N1",
      schedules: [
        {
          validFrom: "2026-03-01",
          data: { ...MH_BASE, monthlyHours: null, overtimeMode: "CARRY_FORWARD" },
        },
      ],
      snapshots: [
        { month: 3, carryOver: 600 },
        { month: 3, carryOver: 600, type: "YEARLY" },
      ],
      lockedEntry: true,
    });
    const mhNull = { ...MH_BASE, monthlyHours: null, overtimeMode: "CARRY_FORWARD" };
    n1b = await createEmp(dataA, {
      key: "N1b",
      schedules: [{ validFrom: "2026-03-01", data: mhNull }],
      snapshots: [{ month: 3, carryOver: 600 }],
    });
    p1 = await createEmp(dataA, {
      key: "P1",
      schedules: [
        {
          validFrom: "2026-03-01",
          data: { ...MH_BASE, monthlyHours: 15, overtimeMode: "CARRY_FORWARD" },
        },
      ],
      snapshots: [{ month: 3, carryOver: 600 }],
    });
    p2 = await createEmp(dataA, {
      key: "P2",
      schedules: [{ validFrom: "2026-03-01", data: FIXED_40 }],
      snapshots: [{ month: 3, carryOver: -600 }],
    });
    p3 = await createEmp(dataA, {
      key: "P3",
      schedules: [{ validFrom: "2026-03-01", data: mhNull }],
      snapshots: [{ month: 3, carryOver: 0 }],
    });
    t1 = await createEmp(dataA, {
      key: "T1",
      schedules: [
        {
          validFrom: "2026-03-01",
          data: { ...MH_BASE, monthlyHours: 15, overtimeMode: "TRACK_ONLY" },
        },
      ],
      snapshots: [{ month: 3, carryOver: 600 }],
    });
    // Probe S4 shape: track-only first contract with a stored carry, then a contract WITH a target.
    h1 = await createEmp(dataA, {
      key: "H1",
      schedules: [
        { validFrom: "2026-03-01", data: mhNull },
        { validFrom: "2026-04-01", data: FIXED_40 },
      ],
      snapshots: [{ month: 3, carryOver: 2088 }],
    });

    dataB = await seedTestData(app, "audit494b");
    nB = await createEmp(dataB, {
      key: "NB",
      schedules: [{ validFrom: "2026-03-01", data: mhNull }],
      snapshots: [{ month: 3, carryOver: 600 }],
    });

    fixtureEmpIds = [n1, n1b, p1, p2, p3, t1, h1, nB];
    stateBefore = await fixtureState();

    runA = await atClock(() => capture(() => main(["--tenant-id", dataA.tenant.id], app.prisma)));
    // The shared worker database holds hundreds of leftover tenants — one scan only, reused below.
    runAll = await capture(() => main(["--all-tenants"], app.prisma));
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, dataA.tenant.id);
    } catch (err) {
      console.error("audit494 cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("audit494 cleanup (B) failed:", err);
    }
    await closeTestApp();
  });

  it("tracer: a 0 h CARRY_FORWARD employee's locked closed month with stored carry is listed (NO_TARGET), summary carries before/after, exit 2", async () => {
    const { code, lines } = await capture(() => main(["--tenant-id", dataA.tenant.id], app.prisma));
    expect(code).toBe(EXIT_FINDINGS);

    const finding = lines.find((l) => l.startsWith("finding ") && l.includes(`employeeId=${n1}`));
    expect(finding).toBeDefined();
    expect(finding).toMatch(/snapshotId=[0-9a-f-]{36}/);
    expect(finding).toContain("month=2026-03");
    expect(finding).toContain("storedCarryOver=600");
    expect(finding).toContain("locked=true");
    expect(finding).toContain("reason=NO_TARGET");

    const summary = lines.find((l) => l.startsWith("employee ") && l.includes(`employeeId=${n1}`));
    expect(summary).toBeDefined();
    expect(summary).toContain("lastActiveCarryOver=600");
    expect(summary).toContain("liveAfterMinutes=0");
    expect(summary).toContain("todayContractAffected=true");
  });
  it("lists a locked-free month with locked=false (N1b)", () => {
    const line = lineFor(runA.lines, "finding ", n1b);
    expect(line).toBeDefined();
    expect(line).toContain("locked=false");
    expect(line).toContain("reason=NO_TARGET");
  });

  it("does not list a contract with monthly hours (P1, R2)", () => {
    expect(lineFor(runA.lines, "finding ", p1)).toBeUndefined();
    expect(lineFor(runA.lines, "employee ", p1)).toBeUndefined();
  });

  it("does not list a FIXED_SCHEDULE contract with a stored carry (P2, R3)", () => {
    expect(lineFor(runA.lines, "finding ", p2)).toBeUndefined();
  });

  it("does not list a track-only month whose stored carry is already 0 (P3)", () => {
    expect(lineFor(runA.lines, "finding ", p3)).toBeUndefined();
  });

  it("labels an explicit TRACK_ONLY contract with TRACK_ONLY_MODE (T1, D-13)", () => {
    const line = lineFor(runA.lines, "finding ", t1);
    expect(line).toBeDefined();
    expect(line).toContain("reason=TRACK_ONLY_MODE");
    expect(line).toContain("overtimeMode=TRACK_ONLY");
    expect(line).toContain("monthlyHours=15");
  });

  it("flags a later contract with a target as priority=HIGH (H1, probe S4)", () => {
    const summary = lineFor(runA.lines, "employee ", h1);
    expect(summary).toBeDefined();
    expect(summary).toContain("laterContractWithTarget=true");
    expect(summary).toContain("priority=HIGH");
    expect(summary).toContain("todayContractAffected=false");
    expect(summary).toContain("lastActiveCarryOver=2088");
  });

  it("liveAfterMinutes equals the live figure of GET /api/v1/overtime/:id at the same instant (H1)", async () => {
    const res = await atClock(() =>
      app.inject({
        method: "GET",
        url: `/api/v1/overtime/${h1}`,
        headers: { authorization: `Bearer ${reissueTokenNow(app, dataA.adminToken)}` },
      }),
    );
    expect(res.statusCode).toBe(200);
    const liveMinutes = Math.round(Number(JSON.parse(res.body).balanceHours) * 60);
    const summary = lineFor(runA.lines, "employee ", h1)!;
    expect(summary).toContain(`liveAfterMinutes=${liveMinutes}`);
  });

  it("reports the YEARLY snapshots with a non-zero carry (N1) and a normal priority", () => {
    const summary = lineFor(runA.lines, "employee ", n1)!;
    expect(summary).toContain("yearlyNonZeroCarry=1");
    expect(summary).toContain("priority=normal");
    expect(summary).toContain("laterContractWithTarget=false");
  });

  it("--tenant-id A output contains no tenant-B id; --all-tenants contains both", () => {
    expect(runA.lines.some((l) => l.includes(nB))).toBe(false);
    expect(runA.lines.some((l) => l.includes(dataB.tenant.id))).toBe(false);

    expect(runAll.code).toBe(EXIT_FINDINGS);
    expect(runAll.lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`employeeId=${n1}`),
        expect.stringContaining(`employeeId=${nB}`),
      ]),
    );
  });

  it("an empty tenant exits 0", async () => {
    const suffix = Date.now().toString(36);
    const tenant = await app.prisma.tenant.create({
      data: {
        name: `Empty ${suffix}`,
        slug: `a494-empty-${suffix}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    try {
      const { code } = await capture(() => main(["--tenant-id", tenant.id], app.prisma));
      expect(code).toBe(EXIT_OK);
    } finally {
      await app.prisma.tenant.delete({ where: { id: tenant.id } });
    }
  });

  it("rejects a missing or doubled tenant selection with the German message", async () => {
    await expect(main([])).rejects.toThrow(/Tenant-Auswahl erforderlich/);
    await expect(
      main(["--tenant-id", dataA.tenant.id, "--all-tenants"], app.prisma),
    ).rejects.toThrow(/Tenant-Auswahl erforderlich/);
  });

  it("has no write flag: --apply and --confirm are rejected, --help exits 0", async () => {
    expect(() => parseCli(["--apply"])).toThrow();
    expect(() => parseCli(["--confirm"])).toThrow();
    const { code } = await capture(() => main(["--help"]));
    expect(code).toBe(EXIT_OK);
  });

  it("is read-only: fixture rows and the scoped audit log are unchanged by the runs", async () => {
    expect(await fixtureState()).toBe(stateBefore);

    const source = readFileSync(
      fileURLToPath(new URL("../audit-494-track-only-carry.ts", import.meta.url)),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000);
    expect(source).not.toMatch(
      /\.(update|create|delete|updateMany|deleteMany|upsert|createMany)\(/,
    );
  });

  it("prints ids only: no name, employee number or e-mail appears in any output line", () => {
    const output = [...runA.lines, ...runAll.lines].join("\n");
    expect(output).toContain(`employeeId=${n1}`); // the output is not vacuously empty
    expect(output).not.toMatch(/Vorname|Nachname|A494NUM|a494\.test/);
  });
});
