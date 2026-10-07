/**
 * Issue #494 (D-11, D-03) — migrate-opening-balances.ts skips an employee only when the head
 * link of its chain is the track-only ZEROING signature (track-only contract AND stored carry 0).
 *
 * Widening the old skip to "every track-only contract" would silently hide a documented opening
 * balance on a Minijob row (MONTHLY_HOURS without monthly hours, CARRY_FORWARD) — the exact
 * failure the migration exists to prevent. Everything runs through main() in dry-run mode
 * (no --apply), so the tests also prove that nothing is written.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { monthRangeUtc, monthDayBounds } from "../../src/contexts/working-time-account";
import { main, truncId, EXIT_OK, EXIT_NEEDS_REVIEW } from "../migrate-opening-balances";
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

describe("migrate-opening-balances narrowed track-only skip (Issue #494, D-11)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let p: string;
  let q: string;
  let r: string;
  let lines: string[];
  let code: number;
  let stateBefore: string;
  let stateAfter: string;

  async function createEmp(spec: {
    key: string;
    schedule: Record<string, unknown>;
    worked: number;
    carryOver: number;
  }): Promise<string> {
    const s = `${spec.key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@mob494.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `MOB494-${s}`,
        firstName: `Vorname${spec.key}Zq`,
        lastName: `Nachname${spec.key}Zq`,
        hireDate: new Date("2026-03-01T00:00:00Z"),
        isTimeTrackingExempt: false,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        validFrom: new Date("2026-03-01T00:00:00Z"),
        ...spec.schedule,
      } as never,
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    const { start, end } = monthRangeUtc(2026, 3, TZ);
    const { firstDay, lastDay } = monthDayBounds(start, end, TZ);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: firstDay,
        periodEnd: lastDay,
        workedMinutes: spec.worked,
        expectedMinutes: 0,
        balanceMinutes: spec.worked,
        carryOver: spec.carryOver,
        closedAt: new Date(end.getTime() + 24 * 60 * 60_000),
        closedBy: "mob494-seed",
      },
    });
    return emp.id;
  }

  async function fixtureState(): Promise<string> {
    const ids = [p, q, r];
    const [snaps, balances] = await Promise.all([
      app.prisma.saldoSnapshot.findMany({
        where: { employeeId: { in: ids } },
        orderBy: { id: "asc" },
      }),
      app.prisma.openingBalance.findMany({ where: { employeeId: { in: ids } } }),
    ]);
    return JSON.stringify({ snaps, balances });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mob494");
    // P: documented opening balance on a Minijob row (head delta +600) — must stay visible.
    p = await createEmp({
      key: "P",
      schedule: { ...MH_BASE, monthlyHours: null, overtimeMode: "CARRY_FORWARD" },
      worked: 0,
      carryOver: 600,
    });
    // Q: the zeroing signature (track-only, stored carry 0 over 300 worked) — skipped silently.
    q = await createEmp({
      key: "Q",
      schedule: { ...MH_BASE, monthlyHours: null, overtimeMode: "CARRY_FORWARD" },
      worked: 300,
      carryOver: 0,
    });
    // R: explicit TRACK_ONLY with a non-zero stored carry — no longer hidden.
    r = await createEmp({
      key: "R",
      schedule: { ...MH_BASE, monthlyHours: 15, overtimeMode: "TRACK_ONLY" },
      worked: 0,
      carryOver: 600,
    });

    stateBefore = await fixtureState();
    lines = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      code = await main(["--tenant-id", data.tenant.id], app.prisma);
    } finally {
      spy.mockRestore();
    }
    stateAfter = await fixtureState();
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("mob494 cleanup failed:", err);
    }
    await closeTestApp();
  });

  const lineFor = (id: string) => lines.filter((l) => l.includes(`emp=${truncId(id)}`));

  it("the run is a dry-run", () => {
    expect(lines.some((l) => l.includes("Mode: DRY-RUN"))).toBe(true);
    expect([EXIT_OK, EXIT_NEEDS_REVIEW]).toContain(code);
  });

  it("P (0 h CARRY_FORWARD Minijob, documented head carry) still reaches classification", () => {
    expect(lineFor(p).length).toBe(1);
  });

  it("Q (track-only zeroing signature, stored carry 0) is skipped silently", () => {
    expect(lineFor(q)).toEqual([]);
  });

  it("R (TRACK_ONLY with a non-zero stored carry) is no longer hidden", () => {
    expect(lineFor(r).length).toBe(1);
  });

  it("writes nothing: no OpeningBalance row, snapshot rows byte-identical", async () => {
    expect(stateAfter).toBe(stateBefore);
    expect(JSON.parse(stateAfter).balances).toEqual([]);
  });
});
