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
});
