import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

/**
 * Tests for saldo calculations, Monatsabschluss, and soft-delete correctness.
 *
 * Uses fixed historical dates (January 2025) to ensure deterministic results
 * independent of the current date.
 */
describe("Saldo Snapshot & Monatsabschluss", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "snap");
  });

  afterAll(async () => {
    try {
      // Clean up snapshots first (not in standard cleanup)
      await app.prisma.saldoSnapshot.deleteMany({
        where: { employeeId: { in: [data.employee.id, data.adminEmployee.id] } },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Helper: create time entry for a fixed date
  async function createEntry(
    employeeId: string,
    date: string,
    startHour: number,
    endHour: number,
    breakMin = 0,
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${String(startHour).padStart(2, "0")}:00:00.000Z`),
        endTime: new Date(`${date}T${String(endHour).padStart(2, "0")}:00:00.000Z`),
        breakMinutes: breakMin,
        source: "MANUAL",
        type: "WORK",
      },
    });
  }

  describe("Monatsabschluss (close-month)", () => {
    it("closes a month and creates a snapshot with correct values", async () => {
      // January 2025: Mo-Fr workdays
      // Create entries for a full week (Mon 6 - Fri 10 Jan 2025)
      // Schedule: 8h/day, 40h/week
      await createEntry(data.employee.id, "2025-01-06", 8, 17, 60); // 8h net (9h - 1h break)
      await createEntry(data.employee.id, "2025-01-07", 8, 17, 60); // 8h
      await createEntry(data.employee.id, "2025-01-08", 8, 17, 60); // 8h
      await createEntry(data.employee.id, "2025-01-09", 8, 17, 60); // 8h
      await createEntry(data.employee.id, "2025-01-10", 8, 17, 60); // 8h
      // Total: 40h worked in that week

      // Second week (Mon 13 - Fri 17): 9h/day = 45h (5h overtime)
      await createEntry(data.employee.id, "2025-01-13", 7, 17, 60); // 9h
      await createEntry(data.employee.id, "2025-01-14", 7, 17, 60); // 9h
      await createEntry(data.employee.id, "2025-01-15", 7, 17, 60); // 9h
      await createEntry(data.employee.id, "2025-01-16", 7, 17, 60); // 9h
      await createEntry(data.employee.id, "2025-01-17", 7, 17, 60); // 9h
      // Total: 45h worked

      // Close January 2025
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: data.employee.id, year: 2025, month: 1 },
      });

      expect(res.statusCode).toBe(201);
      const snapshot = JSON.parse(res.body);

      // 85h worked (40+45), January 2025 has 23 workdays * 8h = 184h expected
      // But we only entered 10 days, so expected is still 184h from schedule
      expect(snapshot.workedMinutes).toBe(85 * 60); // 5100 min
      expect(snapshot.periodType).toBe("MONTHLY");
      expect(snapshot.balanceMinutes).toBe(snapshot.workedMinutes - snapshot.expectedMinutes);
      expect(snapshot.carryOver).toBe(snapshot.balanceMinutes); // First month, no prior carry
    });

    it("rejects closing an already-closed month", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: data.employee.id, year: 2025, month: 1 },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toContain("bereits abgeschlossen");
    });

    it("rejects closing a future month", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: data.employee.id, year: 2099, month: 12 },
      });

      expect(res.statusCode).toBe(400);
      const errMsg = JSON.parse(res.body).error;
      expect(errMsg).toMatch(/Zukünftige|Bitte zuerst/);
    });

    it("locks time entries after Monatsabschluss", async () => {
      // All January 2025 entries should now be locked
      const entries = await app.prisma.timeEntry.findMany({
        where: {
          employeeId: data.employee.id,
          date: {
            gte: new Date("2025-01-01T00:00:00Z"),
            lte: new Date("2025-01-31T23:59:59Z"),
          },
          deletedAt: null,
        },
      });

      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.isLocked).toBe(true);
        expect(e.lockedAt).not.toBeNull();
      }
    });

    it("chains carryOver correctly across months", async () => {
      // Create February entries: 1 day, 10h (2h overtime)
      await createEntry(data.employee.id, "2025-02-03", 7, 17, 0); // 10h (Mon)

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: data.employee.id, year: 2025, month: 2 },
      });
      expect(res.statusCode).toBe(201);
      const febSnapshot = JSON.parse(res.body);

      // Get January snapshot for comparison (use date range since TZ may shift periodStart)
      const janSnapshot = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: {
            gte: new Date("2024-12-31"),
            lte: new Date("2025-01-02"),
          },
        },
      });
      expect(janSnapshot).not.toBeNull();

      // February carryOver = January carryOver + February balance
      expect(febSnapshot.carryOver).toBe(janSnapshot!.carryOver + febSnapshot.balanceMinutes);
    });

    it("lists snapshots for an employee", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/snapshots/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const snapshots = JSON.parse(res.body);
      expect(snapshots.length).toBeGreaterThanOrEqual(2); // Jan + Feb
      // Ordered by periodStart desc
      expect(new Date(snapshots[0].periodStart).getTime()).toBeGreaterThan(
        new Date(snapshots[1].periodStart).getTime(),
      );
    });
  });

  describe("isLocked enforcement", () => {
    it("blocks editing a locked time entry", async () => {
      // Find a locked entry
      const locked = await app.prisma.timeEntry.findFirst({
        where: { employeeId: data.employee.id, isLocked: true, deletedAt: null },
      });
      expect(locked).not.toBeNull();

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${locked!.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          date: "2025-01-06",
          startTime: new Date("2025-01-06T07:00:00Z").toISOString(),
          endTime: new Date("2025-01-06T18:00:00Z").toISOString(),
        },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toContain("gesperrt");
    });

    it("blocks deleting a locked time entry", async () => {
      const locked = await app.prisma.timeEntry.findFirst({
        where: { employeeId: data.employee.id, isLocked: true, deletedAt: null },
      });
      expect(locked).not.toBeNull();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${locked!.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toContain("gesperrt");
    });
  });

  describe("Soft delete correctness", () => {
    it("soft-deleted entries are excluded from GET /time-entries", async () => {
      // Create an entry and then soft-delete it
      const entry = await createEntry(data.employee.id, "2025-03-03", 8, 16, 0);
      await app.prisma.timeEntry.update({
        where: { id: entry.id },
        data: { deletedAt: new Date() },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?from=2025-03-01&to=2025-03-31&employeeId=${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const entries = JSON.parse(res.body);
      const found = entries.find((e: { id: string }) => e.id === entry.id);
      expect(found).toBeUndefined();
    });

    it("soft-deleted entries are excluded from overtime calculation", async () => {
      // Clean March entries
      await app.prisma.timeEntry.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: {
            gte: new Date("2025-03-01T00:00:00Z"),
            lte: new Date("2025-03-31T23:59:59Z"),
          },
        },
      });

      // Create two entries for March 3 (Mon)
      await createEntry(data.employee.id, "2025-03-03", 8, 16, 0); // 8h
      const entry2 = await createEntry(data.employee.id, "2025-03-04", 8, 18, 0); // 10h

      // Soft-delete entry2
      await app.prisma.timeEntry.update({
        where: { id: entry2.id },
        data: { deletedAt: new Date() },
      });

      // Close March
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: data.employee.id, year: 2025, month: 3 },
      });
      expect(res.statusCode).toBe(201);
      const snapshot = JSON.parse(res.body);

      // Only entry1 (8h = 480min) should count
      expect(snapshot.workedMinutes).toBe(480);
    });

    it("DELETE /time-entries/:id soft-deletes (not hard delete)", async () => {
      const entry = await createEntry(data.employee.id, "2025-04-07", 8, 16, 0);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(204);

      // Entry should still exist in DB with deletedAt set
      const dbEntry = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
      expect(dbEntry).not.toBeNull();
      expect(dbEntry!.deletedAt).not.toBeNull();
    });
  });

  describe("One entry per day", () => {
    it("rejects creating a second entry for the same day", async () => {
      // First entry via API
      const res1 = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-04-14",
          startTime: new Date("2025-04-14T08:00:00Z").toISOString(),
          endTime: new Date("2025-04-14T16:00:00Z").toISOString(),
          breakMinutes: 0,
        },
      });
      expect(res1.statusCode).toBe(201);

      // Second entry for same day should be rejected
      const res2 = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          employeeId: data.employee.id,
          date: "2025-04-14",
          startTime: new Date("2025-04-14T17:00:00Z").toISOString(),
          endTime: new Date("2025-04-14T19:00:00Z").toISOString(),
          breakMinutes: 0,
        },
      });
      expect(res2.statusCode).toBe(409);
      expect(JSON.parse(res2.body).error).toContain("bereits ein Eintrag");
    });
  });

  describe("Report calculations with soft delete", () => {
    it("monthly report excludes soft-deleted entries", async () => {
      // Clean May and create entries
      await app.prisma.timeEntry.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: {
            gte: new Date("2025-05-01T00:00:00Z"),
            lte: new Date("2025-05-31T23:59:59Z"),
          },
        },
      });

      await createEntry(data.employee.id, "2025-05-05", 8, 16, 0); // 8h
      const deleted = await createEntry(data.employee.id, "2025-05-06", 8, 18, 0); // 10h
      await app.prisma.timeEntry.update({
        where: { id: deleted.id },
        data: { deletedAt: new Date() },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly?employeeId=${data.employee.id}&year=2025&month=5`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const report = JSON.parse(res.body);
      const row = report.rows.find((r: { employeeId: string; workedHours: number }) => r.employeeId === data.employee.id);

      // Only 8h from active entry should count
      expect(row.workedHours).toBeCloseTo(8, 1);
    });
  });
});
