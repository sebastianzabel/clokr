/**
 * Issue #80, D-06 — DSGVO anonymization, hard delete and retention for DayBreak / DayBreakAck.
 *
 * The two day-level tables follow every compliance rule of the existing time data:
 *   - Art. 17 anonymization nulls the only free text (DayBreakAck.reason) on every row of the
 *     employee, soft-deleted ones included, and keeps every row (retention).
 *   - The hard-delete sequence removes the day rows before the employee (Restrict FKs).
 *   - The annual retention job soft-deletes day rows dated on or before the cutoff and counts them
 *     in its aggregate ARCHIVE audit.
 *
 * The rows are created directly with Prisma: these rules do not need a multi-entry day.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { anonymizeEmployeeData } from "../contexts/platform/anonymize";
import {
  archiveDayBreakDataBefore,
  hardDeleteTimeDataForEmployee,
} from "../contexts/time-tracking";

describe("DayBreak / DayBreakAck compliance (Issue #80, D-06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let counter = 0;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "day-break-compliance-80");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("day-break-compliance-80 cleanup failed:", err);
    }
  });

  /** A bare employee (own user) in the seeded tenant, with no other Restrict-protected rows. */
  async function createEmployee(label: string) {
    counter += 1;
    const stamp = `${Date.now()}-${counter}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${stamp}@test.local`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    return app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `DBC-${stamp}`,
        firstName: "Tag",
        lastName: "Pause",
        hireDate: new Date("2014-01-01"),
      },
    });
  }

  function ackData(employeeId: string, date: string, reason: string | null) {
    return {
      employeeId,
      date: new Date(`${date}T00:00:00Z`),
      reason,
      snapshot: { entryIds: [], salonIds: [], netWorkedMin: 0, totalBreakMin: 0 },
      acknowledgedBy: data.adminUser.id,
    };
  }

  function dayBreakData(employeeId: string, date: string) {
    return {
      employeeId,
      date: new Date(`${date}T00:00:00Z`),
      startTime: new Date(`${date}T12:00:00Z`),
      endTime: new Date(`${date}T12:30:00Z`),
      createdBy: data.adminUser.id,
    };
  }

  describe("DSGVO Art. 17 anonymization (T10)", () => {
    it("nulls the ack reason on active and soft-deleted rows, keeps every row, leaves other employees alone", async () => {
      const target = await createEmployee("anon-target");
      const bystander = await createEmployee("anon-bystander");

      const active = await app.prisma.dayBreakAck.create({
        data: ackData(target.id, "2026-03-02", "Kundentermin, keine Pause möglich"),
      });
      const revoked = await app.prisma.dayBreakAck.create({
        data: {
          ...ackData(target.id, "2026-03-03", "Widerrufene Begründung mit Namen"),
          deletedAt: new Date(),
          deletedBy: data.adminUser.id,
        },
      });
      const dayBreak = await app.prisma.dayBreak.create({
        data: dayBreakData(target.id, "2026-03-02"),
      });
      const bystanderAck = await app.prisma.dayBreakAck.create({
        data: ackData(bystander.id, "2026-03-02", "Fremde Begründung"),
      });

      await app.prisma.$transaction(async (tx) => {
        await anonymizeEmployeeData({ tx, employeeId: target.id });
      });

      const ackRows = await app.prisma.dayBreakAck.findMany({ where: { employeeId: target.id } });
      expect(ackRows).toHaveLength(2);
      for (const row of ackRows) expect(row.reason).toBeNull();

      // Everything except the free text is untouched: the row, its snapshot and who acknowledged.
      const activeAfter = ackRows.find((r) => r.id === active.id)!;
      expect(activeAfter.deletedAt).toBeNull();
      expect(activeAfter.acknowledgedBy).toBe(data.adminUser.id);
      expect(activeAfter.snapshot).toEqual(active.snapshot);
      const revokedAfter = ackRows.find((r) => r.id === revoked.id)!;
      expect(revokedAfter.deletedAt).not.toBeNull();

      const dayBreakAfter = await app.prisma.dayBreak.findUnique({ where: { id: dayBreak.id } });
      expect(dayBreakAfter).not.toBeNull();
      expect(dayBreakAfter!.deletedAt).toBeNull();

      const bystanderAfter = await app.prisma.dayBreakAck.findUniqueOrThrow({
        where: { id: bystanderAck.id },
      });
      expect(bystanderAfter.reason).toBe("Fremde Begründung");
    });
  });

  describe("hard delete (T11)", () => {
    it("removes DayBreakAck and DayBreak before Break/TimeEntry so the employee row can be deleted", async () => {
      const employee = await createEmployee("hard-delete");
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: employee.id,
          date: new Date("2026-04-01T00:00:00Z"),
          startTime: new Date("2026-04-01T08:00:00Z"),
          endTime: new Date("2026-04-01T11:00:00Z"),
          type: "WORK",
          salonId: data.salonId,
        },
      });
      await app.prisma.break.create({
        data: {
          timeEntryId: entry.id,
          startTime: new Date("2026-04-01T09:00:00Z"),
          endTime: new Date("2026-04-01T09:15:00Z"),
        },
      });
      await app.prisma.dayBreak.create({ data: dayBreakData(employee.id, "2026-04-01") });
      await app.prisma.dayBreakAck.create({ data: ackData(employee.id, "2026-04-01", "Grund") });

      // Precondition: with the day rows in place the Restrict FK blocks the employee delete, so
      // the assertion below proves the day rows are what the sequence has to clear.
      await expect(app.prisma.employee.delete({ where: { id: employee.id } })).rejects.toThrow();

      await app.prisma.$transaction(async (tx) => {
        await hardDeleteTimeDataForEmployee(tx, employee.id);
        expect(await tx.dayBreakAck.count({ where: { employeeId: employee.id } })).toBe(0);
        expect(await tx.dayBreak.count({ where: { employeeId: employee.id } })).toBe(0);
        expect(await tx.timeEntry.count({ where: { employeeId: employee.id } })).toBe(0);
        await tx.employee.delete({ where: { id: employee.id } });
      });

      expect(await app.prisma.employee.findUnique({ where: { id: employee.id } })).toBeNull();
      expect(await app.prisma.dayBreak.count({ where: { employeeId: employee.id } })).toBe(0);
    });

    it("leaves another employee's day rows alone", async () => {
      const gone = await createEmployee("hard-delete-gone");
      const kept = await createEmployee("hard-delete-kept");
      await app.prisma.dayBreak.create({ data: dayBreakData(kept.id, "2026-04-02") });
      await app.prisma.dayBreakAck.create({ data: ackData(kept.id, "2026-04-02", "bleibt") });

      await app.prisma.$transaction(async (tx) => {
        await hardDeleteTimeDataForEmployee(tx, gone.id);
      });

      expect(await app.prisma.dayBreak.count({ where: { employeeId: kept.id } })).toBe(1);
      expect(await app.prisma.dayBreakAck.count({ where: { employeeId: kept.id } })).toBe(1);
    });
  });

  describe("retention (T9b archiveDayBreakDataBefore)", () => {
    const cutoff = new Date("2020-12-31T23:59:59.999Z");

    it("soft-deletes day rows dated on or before the cutoff, only those, and returns their count", async () => {
      const employee = await createEmployee("archive");
      const old = await app.prisma.dayBreak.create({
        data: dayBreakData(employee.id, "2019-05-06"),
      });
      const oldAck = await app.prisma.dayBreakAck.create({
        data: ackData(employee.id, "2019-05-06", "alt"),
      });
      const edge = await app.prisma.dayBreak.create({
        data: dayBreakData(employee.id, "2020-12-31"),
      });
      const recent = await app.prisma.dayBreak.create({
        data: dayBreakData(employee.id, "2026-05-06"),
      });
      const recentAck = await app.prisma.dayBreakAck.create({
        data: ackData(employee.id, "2026-05-06", "neu"),
      });
      const alreadyDeleted = await app.prisma.dayBreak.create({
        data: { ...dayBreakData(employee.id, "2018-01-02"), deletedAt: new Date("2019-01-01") },
      });

      const count = await app.prisma.$transaction((tx) =>
        archiveDayBreakDataBefore(tx, [employee.id], data.tenant.id, cutoff),
      );

      // old DayBreak + old ack + the break on the cutoff day itself; the already-deleted row and
      // the recent rows do not count.
      expect(count).toBe(3);
      const byId = async (id: string) => app.prisma.dayBreak.findUniqueOrThrow({ where: { id } });
      expect((await byId(old.id)).deletedAt).not.toBeNull();
      expect((await byId(edge.id)).deletedAt).not.toBeNull();
      expect((await byId(recent.id)).deletedAt).toBeNull();
      expect((await byId(alreadyDeleted.id)).deletedAt!.toISOString()).toBe(
        "2019-01-01T00:00:00.000Z",
      );
      expect(
        (await app.prisma.dayBreakAck.findUniqueOrThrow({ where: { id: oldAck.id } })).deletedAt,
      ).not.toBeNull();
      expect(
        (await app.prisma.dayBreakAck.findUniqueOrThrow({ where: { id: recentAck.id } })).deletedAt,
      ).toBeNull();
      // Soft delete only: no row is removed.
      expect(await app.prisma.dayBreak.count({ where: { employeeId: employee.id } })).toBe(4);
    });

    it("ignores another tenant's rows and returns 0 for an empty employee list", async () => {
      const other = await seedTestData(app, "day-break-compliance-80-other");
      try {
        const foreign = await app.prisma.dayBreak.create({
          data: dayBreakData(other.employee.id, "2019-05-06"),
        });

        // The foreign employee id is passed together with THIS tenant's id: the tenant filter wins.
        const count = await archiveDayBreakDataBefore(
          app.prisma,
          [other.employee.id],
          data.tenant.id,
          cutoff,
        );
        expect(count).toBe(0);
        expect(
          (await app.prisma.dayBreak.findUniqueOrThrow({ where: { id: foreign.id } })).deletedAt,
        ).toBeNull();

        expect(await archiveDayBreakDataBefore(app.prisma, [], data.tenant.id, cutoff)).toBe(0);
      } finally {
        await cleanupTestData(app, other.tenant.id);
      }
    });
  });

  describe("annual retention job (runRetention)", () => {
    it("archives old day rows, keeps recent ones and counts them as archivedDayBreaks in the ARCHIVE audit", async () => {
      const retention = await seedTestData(app, "day-break-compliance-80-retention");
      try {
        const retentionYears = 10;
        await app.prisma.tenantConfig.update({
          where: { tenantId: retention.tenant.id },
          data: { dataRetentionYears: retentionYears },
        });
        const cutoffYear = new Date().getFullYear() - retentionYears;
        const oldDate = `${cutoffYear - 1}-03-04`;
        const recentDate = `${new Date().getFullYear()}-01-05`;
        const employeeId = retention.employee.id;

        // The job only archives a tenant that has a saldo snapshot covering the cutoff period.
        await app.prisma.saldoSnapshot.create({
          data: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: new Date(`${cutoffYear - 1}-01-01T00:00:00Z`),
            periodEnd: new Date(`${cutoffYear - 1}-01-31T00:00:00Z`),
            workedMinutes: 0,
            expectedMinutes: 0,
            balanceMinutes: 0,
            carryOver: 0,
            closedAt: new Date(),
          },
        });
        const oldBreak = await app.prisma.dayBreak.create({
          data: dayBreakData(employeeId, oldDate),
        });
        const oldAck = await app.prisma.dayBreakAck.create({
          data: ackData(employeeId, oldDate, "alt"),
        });
        const recentBreak = await app.prisma.dayBreak.create({
          data: dayBreakData(employeeId, recentDate),
        });

        await app.runRetention!();

        expect(
          (await app.prisma.dayBreak.findUniqueOrThrow({ where: { id: oldBreak.id } })).deletedAt,
        ).not.toBeNull();
        expect(
          (await app.prisma.dayBreakAck.findUniqueOrThrow({ where: { id: oldAck.id } })).deletedAt,
        ).not.toBeNull();
        expect(
          (await app.prisma.dayBreak.findUniqueOrThrow({ where: { id: recentBreak.id } }))
            .deletedAt,
        ).toBeNull();

        const audits = await app.prisma.auditLog.findMany({
          where: { action: "ARCHIVE", entity: "DataRetention" },
          orderBy: { createdAt: "desc" },
        });
        const mine = audits.find(
          (a) => (a.newValue as { tenantId?: string } | null)?.tenantId === retention.tenant.id,
        );
        expect(mine).toBeDefined();
        const newValue = mine!.newValue as Record<string, unknown>;
        // Observed shape of the aggregate audit; archivedDayBreaks = the old break + the old ack.
        expect(newValue).toMatchObject({
          origin: "SYSTEM",
          tenantId: retention.tenant.id,
          retentionYears,
          archivedEntries: 0,
          archivedDayBreaks: 2,
        });
      } finally {
        await cleanupTestData(app, retention.tenant.id);
      }
    });
  });
});
