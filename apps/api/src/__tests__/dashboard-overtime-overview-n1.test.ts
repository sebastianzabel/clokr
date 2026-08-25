/**
 * dashboard-overtime-overview-n1.test.ts
 *
 * Phase 97-04 (SALDO-DISP-01/02/04) — N+1 query regression guard for
 * GET /dashboard/overtime-overview, the ONE list endpoint in this phase's scope.
 *
 * The "Bestätigt" carry-over for the whole team list MUST be loaded with exactly ONE bulk
 * findMany (getConfirmedCarryOverBulk, see ../utils/confirmed-saldo.ts), placed BEFORE the
 * existing per-employee Promise.all — never a per-employee query inside it.
 *
 * Scope note (read this before "fixing" a failure here): the per-employee
 * computeOvertimeBalanceBreakdown fan-out INSIDE the Promise.all (one
 * saldoSnapshot.findFirst call per employee, via the shared helper in
 * ../routes/time-entries.ts) is PRE-EXISTING and deliberately NOT changed by this phase (see
 * 97-04-PLAN.md, Task 2). `findFirst` is a different Prisma method from `findMany`, so this
 * guard's `saldoSnapshot.findMany` spy does not (and is not meant to) observe that fan-out —
 * it stays O(employees) exactly as it did before Phase 97-04. This file only pins the query
 * COUNT of `saldoSnapshot.findMany` and `overtimeAccount.findMany`, not the total DB
 * round-trip count of the endpoint.
 *
 * RED (before this plan's Task 2): a naive implementation calling the single-employee
 * getConfirmedCarryOver inside the Promise.all would add one saldoSnapshot.findFirst call per
 * employee on top of the pre-existing fan-out — invisible to this guard's findMany spy, which
 * is exactly why the plan mandates the bulk helper (a single findMany) instead of merely
 * "not regressing" the finrFirst count.
 * GREEN (after Task 2): saldoSnapshot.findMany is called at most twice (the pre-existing
 * six-month sparkline query + the one new bulk confirmed-carry-over query) and
 * overtimeAccount.findMany at most once, regardless of employee count.
 *
 * Dates are resolved through a frozen system clock at a safe mid-day UTC instant (never UTC
 * midnight), applied per-test via vi.useFakeTimers({ toFake: ["Date"] }) — the SAME idiom as
 * apps/api/src/__tests__/overtime-live-vs-monthsaldo-parity.test.ts (Phase 97-01) — so "today"
 * inside computeOvertimeBalanceBreakdown's tenant-timezone resolution never straddles the
 * documented 00:00-02:00 CEST fixture window (see
 * .planning/phases/98-saldo-ketten-integritaetspruefung/deferred-items.md).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

const FROZEN_NOW = new Date("2026-07-15T10:00:00.000Z");

/** Create a non-exempt FIXED_SCHEDULE employee with an OvertimeAccount, growing the tenant
 *  towards "at least six employees" — proves the query counts below don't scale with headcount. */
async function createExtraEmployee(app: FastifyInstance, tenantId: string, idx: number) {
  const s = `dov1-${idx}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const user = await app.prisma.user.create({
    data: {
      email: `dov1-${s}@test.de`,
      passwordHash: "x",
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `DOV1-${s}`.slice(0, 20),
      firstName: "Overview",
      lastName: `N1-${idx}`,
      hireDate: new Date("2024-01-01"),
      isTimeTrackingExempt: false,
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: emp.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2024-01-01"),
    },
  });
  await app.prisma.overtimeAccount.create({
    data: { employeeId: emp.id, balanceHours: 0 },
  });
  return { userId: user.id, empId: emp.id };
}

/**
 * Create a §18 ArbZG-exempt employee whose ONLY SaldoSnapshot predates the six-month window
 * of dashboard.ts's own sparkline query (Query 2) — the fixture for the "long-tenure
 * employee" regression case.
 *
 * Exempt on purpose: computeOvertimeBalanceBreakdown deterministically returns null for an
 * exempt employee, which routes GET /dashboard/overtime-overview's handler through the SAME
 * fallback branch that reads confirmedMinutes/hasClosedMonth from the pre-fetched bulk Map —
 * the one code path that would visibly regress to 0/false if a future edit swapped the
 * unbounded getConfirmedCarryOverBulk for the bounded six-month sparkline array.
 */
async function createLongTenureExemptEmployee(app: FastifyInstance, tenantId: string) {
  const s = `dov1-lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const user = await app.prisma.user.create({
    data: {
      email: `dov1-lt-${s}@test.de`,
      passwordHash: "x",
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `DOV1LT-${s}`.slice(0, 20),
      firstName: "LongTenure",
      lastName: "Exempt",
      hireDate: new Date("2020-01-01"),
      isTimeTrackingExempt: true,
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: emp.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2020-01-01"),
    },
  });
  await app.prisma.overtimeAccount.create({
    data: { employeeId: emp.id, balanceHours: 12 },
  });
  // ~10 months before FROZEN_NOW — well outside dashboard.ts's own six-month sparkline window,
  // but getConfirmedCarryOverBulk is deliberately unbounded (see confirmed-saldo.ts).
  await app.prisma.saldoSnapshot.create({
    data: {
      employeeId: emp.id,
      periodType: "MONTHLY",
      periodStart: new Date("2025-09-01"),
      periodEnd: new Date("2025-09-30"),
      workedMinutes: 9600,
      expectedMinutes: 9120,
      balanceMinutes: 480,
      carryOver: 480,
      closedAt: new Date("2025-10-01T06:00:00Z"),
      superseded: false,
    },
  });
  return { userId: user.id, empId: emp.id };
}

