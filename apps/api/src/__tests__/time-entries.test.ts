import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

describe("Time Entries API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "te");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
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

    it("returns ArbZG warnings when daily hours exceed 10h", async () => {
      const d = pastDate(5);
      // Clean any existing entries for this day
      await app.prisma.timeEntry.deleteMany({
        where: { employeeId: data.employee.id, date: new Date(d + "T00:00:00Z") },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: d,
          startTime: `${d}T06:00:00.000Z`,
          endTime: `${d}T17:00:00.000Z`,
          breakMinutes: 45,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.warnings).toBeDefined();
      expect(body.warnings.length).toBeGreaterThan(0);
      // 11h - 45min break = 10.25h > 10h → MAX_DAILY_EXCEEDED error
      const maxDaily = body.warnings.find((w: { code: string }) => w.code === "MAX_DAILY_EXCEEDED");
      expect(maxDaily).toBeDefined();
    });

    it("rejects entry with endTime before startTime", async () => {
      const d = pastDate(4);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: d,
          startTime: `${d}T16:00:00.000Z`,
          endTime: `${d}T08:00:00.000Z`,
          breakMinutes: 0,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("employee can create their own entry", async () => {
      const d = pastDate(10);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {
          date: d,
          startTime: `${d}T08:00:00.000Z`,
          endTime: `${d}T16:00:00.000Z`,
          breakMinutes: 30,
        },
      });

      if (res.statusCode !== 201) console.error("EMPLOYEE CREATE FAIL:", res.body);
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

  // ── COMPLIANCE: Time entry CRUD completeness ──────────────────────────────
  describe("COMPLIANCE: Time entry CRUD completeness", () => {
    const crudCleanupIds: string[] = [];

    afterAll(async () => {
      if (crudCleanupIds.length > 0) {
        await app.prisma.timeEntry.deleteMany({
          where: { id: { in: crudCleanupIds } },
        });
      }
    });

    it("creates a time entry with valid data", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-04-07",
          startTime: "2025-04-07T07:00:00Z",
          endTime: "2025-04-07T15:30:00Z",
          breakMinutes: 30,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.entry).toBeDefined();
      expect(body.entry.id).toBeDefined();
      expect(body.entry.employeeId).toBe(data.employee.id);
      crudCleanupIds.push(body.entry.id);
    });

    it("updates an existing time entry", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-04-08",
          startTime: "2025-04-08T07:00:00Z",
          endTime: "2025-04-08T15:30:00Z",
          breakMinutes: 30,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);
      crudCleanupIds.push(created.entry.id);

      const updateRes = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${created.entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { breakMinutes: 45 },
      });

      expect(updateRes.statusCode).toBe(200);
      const updated = JSON.parse(updateRes.body);
      expect(updated.entry.breakMinutes).toBe(45);
    });

    it("deletes a time entry via API", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-04-09",
          startTime: "2025-04-09T07:00:00Z",
          endTime: "2025-04-09T15:30:00Z",
          breakMinutes: 30,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);
      crudCleanupIds.push(created.entry.id);

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${created.entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect([200, 204]).toContain(deleteRes.statusCode);
    });

    it("rejects duplicate entry for same employee and date with 409", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-04-10",
          startTime: "2025-04-10T07:00:00Z",
          endTime: "2025-04-10T15:30:00Z",
          breakMinutes: 30,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);
      crudCleanupIds.push(created.entry.id);

      const dupRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-04-10",
          startTime: "2025-04-10T09:00:00Z",
          endTime: "2025-04-10T17:00:00Z",
          breakMinutes: 30,
        },
      });

      expect(dupRes.statusCode).toBe(409);
      const dupBody = JSON.parse(dupRes.body);
      expect(dupBody.error).toBeDefined();
    });

    it("lists time entries with employeeId filter", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-04-11",
          startTime: "2025-04-11T07:00:00Z",
          endTime: "2025-04-11T15:30:00Z",
          breakMinutes: 30,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);
      crudCleanupIds.push(created.entry.id);

      const listRes = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${data.employee.id}&year=2025&month=4`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.body);
      expect(Array.isArray(listBody)).toBe(true);
      expect(listBody.length).toBeGreaterThanOrEqual(1);
      const match = listBody.find((e: { employeeId: string }) => e.employeeId === data.employee.id);
      expect(match).toBeDefined();
    });
  });

  // ── COMPLIANCE: Soft delete enforcement ──────────────────────────────────
  describe("COMPLIANCE: Soft delete enforcement", () => {
    const softDeleteCleanupIds: string[] = [];

    afterAll(async () => {
      if (softDeleteCleanupIds.length > 0) {
        await app.prisma.timeEntry.deleteMany({
          where: { id: { in: softDeleteCleanupIds } },
        });
      }
    });

    it("DELETE sets deletedAt, does not hard-delete the row", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-05-05",
          startTime: "2025-05-05T07:00:00Z",
          endTime: "2025-05-05T15:30:00Z",
          breakMinutes: 30,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body);
      const entryId = created.entry.id;
      softDeleteCleanupIds.push(entryId);

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${entryId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect([200, 204]).toContain(deleteRes.statusCode);

      // Verify row still exists in DB
      const row = await app.prisma.timeEntry.findUnique({ where: { id: entryId } });
      expect(row).not.toBeNull();
      expect(row!.deletedAt).not.toBeNull();
    });

    it("GET excludes soft-deleted entries", async () => {
      // Create directly via Prisma and soft-delete it
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2025-05-06"),
          startTime: new Date("2025-05-06T07:00:00Z"),
          endTime: new Date("2025-05-06T15:30:00Z"),
          breakMinutes: 30,
          source: "MANUAL",
          deletedAt: new Date(),
        },
      });
      softDeleteCleanupIds.push(entry.id);

      const listRes = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${data.employee.id}&year=2025&month=5`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.body);
      const found = listBody.find((e: { id: string }) => e.id === entry.id);
      expect(found).toBeUndefined();
    });
  });

  // ── COMPLIANCE: Locked month immutability ────────────────────────────────
  describe("COMPLIANCE: Locked month immutability", () => {
    const lockedCleanupIds: string[] = [];

    afterAll(async () => {
      if (lockedCleanupIds.length > 0) {
        await app.prisma.timeEntry.deleteMany({
          where: { id: { in: lockedCleanupIds } },
        });
      }
    });

    it("rejects PUT on entry in locked month", async () => {
      // Create locked entry directly via Prisma (isLocked: true)
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2025-01-15"),
          startTime: new Date("2025-01-15T08:00:00Z"),
          endTime: new Date("2025-01-15T16:00:00Z"),
          breakMinutes: 30,
          source: "MANUAL",
          isLocked: true,
        },
      });
      lockedCleanupIds.push(entry.id);

      const putRes = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { breakMinutes: 45 },
      });

      expect([403, 409, 422]).toContain(putRes.statusCode);
    });

    it("rejects DELETE on entry in locked month", async () => {
      // Create locked entry directly via Prisma (isLocked: true)
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2025-01-16"),
          startTime: new Date("2025-01-16T08:00:00Z"),
          endTime: new Date("2025-01-16T16:00:00Z"),
          breakMinutes: 30,
          source: "MANUAL",
          isLocked: true,
        },
      });
      lockedCleanupIds.push(entry.id);

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect([403, 409, 422]).toContain(deleteRes.statusCode);
    });
  });
});
