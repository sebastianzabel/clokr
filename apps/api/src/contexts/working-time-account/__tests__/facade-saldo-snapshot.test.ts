/**
 * Phase 100B Plan 07 (Wave 3, final) — focused integration test for the Arbeitszeitkonto
 * `SaldoSnapshot` facade (W1–W7) and the widened `ConfirmedCarryOver` (W3 merge).
 *
 * Every `SaldoSnapshot` fixture is built via `saldoSnapshotPeriodBounds()` (issue #241's own
 * fixture helper) — never a naive `Date.UTC(year, month, 1)` — so these tests exercise the SAME
 * storage convention the monthly closer actually writes, not a convention-agreeing-with-a-bug
 * shape (100B-06-SUMMARY.md's and the 241 quick-fixes' documented vacuous-test pattern).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { saldoSnapshotPeriodBounds } from "../../../__tests__/test-dates";
import {
  isMonthClosed,
  getClosedMonthsForDates,
  getClosedMonthsInRange,
  getMonthClosingBalance,
  getMonthlySnapshotsInRange,
  sumCarryOverByMonth,
  countSnapshotsBefore,
} from "../index";
import { getConfirmedCarryOver, getConfirmedCarryOverBulk } from "../confirmed-saldo";
import type { FastifyInstance } from "fastify";

describe("Arbeitszeitkonto facade — SaldoSnapshot (Phase 100B Plan 07)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherTenantData: Awaited<ReturnType<typeof seedTestData>>;
  // A THIRD, separately-seeded tenant, untouched by every other describe block above — the
  // getConfirmedCarryOver/getConfirmedCarryOverBulk tests below assert "the MOST RECENT
  // snapshot", which would be corrupted by the many other-month fixtures `data.employee.id`
  // accumulates across this file's earlier tests.
  let confirmedData: Awaited<ReturnType<typeof seedTestData>>;
  let confirmedEmptyData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "saldosnap-facade");
    otherTenantData = await seedTestData(app, "saldosnap-facade-other");
    confirmedData = await seedTestData(app, "saldosnap-facade-confirmed");
    confirmedEmptyData = await seedTestData(app, "saldosnap-facade-confirmed-empty");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherTenantData.tenant.id);
      await cleanupTestData(app, confirmedData.tenant.id);
      await cleanupTestData(app, confirmedEmptyData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createSnapshot(
    employeeId: string,
    d: Date,
    overrides: Partial<{
      balanceMinutes: number;
      carryOver: number;
      superseded: boolean;
      closedAt: Date;
    }> = {},
  ) {
    const { start, end } = saldoSnapshotPeriodBounds(d);
    return app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: start,
        periodEnd: end,
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: overrides.balanceMinutes ?? 0,
        carryOver: overrides.carryOver ?? 0,
        closedAt: overrides.closedAt ?? new Date(),
        closedBy: "test-system",
        superseded: overrides.superseded ?? false,
      },
    });
  }

  describe("isMonthClosed (W1) — periodStartWindow, the monthRangeUtc-derived form", () => {
    it("finds a snapshot stored with the real (TZ-converted) periodStart convention", async () => {
      const target = new Date("2031-03-15T00:00:00.000Z");
      await createSnapshot(data.employee.id, target);
      const { start: monthStart } = saldoSnapshotPeriodBounds(target);

      const closed = await isMonthClosed(app.prisma, data.employee.id, data.tenant.id, monthStart);
      expect(closed).toBe(true);
    });

    it("also finds a legacy UTC-naive-stored row for the same month (the window's whole purpose)", async () => {
      const naiveMonthStart = new Date(Date.UTC(2031, 3, 1)); // 2031-04-01T00:00:00Z, naive convention
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: naiveMonthStart,
          periodEnd: new Date(Date.UTC(2031, 4, 0)),
          workedMinutes: 9600,
          expectedMinutes: 9600,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: "test-system",
          superseded: false,
        },
      });
      // The real, correctly-derived monthStart (what a caller now always passes in) —
      // periodStartWindow's 2-day window still finds the legacy-convention row.
      const { start: monthStart } = saldoSnapshotPeriodBounds(new Date("2031-04-15T00:00:00.000Z"));
      const closed = await isMonthClosed(app.prisma, data.employee.id, data.tenant.id, monthStart);
      expect(closed).toBe(true);
    });

    it("returns false for an open (non-existent) month", async () => {
      const { start: monthStart } = saldoSnapshotPeriodBounds(new Date("2031-05-15T00:00:00.000Z"));
      const closed = await isMonthClosed(app.prisma, data.employee.id, data.tenant.id, monthStart);
      expect(closed).toBe(false);
    });

    it("never reports another tenant's closed month as closed for this tenant (tenant isolation)", async () => {
      const target = new Date("2031-06-15T00:00:00.000Z");
      await createSnapshot(otherTenantData.employee.id, target);
      const { start: monthStart } = saldoSnapshotPeriodBounds(target);

      const closedForOwnTenant = await isMonthClosed(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        monthStart,
      );
      expect(closedForOwnTenant).toBe(false);

      const closedForOtherTenantEmployeeUnderWrongTenant = await isMonthClosed(
        app.prisma,
        otherTenantData.employee.id,
        data.tenant.id, // wrong tenant for this employee
        monthStart,
      );
      expect(closedForOtherTenantEmployeeUnderWrongTenant).toBe(false);
    });

    it("ignores a superseded snapshot", async () => {
      const target = new Date("2031-07-15T00:00:00.000Z");
      await createSnapshot(data.employee.id, target, { superseded: true });
      const { start: monthStart } = saldoSnapshotPeriodBounds(target);

      const closed = await isMonthClosed(app.prisma, data.employee.id, data.tenant.id, monthStart);
      expect(closed).toBe(false);
    });
  });

  describe("getClosedMonthsForDates / getClosedMonthsInRange (W2a/W2b) — bulk lookup, both query shapes", () => {
    it("getClosedMonthsForDates (discrete list) returns composite ${employeeId}::${isoDate} keys", async () => {
      const target = new Date("2031-08-15T00:00:00.000Z");
      const row = await createSnapshot(data.employee.id, target);

      const closedSet = await getClosedMonthsForDates(
        app.prisma,
        [data.employee.id],
        data.tenant.id,
        [row.periodStart],
      );
      const isoDate = row.periodStart.toISOString().slice(0, 10);
      expect(closedSet.has(`${data.employee.id}::${isoDate}`)).toBe(true);
    });

    it("getClosedMonthsInRange (from/to) finds the same row", async () => {
      const target = new Date("2031-08-15T00:00:00.000Z");
      const { start: monthStart } = saldoSnapshotPeriodBounds(target);

      const closedSet = await getClosedMonthsInRange(
        app.prisma,
        [data.employee.id],
        data.tenant.id,
        monthStart,
        monthStart,
      );
      const isoDate = monthStart.toISOString().slice(0, 10);
      expect(closedSet.has(`${data.employee.id}::${isoDate}`)).toBe(true);
    });

    it("returns an empty Set for an empty employeeIds array (no query)", async () => {
      const closedSet = await getClosedMonthsForDates(app.prisma, [], data.tenant.id, [new Date()]);
      expect(closedSet.size).toBe(0);
    });
  });

  describe("getMonthClosingBalance (W4) — bare periodStart match, preserved as-is", () => {
    it("returns balanceMinutes for a closed month", async () => {
      const target = new Date("2031-09-15T00:00:00.000Z");
      await createSnapshot(data.employee.id, target, { balanceMinutes: 245 });
      const { start: monthStart } = saldoSnapshotPeriodBounds(target);

      const balance = await getMonthClosingBalance(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        monthStart,
      );
      expect(balance).toBe(245);
    });

    it("returns null for an open month", async () => {
      const { start: monthStart } = saldoSnapshotPeriodBounds(new Date("2031-10-15T00:00:00.000Z"));
      const balance = await getMonthClosingBalance(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        monthStart,
      );
      expect(balance).toBeNull();
    });
  });

  describe("getMonthlySnapshotsInRange (W5) — the verified-union read shape", () => {
    it("bounded by `from`, orders ascending, and carries every field either caller needs", async () => {
      const older = new Date("2029-01-15T00:00:00.000Z");
      const newer = new Date("2029-02-15T00:00:00.000Z");
      await createSnapshot(data.employee.id, older, { carryOver: 10 });
      await createSnapshot(data.employee.id, newer, { carryOver: 20 });
      const { start: from } = saldoSnapshotPeriodBounds(older);

      const rows = await getMonthlySnapshotsInRange(
        app.prisma,
        [data.employee.id],
        data.tenant.id,
        from,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const carryOvers = rows.map((r) => r.carryOver);
      expect(carryOvers.indexOf(10)).toBeLessThan(carryOvers.indexOf(20));
      const first = rows.find((r) => r.carryOver === 10);
      expect(first).toMatchObject({
        employeeId: data.employee.id,
        carryOver: 10,
      });
      expect(first?.id).toBeTruthy();
      expect(first?.closedAt).toBeInstanceOf(Date);
    });

    it("with no `from` returns unbounded history (activity.ts's shape)", async () => {
      const rows = await getMonthlySnapshotsInRange(app.prisma, [data.employee.id], data.tenant.id);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it("returns [] for an empty employeeIds array", async () => {
      const rows = await getMonthlySnapshotsInRange(app.prisma, [], data.tenant.id);
      expect(rows).toEqual([]);
    });
  });

  describe("sumCarryOverByMonth (W6) — D2 (checkpoint RESOLVED): keeps superseded:false", () => {
    it("excludes a superseded row's carryOver from the sum", async () => {
      const target = new Date("2028-01-15T00:00:00.000Z");
      await createSnapshot(data.employee.id, target, { carryOver: 100, superseded: false });
      const { start: from } = saldoSnapshotPeriodBounds(target);

      const grouped = await sumCarryOverByMonth(
        app.prisma,
        [data.employee.id],
        data.tenant.id,
        from,
      );
      const row = grouped.find(
        (g) => g.periodStart.toISOString().slice(0, 10) === from.toISOString().slice(0, 10),
      );
      expect(row?.carryOver).toBe(100);
    });

    it("returns [] for an empty employeeIds array", async () => {
      const grouped = await sumCarryOverByMonth(app.prisma, [], data.tenant.id, new Date());
      expect(grouped).toEqual([]);
    });
  });

  describe("countSnapshotsBefore (W7) — retention gate", () => {
    it("counts only snapshots whose periodEnd is on/before the cutoff, tenant-scoped", async () => {
      const target = new Date("2020-01-15T00:00:00.000Z");
      await createSnapshot(data.employee.id, target);
      const { end } = saldoSnapshotPeriodBounds(target);

      const countAtCutoff = await countSnapshotsBefore(
        app.prisma,
        [data.employee.id],
        data.tenant.id,
        end,
      );
      expect(countAtCutoff).toBeGreaterThanOrEqual(1);

      const beforeAnything = await countSnapshotsBefore(
        app.prisma,
        [data.employee.id],
        data.tenant.id,
        new Date("2000-01-01T00:00:00.000Z"),
      );
      expect(beforeAnything).toBe(0);
    });

    it("returns 0 for an empty employeeIds array", async () => {
      const count = await countSnapshotsBefore(app.prisma, [], data.tenant.id, new Date());
      expect(count).toBe(0);
    });
  });

  describe("confirmed-saldo.ts — db: Prisma.TransactionClient conversion, W3 merge (periodEnd)", () => {
    it("getConfirmedCarryOver returns minutes/hasClosedMonth/periodEnd from the latest non-superseded snapshot", async () => {
      const older = new Date("2027-01-15T00:00:00.000Z");
      const newer = new Date("2027-02-15T00:00:00.000Z");
      await createSnapshot(confirmedData.employee.id, older, { carryOver: 111 });
      const newerRow = await createSnapshot(confirmedData.employee.id, newer, { carryOver: 222 });

      const confirmed = await getConfirmedCarryOver(
        app.prisma,
        confirmedData.employee.id,
        confirmedData.tenant.id,
      );
      expect(confirmed.hasClosedMonth).toBe(true);
      expect(confirmed.minutes).toBe(222);
      expect(confirmed.periodEnd?.toISOString()).toBe(newerRow.periodEnd.toISOString());
    });

    it("getConfirmedCarryOverBulk mirrors the single-employee shape for many employees", async () => {
      const map = await getConfirmedCarryOverBulk(
        app.prisma,
        [confirmedData.employee.id],
        confirmedData.tenant.id,
      );
      const entry = map.get(confirmedData.employee.id);
      expect(entry?.hasClosedMonth).toBe(true);
      expect(entry?.periodEnd).toBeInstanceOf(Date);
    });

    it("reports hasClosedMonth:false and periodEnd:null for an employee with no closed month", async () => {
      const confirmed = await getConfirmedCarryOver(
        app.prisma,
        confirmedEmptyData.employee.id,
        confirmedEmptyData.tenant.id,
      );
      expect(confirmed).toEqual({ minutes: 0, hasClosedMonth: false, periodEnd: null });
    });

    it("runs inside a $transaction client unchanged — the same D-07 shape as every other facade", async () => {
      const result = await app.prisma.$transaction(async (tx) => {
        return getConfirmedCarryOver(tx, confirmedData.employee.id, confirmedData.tenant.id);
      });
      expect(result.hasClosedMonth).toBe(true);
    });
  });
});