describe("GET /dashboard/overtime-overview — N+1 query regression guard (Phase 97-04)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let longTenureEmpId: string;

  beforeAll(async () => {
    app = await getTestApp();
    // seedTestData creates adminEmployee + employee = 2 non-exempt employees.
    // Add 4 more for a total of 6 — proves query count is independent of employee count.
    data = await seedTestData(app, "dov1");
    for (let i = 0; i < 4; i++) {
      await createExtraEmployee(app, data.tenant.id, i);
    }
    const longTenure = await createLongTenureExemptEmployee(app, data.tenant.id);
    longTenureEmpId = longTenure.empId;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("dashboard-overtime-overview-n1 cleanup failed:", err);
    }
    await closeTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saldoSnapshot.findMany called at most twice and overtimeAccount.findMany at most once, regardless of employee count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const spies = {
        snapshot: vi.spyOn(app.prisma.saldoSnapshot, "findMany"),
        account: vi.spyOn(app.prisma.overtimeAccount, "findMany"),
      };

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overtime-overview",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { employees: unknown[] };
      // 7 employees total (2 from seedTestData + 4 extra + 1 long-tenure) — the assertions
      // below being independent of THIS count (not just "small") is the actual guard.
      expect(body.employees.length).toBeGreaterThanOrEqual(7);

      // Query 2 (six-month sparkline) + the one new bulk confirmed-carry-over lookup — never
      // one call per employee, regardless of how many employees exist in the tenant.
      expect(spies.snapshot.mock.calls.length).toBeLessThanOrEqual(2);
      // Query 1 (accounts joined with employee) — exactly once, not re-queried per employee.
      expect(spies.account.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("every row carries the confirmed/forecast split alongside the existing balanceHours/status/snapshots shape", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overtime-overview",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        employees: Array<{
          id: string;
          name: string;
          employeeNumber: string;
          balanceHours: number;
          status: string;
          confirmedMinutes: number;
          openMonthMinutes: number | null;
          hasClosedMonth: boolean;
          snapshots: unknown[];
        }>;
      };
      expect(body.employees.length).toBeGreaterThan(0);
      for (const row of body.employees) {
        expect(typeof row.balanceHours).toBe("number");
        expect(typeof row.status).toBe("string");
        expect(Array.isArray(row.snapshots)).toBe(true);
        expect(typeof row.confirmedMinutes).toBe("number");
        expect(typeof row.hasClosedMonth).toBe("boolean");
        expect(row.openMonthMinutes === null || typeof row.openMonthMinutes === "number").toBe(
          true,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("an employee whose only snapshot predates the six-month sparkline window still returns a real confirmed figure, not a new-hire zero", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overtime-overview",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        employees: Array<{
          id: string;
          confirmedMinutes: number;
          hasClosedMonth: boolean;
          openMonthMinutes: number | null;
        }>;
      };
      const row = body.employees.find((e) => e.id === longTenureEmpId);
      expect(row).toBeDefined();
      // Would read as confirmedMinutes: 0 / hasClosedMonth: false if the confirmed lookup were
      // mistakenly bounded to the same six-month window as the sparkline query (Query 2) — the
      // exact regression the bulk helper's own unbounded query exists to prevent.
      expect(row!.confirmedMinutes).toBe(480);
      expect(row!.hasClosedMonth).toBe(true);
      // §18-exempt → the fail-safe branch, never a fabricated zero forecast.
      expect(row!.openMonthMinutes).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
