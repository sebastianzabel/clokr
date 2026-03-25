import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

describe("Break Slots", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "br");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("POST /time-entries with breaks array", () => {
    it("creates Break records and calculates breakMinutes", async () => {
      const date = "2025-02-03"; // Monday
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date,
          startTime: `${date}T08:00:00.000Z`,
          endTime: `${date}T17:00:00.000Z`,
          breakMinutes: 0, // will be overridden by breaks array
          breaks: [
            {
              startTime: `${date}T12:00:00.000Z`,
              endTime: `${date}T12:30:00.000Z`,
            },
            {
              startTime: `${date}T15:00:00.000Z`,
              endTime: `${date}T15:15:00.000Z`,
            },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      // breakMinutes should be calculated from break slots: 30 + 15 = 45
      expect(body.entry.breakMinutes).toBe(45);

      // Break records should be returned
      expect(body.entry.breaks).toBeDefined();
      expect(body.entry.breaks.length).toBe(2);
    });
  });

  describe("PUT /time-entries/:id with breaks", () => {
    it("replaces existing breaks with new ones", async () => {
      // First create an entry with breaks
      const date = "2025-02-04"; // Tuesday
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date,
          startTime: `${date}T08:00:00.000Z`,
          endTime: `${date}T17:00:00.000Z`,
          breaks: [
            {
              startTime: `${date}T12:00:00.000Z`,
              endTime: `${date}T12:30:00.000Z`,
            },
          ],
        },
      });

      expect(createRes.statusCode).toBe(201);
      const entryId = JSON.parse(createRes.body).entry.id;

      // Update with different breaks
      const updateRes = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entryId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          breaks: [
            {
              startTime: `${date}T12:00:00.000Z`,
              endTime: `${date}T12:45:00.000Z`,
            },
          ],
        },
      });

      expect(updateRes.statusCode).toBe(200);
      const body = JSON.parse(updateRes.body);

      // Should now have 1 break of 45min (replacing old 30min one)
      expect(body.entry.breakMinutes).toBe(45);
      expect(body.entry.breaks.length).toBe(1);
    });
  });

  describe("Auto-break", () => {
    it("auto-break applies >= 30min break when autoBreakEnabled and > 6h work", async () => {
      // Enable autoBreak for this tenant
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { autoBreakEnabled: true },
      });

      const date = "2025-02-05"; // Wednesday
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date,
          startTime: `${date}T08:00:00.000Z`,
          endTime: `${date}T15:00:00.000Z`, // 7h > 6h
          breakMinutes: 0,
          // No breaks array → triggers auto-break
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.entry.breakMinutes).toBeGreaterThanOrEqual(30);
    });

    it("auto-break applies >= 45min break when autoBreakEnabled and > 9h work", async () => {
      const date = "2025-02-06"; // Thursday
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date,
          startTime: `${date}T07:00:00.000Z`,
          endTime: `${date}T17:00:00.000Z`, // 10h > 9h
          breakMinutes: 0,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.entry.breakMinutes).toBeGreaterThanOrEqual(45);

      // Disable autoBreak after tests
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { autoBreakEnabled: false },
      });
    });
  });

  describe("Legacy breakMinutes (no breaks array)", () => {
    it("entry with breakMinutes but no breaks array still works", async () => {
      const date = "2025-02-07"; // Friday
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date,
          startTime: `${date}T08:00:00.000Z`,
          endTime: `${date}T16:30:00.000Z`,
          breakMinutes: 30,
          // No breaks array
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.entry.breakMinutes).toBe(30);
      // No break slot records should be created
      expect(body.entry.breaks).toBeDefined();
      expect(body.entry.breaks.length).toBe(0);
    });
  });
});
