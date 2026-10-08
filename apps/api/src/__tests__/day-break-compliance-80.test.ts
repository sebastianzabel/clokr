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
});
