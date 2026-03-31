import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Auto-Break on Clock-out", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "abk");

    // Enable auto-break with default break start at 12:00
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { autoBreakEnabled: true, defaultBreakStart: "12:00" },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("auto-inserts 30min break on clock-out after >6h work", async () => {
    // Create an entry that started 7h ago
    const startTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: today,
        startTime,
        source: "MANUAL",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entry.breakMinutes).toBe(30);
    expect(body.entry.breaks.length).toBe(1);
  });

  it("auto-inserts 45min break on clock-out after >9h work", async () => {
    const startTime = new Date(Date.now() - 10 * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: today,
        startTime,
        source: "MANUAL",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entry.breakMinutes).toBe(45);
  });

  it("does not auto-insert break when manual breaks provided", async () => {
    const startTime = new Date(Date.now() - 8 * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: today,
        startTime,
        source: "MANUAL",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { breakMinutes: 15 },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Manual break provided, auto-break should NOT override
    expect(body.entry.breakMinutes).toBe(15);
  });

  it("does not auto-insert break for short shifts (<6h)", async () => {
    const startTime = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: today,
        startTime,
        source: "MANUAL",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entry.breakMinutes).toBe(0);
  });
});
