import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Shift Planning API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sh");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Templates", () => {
    let templateId: string;

    it("creates a shift template", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          name: "Frühschicht",
          startTime: "06:00",
          endTime: "14:00",
          color: "#22c55e",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Frühschicht");
      expect(body.startTime).toBe("06:00");
      templateId = body.id;
    });

    it("lists templates", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((t: any) => t.name === "Frühschicht")).toBe(true);
    });

    it("deletes a template", async () => {
      // Create a throwaway template
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/templates",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { name: "Delete Me", startTime: "22:00", endTime: "06:00" },
      });
      const { id } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/shifts/templates/${id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(204);
    });
  });

  describe("Shifts", () => {
    it("creates a shift", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-06-15",
          startTime: "08:00",
          endTime: "16:00",
          label: "Normalschicht",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.employeeId).toBe(data.employee.id);
      expect(body.startTime).toBe("08:00");
    });

    it("gets week view", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/shifts/week?date=2026-06-15",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.weekDays).toHaveLength(7);
      expect(body.employees).toBeDefined();
      expect(body.shifts).toBeDefined();
      expect(body.shifts.length).toBeGreaterThan(0);
    });

    it("creates bulk shifts", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/bulk",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          shifts: [
            { employeeId: data.employee.id, date: "2026-06-16", startTime: "08:00", endTime: "16:00" },
            { employeeId: data.employee.id, date: "2026-06-17", startTime: "08:00", endTime: "16:00" },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.created).toBe(2);
    });

    it("deletes a shift", async () => {
      // Create then delete
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-06-20",
          startTime: "06:00",
          endTime: "14:00",
        },
      });
      const { id } = JSON.parse(createRes.body);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/shifts/${id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(204);
    });

    it("employee cannot create shifts", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-06-22",
          startTime: "08:00",
          endTime: "16:00",
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
