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

    it("blocks POST /clock-in when approved vacation exists today", async () => {
      // We can only test clock-in for "today" if we have approved leave today.
      // Create approved leave for today.
      const todayStr = new Date().toISOString().split("T")[0];

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: todayStr,
          endDate: todayStr,
        },
      });

      if (createRes.statusCode === 201) {
        const reqId = JSON.parse(createRes.body).id;

        const approveRes = await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${reqId}/review`,
          headers: { authorization: `Bearer ${data.adminToken}` },
          payload: { status: "APPROVED" },
        });
        expect(approveRes.statusCode).toBe(200);

        // Close any open entries first
        const openEntries = await app.prisma.timeEntry.findMany({
          where: { employeeId: data.employee.id, endTime: null },
        });
        for (const e of openEntries) {
          await app.prisma.timeEntry.update({
            where: { id: e.id },
            data: { endTime: new Date() },
          });
        }

        const clockInRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries/clock-in",
          headers: { authorization: `Bearer ${data.empToken}` },
          payload: { source: "MANUAL" },
        });

        expect(clockInRes.statusCode).toBe(409);
        const body = JSON.parse(clockInRes.body);
        expect(body.error).toContain("BUrlG");

        // Clean up: delete the leave request so other tests are not affected
        await app.inject({
          method: "DELETE",
          url: `/api/v1/leave/requests/${reqId}`,
          headers: { authorization: `Bearer ${data.adminToken}` },
        });
      }
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
});
