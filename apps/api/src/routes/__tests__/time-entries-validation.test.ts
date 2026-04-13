import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

describe("Time Entry Validation Rules", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "tev");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("Future date blocking", () => {
    it("rejects POST /time-entries with a future date", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split("T")[0];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: dateStr,
          startTime: `${dateStr}T08:00:00.000Z`,
          endTime: `${dateStr}T16:00:00.000Z`,
          breakMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Zukunft");
    });
  });

  describe("Future endTime blocking", () => {
    it("rejects POST /time-entries with endTime > now+30min", async () => {
      const now = new Date();
      const todayStr = now.toISOString().split("T")[0];
      // endTime = now + 2 hours (well beyond 30min tolerance)
      const futureEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: todayStr,
          startTime: new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString(),
          endTime: futureEnd.toISOString(),
          breakMinutes: 0,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("30 Minuten");
    });
  });

  describe("BUrlG vacation block (section 8)", () => {
    let leaveRequestId: string;

    it("blocks POST /time-entries on a day with approved vacation", async () => {
      // Create a leave request for a specific date
      const leaveDate = "2025-06-16"; // a Monday in the past

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: leaveDate,
          endDate: leaveDate,
        },
      });
      expect(createRes.statusCode).toBe(201);
      leaveRequestId = JSON.parse(createRes.body).id;

      // Approve the leave request
      const approveRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${leaveRequestId}/review`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { status: "APPROVED" },
      });
      expect(approveRes.statusCode).toBe(200);

      // Try to create a time entry on that date
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: leaveDate,
          startTime: `${leaveDate}T08:00:00.000Z`,
          endTime: `${leaveDate}T16:00:00.000Z`,
          breakMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("BUrlG");
    });

    it("blocks manual time entry when approved vacation exists", async () => {
      const todayStr = new Date().toISOString().split("T")[0];

      // Create approved leave directly in DB
      const leaveType = await app.prisma.leaveType.findFirst({
        where: { tenantId: data.tenant.id },
      });
      const lt =
        leaveType ??
        (await app.prisma.leaveType.create({
          data: {
            tenantId: data.tenant.id,
            name: "Jahresurlaub",
            isPaid: true,
            requiresApproval: true,
            color: "#3B82F6",
          },
        }));

      const leaveReq = await app.prisma.leaveRequest.create({
        data: {
          employeeId: data.employee.id,
          leaveTypeId: lt.id,
          startDate: new Date(todayStr + "T00:00:00Z"),
          endDate: new Date(todayStr + "T00:00:00Z"),
          days: 1,
          status: "APPROVED",
          reviewedBy: data.adminUser.id,
          reviewedAt: new Date(),
        },
      });

      // Manual entry on vacation day should be blocked
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          date: todayStr,
          startTime: new Date(todayStr + "T08:00:00Z").toISOString(),
          endTime: new Date(todayStr + "T12:00:00Z").toISOString(),
          breakMinutes: 0,
        },
      });

      // Can be 409 (BUrlG block) or 400 (future time validation) depending on time of day
      expect([400, 409]).toContain(res.statusCode);
      const body = JSON.parse(res.body);
      if (res.statusCode === 409) {
        expect(body.error).toContain("BUrlG");
      }

      // Clean up
      await app.prisma.leaveRequest.delete({ where: { id: leaveReq.id } });
    });

    it("allows time entry after cancelling the leave request", async () => {
      const leaveDate = "2025-06-16";

      // Delete/cancel the leave request
      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/leave/requests/${leaveRequestId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(deleteRes.statusCode).toBeLessThan(300);

      // Now creating a time entry should work
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: leaveDate,
          startTime: `${leaveDate}T08:00:00.000Z`,
          endTime: `${leaveDate}T16:00:00.000Z`,
          breakMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe("hireDate blocking", () => {
    it("rejects POST /time-entries before employee hireDate", async () => {
      // Employee hireDate is 2024-01-01; try to create entry on 2023-12-01
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2023-12-01",
          startTime: "2023-12-01T08:00:00.000Z",
          endTime: "2023-12-01T16:00:00.000Z",
          breakMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Eintrittsdatum");
    });
  });

  describe("Inactive employee blocking", () => {
    it("rejects POST /time-entries for a deactivated employee", async () => {
      // Deactivate the employee's user
      await app.prisma.user.update({
        where: { id: data.empUser.id },
        data: { isActive: false },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-03-10",
          startTime: "2025-03-10T08:00:00.000Z",
          endTime: "2025-03-10T16:00:00.000Z",
          breakMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("deaktiviert");

      // Re-activate for other tests
      await app.prisma.user.update({
        where: { id: data.empUser.id },
        data: { isActive: true },
      });
    });
  });

  describe("SaldoSnapshot lock check", () => {
    it("returns 403 when posting to a month with an existing SaldoSnapshot", async () => {
      const lockedDate = "2024-03-15"; // March 2024 — in the past, no conflict
      // Europe/Berlin = UTC+1 in March (before DST). March 1 00:00 Berlin = Feb 29 23:00 UTC
      const monthStart = new Date("2024-02-29T23:00:00Z");
      const monthEnd = new Date("2024-03-31T21:59:59Z");

      const snapshot = await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: monthStart,
          periodEnd: monthEnd,
          workedMinutes: 1600,
          expectedMinutes: 1600,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
        },
      });

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${data.adminToken}` },
          payload: {
            employeeId: data.employee.id,
            date: lockedDate,
            startTime: `${lockedDate}T08:00:00.000Z`,
            endTime: `${lockedDate}T16:00:00.000Z`,
            breakMinutes: 30,
          },
        });

        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("Monat ist abgeschlossen und kann nicht bearbeitet werden");
      } finally {
        await app.prisma.saldoSnapshot.delete({ where: { id: snapshot.id } });
      }
    });

    it("allows POST to a month with no SaldoSnapshot", async () => {
      // March 2024 has no snapshot for this employee in this scope
      // Use a distinct past date where no snapshot exists
      const unlockedDate = "2024-04-10";

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: unlockedDate,
          startTime: `${unlockedDate}T08:00:00.000Z`,
          endTime: `${unlockedDate}T16:00:00.000Z`,
          breakMinutes: 30,
        },
      });

      // Should not be 403 (lock error). May be 201 or other business error.
      expect(res.statusCode).not.toBe(403);

      // Clean up if entry was created
      if (res.statusCode === 201) {
        const body = JSON.parse(res.body);
        if (body.id) {
          await app.prisma.timeEntry.delete({ where: { id: body.id } });
        }
      }
    });

    it("allows POST to unlocked month even if a different month is locked", async () => {
      // Europe/Berlin = UTC+1 in January (no DST). Jan 1 00:00 Berlin = Dec 31 23:00 UTC
      const lockedMonthStart = new Date("2023-12-31T23:00:00Z");
      const lockedMonthEnd = new Date("2024-01-31T22:59:59Z");

      const snapshot = await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: lockedMonthStart,
          periodEnd: lockedMonthEnd,
          workedMinutes: 1600,
          expectedMinutes: 1600,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
        },
      });

      try {
        // Try posting to February 2024 (different month, not locked)
        const unlockedDate = "2024-02-15";
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${data.adminToken}` },
          payload: {
            employeeId: data.employee.id,
            date: unlockedDate,
            startTime: `${unlockedDate}T08:00:00.000Z`,
            endTime: `${unlockedDate}T16:00:00.000Z`,
            breakMinutes: 30,
          },
        });

        // Should not be 403 — only January is locked, not February
        expect(res.statusCode).not.toBe(403);

        // Clean up if entry was created
        if (res.statusCode === 201) {
          const body = JSON.parse(res.body);
          if (body.id) {
            await app.prisma.timeEntry.delete({ where: { id: body.id } });
          }
        }
      } finally {
        await app.prisma.saldoSnapshot.delete({ where: { id: snapshot.id } });
      }
    });
  });

  describe("Clock-in conflict check ignores invalid open entries", () => {
    it("allows POST /clock-in when only open entry is auto-invalidated (isInvalid: true)", async () => {
      // Simulate autoInvalidateOpenEntries: entry from yesterday with endTime null but isInvalid true
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayDate = new Date(yesterday.toISOString().split("T")[0] + "T00:00:00.000Z");

      const staleEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: yesterdayDate,
          startTime: new Date(yesterday.toISOString().split("T")[0] + "T08:00:00.000Z"),
          endTime: null,
          isInvalid: true,
          invalidReason: "Auto-invalidated open entry",
          source: "MANUAL",
        },
      });

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries/clock-in",
          headers: { authorization: `Bearer ${data.empToken}` },
          payload: { source: "WEB" },
        });

        // Should NOT be blocked — invalid entries must not count as "already clocked in"
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);

        // Clean up the new clock-in entry
        await app.prisma.timeEntry.deleteMany({
          where: { employeeId: data.employee.id, endTime: null, isInvalid: false },
        });
      } finally {
        await app.prisma.timeEntry.deleteMany({ where: { id: staleEntry.id } });
      }
    });

    it("blocks POST /clock-in with 409 when a valid open entry exists (isInvalid: false)", async () => {
      const today = new Date();
      const todayDate = new Date(today.toISOString().split("T")[0] + "T00:00:00.000Z");

      const validOpenEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: todayDate,
          startTime: new Date(today.toISOString().split("T")[0] + "T08:00:00.000Z"),
          endTime: null,
          isInvalid: false,
          source: "MANUAL",
        },
      });

      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries/clock-in",
          headers: { authorization: `Bearer ${data.empToken}` },
          payload: { source: "WEB" },
        });

        // Valid open entry MUST block clock-in
        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.error).toContain("Bereits eingestempelt");
      } finally {
        await app.prisma.timeEntry.deleteMany({ where: { id: validOpenEntry.id } });
      }
    });
  });
});
