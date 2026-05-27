/**
 * Phase 60 (v1.6.5, GitHub #220) — integration tests for WorkSchedule.validFrom
 * month-1st enforcement.
 *
 * Verifies:
 *   1. PUT /settings/work/:employeeId rejects non-month-1st validFrom with 400
 *      and the exact German error string from month-first-date.ts.
 *   2. PUT /settings/work/:employeeId accepts month-1st validFrom (happy path).
 *   3. PUT /settings/work applyToExisting flow snaps server-side `now` to
 *      month-1st before writing — bulk apply NEVER produces a non-1st row.
 *   4. Existing non-1st validFrom rows (seeded directly via prisma, bypassing
 *      Zod) remain visible on read endpoints — audit trail preserved.
 *
 * Pattern mirrors apps/api/src/routes/__tests__/schedule-versioning.test.ts
 * (shared singleton app, seedTestData, cleanupTestData).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { MONTH_FIRST_ERROR } from "../utils/month-first-date";
import type { FastifyInstance } from "fastify";

describe("WorkSchedule.validFrom month-1st enforcement (Phase 60, #220)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let secondEmpId: string;

  // Helper: PUT /api/v1/settings/work/:employeeId with a fully-formed payload.
  const putSchedule = async (validFrom: string) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 35,
        mondayHours: 7,
        tuesdayHours: 7,
        wednesdayHours: 7,
        thursdayHours: 7,
        fridayHours: 7,
        saturdayHours: 0,
        sundayHours: 0,
        overtimeThreshold: 60,
        allowOvertimePayout: false,
        validFrom,
      },
    });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vfm");

    // Seed a SECOND employee with a non-month-1st validFrom WorkSchedule.
    // We bypass Zod by writing directly via prisma — this models existing rows
    // that may have landed in the DB before Phase 60 enforcement existed.
    const passwordHash = await bcrypt.hash("test1234", 10);
    const slug = "vfm-emp2-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = await app.prisma.user.create({
      data: {
        email: `emp2-${slug}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `E2-${slug}`,
        firstName: "Mid",
        lastName: "Month",
        hireDate: new Date("2024-01-01"),
      },
    });
    secondEmpId = emp.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        overtimeThreshold: 60,
        allowOvertimePayout: false,
        overtimeMode: "CARRY_FORWARD",
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2026-05-18T00:00:00Z"), // INTENTIONALLY mid-month
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Test 1: PUT /settings/work/:employeeId rejects non-month-1st validFrom", () => {
    const cases = ["2026-05-15", "2026-05-31", "2026-02-29", "2026-12-15"];
    for (const validFrom of cases) {
      it(`rejects validFrom=${validFrom} with 400 + German error`, async () => {
        const before = await app.prisma.workSchedule.count({
          where: { employeeId: data.employee.id },
        });

        const res = await putSchedule(validFrom);
        expect(res.statusCode).toBe(400);

        const body = res.json() as {
          error: string;
          message?: string;
          details?: Array<{ path: (string | number)[]; message: string }>;
        };
        // The global ZodError handler wraps issues in `details`.
        // Either `details` carries the validFrom error OR `message` includes it —
        // the test accepts both shapes to remain robust to the handler format.
        const detailMsgs = (body.details ?? []).map((d) => d.message);
        const matched =
          detailMsgs.includes(MONTH_FIRST_ERROR) ||
          (typeof body.message === "string" && body.message.includes(MONTH_FIRST_ERROR));
        expect(
          matched,
          `Expected German month-1st error in response. Got: ${JSON.stringify(body)}`,
        ).toBe(true);

        const after = await app.prisma.workSchedule.count({
          where: { employeeId: data.employee.id },
        });
        expect(after).toBe(before);
      });
    }
  });

  describe("Test 2: PUT /settings/work/:employeeId accepts month-1st validFrom", () => {
    it("accepts validFrom=2026-06-01 and writes a new schedule version", async () => {
      const before = await app.prisma.workSchedule.count({
        where: { employeeId: data.employee.id },
      });

      const res = await putSchedule("2026-06-01");
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Number(body.weeklyHours)).toBe(35);

      const after = await app.prisma.workSchedule.count({
        where: { employeeId: data.employee.id },
      });
      expect(after).toBe(before + 1);
    });
  });

  describe("Test 3: applyToExisting (PUT /settings/work) snaps validFrom to month-1st", () => {
    it("bulk apply writes WorkSchedule rows with validFrom = 1st of current UTC month", async () => {
      const captured = new Date();
      const expectedYear = captured.getUTCFullYear();
      const expectedMonth = captured.getUTCMonth(); // 0-indexed

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          applyToExisting: true,
          defaultWeeklyHours: 38,
          defaultMondayHours: 7.6,
          defaultTuesdayHours: 7.6,
          defaultWednesdayHours: 7.6,
          defaultThursdayHours: 7.6,
          defaultFridayHours: 7.6,
          defaultSaturdayHours: 0,
          defaultSundayHours: 0,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.appliedCount).toBeGreaterThanOrEqual(1);

      // The bulk-apply row is the most recently CREATED row for this employee
      // (Test 2 wrote a 2026-06-01 row which still wins on `validFrom desc`,
      // so we sort by `createdAt desc` to find the row Test 3 wrote).
      const newest = await app.prisma.workSchedule.findFirst({
        where: { employeeId: data.employee.id },
        orderBy: { createdAt: "desc" },
      });
      expect(newest).not.toBeNull();
      expect(newest!.validFrom.getUTCDate()).toBe(1);
      expect(newest!.validFrom.getUTCFullYear()).toBe(expectedYear);
      expect(newest!.validFrom.getUTCMonth()).toBe(expectedMonth);
    });
  });

  describe("Test 4: existing non-1st validFrom row survives read endpoints", () => {
    it("GET /settings/work/:employeeId returns the mid-May row unchanged (audit trail preserved)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/settings/work/${secondEmpId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // The mid-May row is the most recent for the second employee (only schedule).
      expect(new Date(body.validFrom).toISOString().slice(0, 10)).toBe("2026-05-18");
    });
  });
});
