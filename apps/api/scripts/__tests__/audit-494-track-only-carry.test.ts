/**
 * Issue #494 (R6, D-06, D-13) — fixture matrix for audit-494-track-only-carry.ts.
 *
 * The script is a read-only dry-run: it lists the stored carry-over of closed MONTHLY snapshots
 * whose contract is track-only (MONTHLY_HOURS without monthly hours, or explicit TRACK_ONLY).
 * All values are minutes; snapshots are created directly (the script reads, it never closes).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { monthRangeUtc, monthDayBounds } from "../../src/contexts/working-time-account";
import { main, EXIT_FINDINGS } from "../audit-494-track-only-carry";
import type { FastifyInstance } from "fastify";

const TZ = "Europe/Berlin";

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
  let n1: string;

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
      snapshots: [{ month: 3, carryOver: 600 }],
      lockedEntry: true,
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, dataA.tenant.id);
    } catch (err) {
      console.error("audit494 cleanup failed:", err);
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
});
