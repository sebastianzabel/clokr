import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
} from "../../../../__tests__/setup";
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
          reason: "Korrektur nach Rückfrage",
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

  // Phase 380 (issue #380): POST /:id/breaks used to unconditionally recompute
  // breakMinutes from Break.findMany() after appending the new break — so an entry
  // that carried a legacy/manual breakMinutes sum with zero Break rows had that sum
  // silently discarded the moment a break was appended (30 real minutes becoming 15).
  // These cases pin the new 400 guard (Case A), confirm it does not affect entries
  // unaffected by the bug (Cases B/C), and confirm the existing PUT /:id conversion
  // path already resolves the situation without any handler change (Case D).
  describe("POST /:id/breaks — reject when breakMinutes > 0 and no Break rows exist (#380)", () => {
    it("Case A: rejects with 400 and leaves breakMinutes/Break rows untouched when the entry has a breakMinutes sum but no Break rows", async () => {
      const date = "2025-02-10"; // Monday
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(date),
          startTime: new Date(`${date}T08:00:00.000Z`),
          endTime: new Date(`${date}T16:30:00.000Z`),
          breakMinutes: 30,
          source: "MANUAL",
          salonId: data.salonId,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entry.id}/breaks`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          startTime: `${date}T11:00:00.000Z`,
          endTime: `${date}T11:15:00.000Z`,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Einzelpausen");

      // No data loss: breakMinutes stays at its pre-request value.
      const refetched = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
      expect(refetched?.breakMinutes).toBe(30);
      // No orphan Break row was created before the rejection.
      const breakCount = await app.prisma.break.count({ where: { timeEntryId: entry.id } });
      expect(breakCount).toBe(0);
    });

    it("Case B: a fresh entry with breakMinutes === 0 and no Break rows is unaffected — first break-add still succeeds", async () => {
      const date = "2025-02-11"; // Tuesday
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(date),
          startTime: new Date(`${date}T08:00:00.000Z`),
          endTime: new Date(`${date}T16:30:00.000Z`),
          breakMinutes: 0,
          source: "MANUAL",
          salonId: data.salonId,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entry.id}/breaks`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          startTime: `${date}T11:00:00.000Z`,
          endTime: `${date}T11:15:00.000Z`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.break).toBeDefined();
      expect(body.breakMinutes).toBe(15);
    });

    it("Case C: an entry with existing Break rows is unaffected regardless of breakMinutes — recompute-from-all-breaks stays as-is", async () => {
      const date = "2025-02-12"; // Wednesday
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(date),
          startTime: new Date(`${date}T08:00:00.000Z`),
          endTime: new Date(`${date}T16:30:00.000Z`),
          breakMinutes: 20,
          source: "MANUAL",
          salonId: data.salonId,
          breaks: {
            create: [
              {
                startTime: new Date(`${date}T10:00:00.000Z`),
                endTime: new Date(`${date}T10:20:00.000Z`),
              },
            ],
          },
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entry.id}/breaks`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          startTime: `${date}T12:00:00.000Z`,
          endTime: `${date}T12:15:00.000Z`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Sum of both breaks: 20 (existing) + 15 (new) = 35.
      expect(body.breakMinutes).toBe(35);
    });

    it("Case D: PUT /:id with breaks:[...] converts a breakMinutes-only entry into real Break rows (already-working path, no code change)", async () => {
      const date = "2025-02-13"; // Thursday
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(date),
          startTime: new Date(`${date}T08:00:00.000Z`),
          endTime: new Date(`${date}T16:30:00.000Z`),
          breakMinutes: 30,
          source: "MANUAL",
          salonId: data.salonId,
        },
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          breaks: [{ startTime: `${date}T11:00:00.000Z`, endTime: `${date}T11:35:00.000Z` }],
          reason: "Pause in Einzelpausen aufteilen (#380)",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.entry.breaks.length).toBe(1);
      expect(body.entry.breakMinutes).toBe(35);
    });
  });
});
