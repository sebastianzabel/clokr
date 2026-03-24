import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Time Entries API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "te");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("POST /api/v1/time-entries (manual entry)", () => {
    it("creates a time entry as admin for employee", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-03-23",
          startTime: "2026-03-23T08:00:00.000Z",
          endTime: "2026-03-23T16:30:00.000Z",
          breakMinutes: 30,
          note: "Test entry",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.entry).toBeDefined();
      expect(body.entry.employeeId).toBe(data.employee.id);
      expect(body.entry.breakMinutes).toBe(30);
    });

    it("rejects overlapping time entries", async () => {
      // Create first entry
      await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-03-24",
          startTime: "2026-03-24T08:00:00.000Z",
          endTime: "2026-03-24T12:00:00.000Z",
          breakMinutes: 0,
        },
      });

      // Try overlapping entry
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-03-24",
          startTime: "2026-03-24T10:00:00.000Z",
          endTime: "2026-03-24T14:00:00.000Z",
          breakMinutes: 0,
        },
      });

      expect(res.statusCode).toBe(409);
    });

    it("returns ArbZG warnings when daily hours exceed 8h", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-03-25",
          startTime: "2026-03-25T06:00:00.000Z",
          endTime: "2026-03-25T17:00:00.000Z",
          breakMinutes: 45,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.warnings).toBeDefined();
      expect(body.warnings.length).toBeGreaterThan(0);
      // 11h - 45min break = 10.25h > 10h → MAX_DAILY_EXCEEDED error
      const maxDaily = body.warnings.find((w: any) => w.code === "MAX_DAILY_EXCEEDED");
      expect(maxDaily).toBeDefined();
    });

    it("rejects entry with endTime before startTime", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2026-03-26",
          startTime: "2026-03-26T16:00:00.000Z",
          endTime: "2026-03-26T08:00:00.000Z",
          breakMinutes: 0,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("employee can create their own entry", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          date: "2026-03-27",
          startTime: "2026-03-27T08:00:00.000Z",
          endTime: "2026-03-27T16:00:00.000Z",
          breakMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.entry.employeeId).toBe(data.employee.id);
    });
  });

  describe("POST /api/v1/time-entries/clock-in + clock-out", () => {
    it("clock-in and clock-out flow works", async () => {
      // Clean up any open entries from previous tests
      const openEntries = await app.prisma.timeEntry.findMany({
        where: { employeeId: data.employee.id, endTime: null },
      });
      for (const e of openEntries) {
        await app.prisma.timeEntry.update({
          where: { id: e.id },
          data: { endTime: new Date() },
        });
      }

      // Clock in
      const clockInRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { source: "MANUAL" },
      });

      // 201 (Created) or 200 (OK) depending on route implementation
      expect(clockInRes.statusCode).toBeLessThan(300);
      const clockInBody = JSON.parse(clockInRes.body);
      const entry = clockInBody.entry;
      expect(entry).toBeDefined();
      expect(entry.endTime).toBeNull();

      // Clock out
      const clockOutRes = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entry.id}/clock-out`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { breakMinutes: 0 },
      });

      expect(clockOutRes.statusCode).toBe(200);
      const clockOutBody = JSON.parse(clockOutRes.body);
      expect(clockOutBody.entry.endTime).not.toBeNull();
    });

    it("cannot clock in twice", async () => {
      // First clock in
      await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { source: "MANUAL" },
      });

      // Second clock in should fail
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { source: "MANUAL" },
      });

      expect(res.statusCode).toBe(409);

      // Clean up: clock out
      const entries = await app.prisma.timeEntry.findMany({
        where: { employeeId: data.adminEmployee.id, endTime: null },
      });
      for (const e of entries) {
        await app.inject({
          method: "POST",
          url: `/api/v1/time-entries/${e.id}/clock-out`,
          headers: { authorization: `Bearer ${data.adminToken}` },
          payload: { breakMinutes: 0 },
        });
      }
    });
  });

  describe("Overtime account updates", () => {
    it("overtime account exists and has a balance", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.balanceHours).toBeDefined();
      expect(body.status).toBeDefined();
      expect(["NORMAL", "ELEVATED", "CRITICAL"]).toContain(body.status);
    });
  });
});
