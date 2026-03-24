import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Leave / Absence API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lv");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("POST /api/v1/leave/requests", () => {
    it("creates a vacation request", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-07-06",
          endDate: "2026-07-10",
          note: "Sommerurlaub",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("PENDING");
      expect(body.typeCode).toBe("VACATION");
      // Mon-Fri = 5 working days
      expect(Number(body.days)).toBe(5);
    });

    it("creates a sick leave request", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "SICK",
          startDate: "2026-08-03",
          endDate: "2026-08-05",
          note: "Erkältet",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.typeCode).toBe("SICK");
      // SICK may be auto-approved or PENDING depending on config
      expect(["PENDING", "APPROVED"]).toContain(body.status);
      // Mon-Wed = 3 working days
      expect(Number(body.days)).toBe(3);
    });

    it("creates a half-day request", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-08-10",
          endDate: "2026-08-10",
          halfDay: true,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(Number(body.days)).toBe(0.5);
    });

    it("rejects request with startDate after endDate", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-07-20",
          endDate: "2026-07-15",
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects vacation exceeding remaining days", async () => {
      // Employee has 30 days, try to request 25 work days (5 weeks)
      // But also has some already requested above... let's request a huge block
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-01-05",
          endDate: "2026-03-15",
          note: "Too many days",
        },
      });

      // Should be rejected (50+ work days > 30 entitlement)
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /api/v1/leave/requests/:id/review", () => {
    it("admin can approve a vacation request", async () => {
      // Create a request as employee
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-09-07",
          endDate: "2026-09-11",
        },
      });
      const { id: requestId } = JSON.parse(createRes.body);

      // Approve as admin
      const reviewRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/review`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          status: "APPROVED",
          reviewNote: "Genehmigt",
        },
      });

      expect(reviewRes.statusCode).toBe(200);
      const body = JSON.parse(reviewRes.body);
      expect(body.status).toBe("APPROVED");
      expect(body.reviewNote).toBe("Genehmigt");
    });

    it("admin can reject a vacation request", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-10-05",
          endDate: "2026-10-09",
        },
      });
      const { id: requestId } = JSON.parse(createRes.body);

      const reviewRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/review`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          status: "REJECTED",
          reviewNote: "Betriebsurlaub",
        },
      });

      expect(reviewRes.statusCode).toBe(200);
      const body = JSON.parse(reviewRes.body);
      expect(body.status).toBe("REJECTED");
    });

    it("employee cannot review own request", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-11-02",
          endDate: "2026-11-06",
        },
      });
      const { id: requestId } = JSON.parse(createRes.body);

      const reviewRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/review`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { status: "APPROVED" },
      });

      expect(reviewRes.statusCode).toBe(403);
    });
  });

  describe("Vacation day deductions", () => {
    it("approving vacation deducts from entitlement", async () => {
      // Check entitlement before
      const beforeRes = await app.inject({
        method: "GET",
        url: `/api/v1/leave/entitlements/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const entitlements = JSON.parse(beforeRes.body);
      const vacEnt = entitlements.find((e: any) => e.leaveType?.name === "Urlaub");
      const usedBefore = Number(vacEnt?.usedDays ?? 0);

      // Create and approve 2-day vacation
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-12-07",
          endDate: "2026-12-08",
        },
      });
      const { id: requestId, days } = JSON.parse(createRes.body);

      await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/review`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { status: "APPROVED" },
      });

      // Check entitlement after
      const afterRes = await app.inject({
        method: "GET",
        url: `/api/v1/leave/entitlements/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const entAfter = JSON.parse(afterRes.body);
      const vacEntAfter = entAfter.find((e: any) => e.leaveType?.name === "Urlaub");
      const usedAfter = Number(vacEntAfter?.usedDays ?? 0);

      expect(usedAfter).toBe(usedBefore + Number(days));
    });
  });

  describe("DELETE /api/v1/leave/requests/:id", () => {
    it("employee can cancel own pending request", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          type: "VACATION",
          startDate: "2026-12-14",
          endDate: "2026-12-18",
        },
      });
      const { id: requestId } = JSON.parse(createRes.body);

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/leave/requests/${requestId}`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      // 200 or 204 depending on implementation
      expect(deleteRes.statusCode).toBeLessThan(300);
      expect(deleteRes.statusCode).toBeGreaterThanOrEqual(200);
    });
  });
});
