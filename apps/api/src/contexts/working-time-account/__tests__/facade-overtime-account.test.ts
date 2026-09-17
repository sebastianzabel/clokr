/**
 * Phase 100B Plan 06 (Wave 3) — focused integration test for the Arbeitszeitkonto
 * `OvertimeAccount`/`OvertimeTransaction` facade (W8–W15).
 *
 * The rollback test below is the point of this file (100B-06-PLAN.md Task 1): it is the first
 * behavioural assertion anywhere in this repo that a facade write actually participates in the
 * CALLER's `$transaction` rather than silently escaping it through `app.prisma` (R1, D-07). Its
 * non-vacuousness was proven by hand during this plan's execution — see the PLAN's own
 * instruction and 100B-06-SUMMARY.md for the captured red transcript with the first parameter
 * temporarily changed to `app: FastifyInstance`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  getOvertimeAccount,
  listOvertimeAccountsForTenant,
  getBalances,
  bookOvertimeCompensation,
  reverseOvertimeCompensation,
  createOvertimeAccount,
  setOvertimeAccountBalance,
  hardDeleteOvertimeDataForEmployee,
} from "../index";
import type { FastifyInstance } from "fastify";

describe("Arbeitszeitkonto facade — OvertimeAccount/OvertimeTransaction (Phase 100B Plan 06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherTenantData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "otc-facade");
    otherTenantData = await seedTestData(app, "otc-facade-other");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherTenantData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("bookOvertimeCompensation / reverseOvertimeCompensation — the rollback assertion", () => {
    it("a booking inside a $transaction that later throws leaves NO trace: balance unchanged, no OvertimeTransaction row", async () => {
      const before = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: data.employee.id },
      });
      const txCountBefore = await app.prisma.overtimeTransaction.count({
        where: { overtimeAccountId: before.id },
      });

      await expect(
        app.prisma.$transaction(async (tx) => {
          await bookOvertimeCompensation(
            tx,
            data.employee.id,
            data.tenant.id,
            5,
            "rollback-half (must not persist)",
          );
          throw new Error("forced rollback");
        }),
      ).rejects.toThrow("forced rollback");

      const afterRollback = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: data.employee.id },
      });
      expect(
        Number(afterRollback.balanceHours),
        "the write must have been rolled back with the rest of the transaction",
      ).toBe(Number(before.balanceHours));
      const txCountAfterRollback = await app.prisma.overtimeTransaction.count({
        where: { overtimeAccountId: before.id },
      });
      expect(txCountAfterRollback, "no OvertimeTransaction row must survive the rollback").toBe(
        txCountBefore,
      );

      // Second half of the SAME assertion: the identical call, run OUTSIDE a transaction, DOES
      // persist both effects — proving the function itself works, isolating the first half's
      // "unchanged" result to the rollback, not to a facade that never writes anything at all.
      await bookOvertimeCompensation(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        5,
        "outside-tx (must persist)",
      );
      const afterOutsideTx = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: data.employee.id },
      });
      expect(Number(afterOutsideTx.balanceHours)).toBe(Number(before.balanceHours) - 5);
      const txCountAfterOutsideTx = await app.prisma.overtimeTransaction.count({
        where: { overtimeAccountId: before.id },
      });
      expect(txCountAfterOutsideTx).toBe(txCountBefore + 1);
      const [lastTx] = await app.prisma.overtimeTransaction.findMany({
        where: { overtimeAccountId: before.id },
        orderBy: { createdAt: "desc" },
        take: 1,
      });
      expect(lastTx.type).toBe("REDUCTION");
      expect(Number(lastTx.hours)).toBe(-5);
      expect(lastTx.description).toBe("outside-tx (must persist)");
    });

    it("reverseOvertimeCompensation increments the balance and writes a CORRECTION row", async () => {
      const before = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: data.adminEmployee.id },
      });

      await reverseOvertimeCompensation(
        app.prisma,
        data.adminEmployee.id,
        data.tenant.id,
        3,
        "reversal test",
      );

      const after = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: data.adminEmployee.id },
      });
      expect(Number(after.balanceHours)).toBe(Number(before.balanceHours) + 3);
      const [lastTx] = await app.prisma.overtimeTransaction.findMany({
        where: { overtimeAccountId: before.id },
        orderBy: { createdAt: "desc" },
        take: 1,
      });
      expect(lastTx.type).toBe("CORRECTION");
      expect(Number(lastTx.hours)).toBe(3);
    });

    it("no-ops (no write at all) when hours <= 0", async () => {
      const before = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: data.adminEmployee.id },
      });
      const txCountBefore = await app.prisma.overtimeTransaction.count({
        where: { overtimeAccountId: before.id },
      });

      await bookOvertimeCompensation(app.prisma, data.adminEmployee.id, data.tenant.id, 0, "noop");

      const after = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: data.adminEmployee.id },
      });
      expect(Number(after.balanceHours)).toBe(Number(before.balanceHours));
      const txCountAfter = await app.prisma.overtimeTransaction.count({
        where: { overtimeAccountId: before.id },
      });
      expect(txCountAfter).toBe(txCountBefore);
    });
  });

  describe("getOvertimeAccount", () => {
    it("returns the stored account, scoped to the correct tenant", async () => {
      const account = await getOvertimeAccount(app.prisma, data.employee.id, data.tenant.id);
      expect(account?.employeeId).toBe(data.employee.id);
    });

    it("returns null when queried under the WRONG tenant", async () => {
      const account = await getOvertimeAccount(
        app.prisma,
        data.employee.id,
        otherTenantData.tenant.id,
      );
      expect(account).toBeNull();
    });
  });

  describe("listOvertimeAccountsForTenant / getBalances", () => {
    it("listOvertimeAccountsForTenant returns every active employee's account for the tenant, never another tenant's", async () => {
      const accounts = await listOvertimeAccountsForTenant(app.prisma, data.tenant.id);
      const employeeIds = new Set(accounts.map((a) => a.employeeId));
      expect(employeeIds.has(data.employee.id)).toBe(true);
      expect(employeeIds.has(data.adminEmployee.id)).toBe(true);
      expect(employeeIds.has(otherTenantData.employee.id)).toBe(false);
      expect(accounts[0].employee.firstName).toBeTruthy();
    });

    it("getBalances bulk-reads balanceHours for exactly the given employeeIds", async () => {
      const rows = await getBalances(
        app.prisma,
        [data.employee.id, data.adminEmployee.id],
        data.tenant.id,
      );
      expect(rows).toHaveLength(2);
    });

    it("getBalances returns an empty array for an empty employeeIds list (no query issued)", async () => {
      const rows = await getBalances(app.prisma, [], data.tenant.id);
      expect(rows).toEqual([]);
    });
  });

  describe("createOvertimeAccount / setOvertimeAccountBalance / hardDeleteOvertimeDataForEmployee", () => {
    it("creates a zero-balance account, upserts a new balance, then hard-deletes it", async () => {
      // A throwaway employee (no fixture-provisioned OvertimeAccount) so this test owns the
      // full lifecycle without touching the shared fixture accounts above.
      const user = await app.prisma.user.create({
        data: {
          email: `otc-lifecycle-${Date.now()}@test.de`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `OTC-${Date.now()}`,
          firstName: "Lifecycle",
          lastName: "Test",
          hireDate: new Date("2024-01-01"),
        },
      });

      await createOvertimeAccount(app.prisma, employee.id, data.tenant.id);
      const created = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: employee.id },
      });
      expect(Number(created.balanceHours)).toBe(0);

      await setOvertimeAccountBalance(app.prisma, employee.id, data.tenant.id, 12.5);
      const updated = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: employee.id },
      });
      expect(Number(updated.balanceHours)).toBe(12.5);

      await hardDeleteOvertimeDataForEmployee(app.prisma, employee.id);
      const deleted = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: employee.id },
      });
      expect(deleted).toBeNull();

      // Cleanup the throwaway employee/user (outside the shared fixture teardown).
      await app.prisma.employee.delete({ where: { id: employee.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    });
  });
});
