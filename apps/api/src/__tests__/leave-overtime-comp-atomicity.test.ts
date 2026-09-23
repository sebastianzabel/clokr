/**
 * leave-overtime-comp-atomicity.test.ts
 *
 * Issue #294 — the manual OvertimeTransaction booking and the balance recomputation used to be
 * two unrelated writes at the leave-approval / cancellation-review sites, and the recompute was
 * swallowed by `.catch()`. A dead process or a thrown recompute left a receipt standing on a
 * balance that was never recomputed, and the request still answered 200. This file pins the
 * fix's observable contract:
 *   - a failing recompute answers non-2xx, leaves ZERO receipt rows, and the stored balance
 *     unchanged;
 *   - a successful approval is unchanged end to end (one receipt row, stored balance equal to
 *     the recomputed value);
 *   - a §18-exempt employee's manual booking remains the sole writer and the request still 200s.
 *
 * Spawned as a separate file because the failure injection is module-scoped — the same reason
 * `school-holidays-sync.test.ts` / `vocational-school-pattern-sync.test.ts` are split out. Mocks
 * the deep module `../contexts/working-time-account/overtime-balance`; `leave.ts` imports
 * `computeOvertimeBalanceHours` through the `working-time-account` BARREL (`index.ts`), which
 * re-exports this module, so the route picks the stub up transparently. Every other export of
 * the module stays real — only the pure-read computation is replaced.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/** Set by the failing-recompute test only; every other test leaves this `null` (real behaviour). */
let forceComputeError: Error | null = null;

vi.mock("../contexts/working-time-account/overtime-balance", async () => {
  const actual = await vi.importActual<
    typeof import("../contexts/working-time-account/overtime-balance")
  >("../contexts/working-time-account/overtime-balance");
  return {
    ...actual,
    computeOvertimeBalanceHours: async (
      ...args: Parameters<typeof actual.computeOvertimeBalanceHours>
    ) => {
      if (forceComputeError) throw forceComputeError;
      return actual.computeOvertimeBalanceHours(...args);
    },
  };
});

// Import setup AFTER vi.mock — the two precedent files (school-holidays-sync.test.ts,
// vocational-school-pattern-sync.test.ts) do the same so the app's route wiring, built inside
// getTestApp(), picks up the stubbed barrel re-export rather than the real module.
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { holidayFreeMondayStr } from "./test-dates";
import { leaveTypeFields } from "../contexts/absence/leave-type";

/** Tolerance for the Decimal(…)-backed `balanceHours` round trip — same as overtime-comp-saldo.test.ts. */
const H = 5;

describe("Überstundenausgleich booking + recompute atomicity (issue #294)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let overtimeCompTypeId: string;
  let fixtureCounter = 0;

  /** A Monday in the PAST: the live recompute window ends at today/yesterday, so a future day
   *  would sit outside it and the whole measurement would read 0 on every branch. */
  const DAY = holidayFreeMondayStr(-8);

  /** One fresh employee per scenario — the balance is a lifetime figure, so two scenarios
   *  sharing an employee would read each other's leave rows. */
  async function makeEmployee(opts: { exempt?: boolean; balanceHours?: number } = {}) {
    const n = ++fixtureCounter;
    const s = `${Date.now().toString(36)}-atom${n}`;
    const user = await app.prisma.user.create({
      data: { email: `otc-atom-${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const hire = new Date(DAY + "T00:00:00Z");
    hire.setUTCDate(1);
    hire.setUTCMonth(hire.getUTCMonth() - 3);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `OTC-ATOM-${s}`,
        firstName: "Test",
        lastName: `AtomFixture${n}`,
        hireDate: hire,
        isTimeTrackingExempt: Boolean(opts.exempt),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: hire,
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: opts.balanceHours ?? 0 },
    });
    return employee;
  }

  async function createRequest(employeeId: string) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: overtimeCompTypeId,
        startDate: new Date(DAY),
        endDate: new Date(DAY),
        days: 1,
        halfDay: false,
        status: "PENDING",
      },
    });
  }

  async function review(id: string, token: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "APPROVED" },
    });
  }

  async function balanceOf(employeeId: string): Promise<number> {
    const acct = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
    return Number(acct!.balanceHours);
  }

  async function receiptCountOf(employeeId: string): Promise<number> {
    const acct = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
    if (!acct) return 0;
    return app.prisma.overtimeTransaction.count({ where: { overtimeAccountId: acct.id } });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "otc-atomic");

    const otc = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("OVERTIME_COMP"), color: "#8B5CF6" },
    });
    overtimeCompTypeId = otc.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(() => {
    forceComputeError = null;
  });

  it("failing recompute: the approval answers non-2xx, leaves ZERO receipt rows, and the stored balance unchanged (#294)", async () => {
    const emp = await makeEmployee({ balanceHours: 10 });
    const req = await createRequest(emp.id);

    forceComputeError = new Error("PROBE — simulated recompute failure");
    const res = await review(req.id, data.adminToken);

    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(await receiptCountOf(emp.id), "no orphan receipt from the rolled-back booking").toBe(0);
    expect(
      await balanceOf(emp.id),
      "the stored balance must be exactly the pre-approval value — untouched",
    ).toBeCloseTo(10, H);
  });

  it("successful approval: one receipt row, stored balance equal to the recomputed value (#294 non-regression)", async () => {
    const emp = await makeEmployee({ balanceHours: 0 });
    const req = await createRequest(emp.id);

    const res = await review(req.id, data.adminToken);
    expect(res.statusCode, res.body).toBe(200);

    expect(await receiptCountOf(emp.id), "exactly one booking receipt").toBe(1);

    // The stored balance must equal what a fresh, real (unmocked) recompute would return right
    // now — the SAME value the persist step wrote inside the transaction.
    forceComputeError = null;
    const recomputedNow = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${emp.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(recomputedNow.statusCode, recomputedNow.body).toBe(200);
    const recomputedBalance = Number(JSON.parse(recomputedNow.body).balanceHours);
    expect(
      await balanceOf(emp.id),
      "persisted balance must equal the recomputed value — one number, one computation",
    ).toBeCloseTo(recomputedBalance, H);
  });

  it("§18-exempt employee: the manual booking stays the sole writer, and the request still 200s (#294 non-regression)", async () => {
    const emp = await makeEmployee({ exempt: true, balanceHours: 20 });
    const req = await createRequest(emp.id);

    const res = await review(req.id, data.adminToken);
    expect(res.statusCode, res.body).toBe(200);

    expect(await receiptCountOf(emp.id), "the manual booking wrote exactly one receipt").toBe(1);
    expect(
      await balanceOf(emp.id),
      "the manual REDUCTION survives: 20h − 8h, not an Ist-Soll recompute (compute returns null for exempt employees)",
    ).toBeCloseTo(12, H);
  });
});
