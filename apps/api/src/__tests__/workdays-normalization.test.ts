/**
 * Phase 61 (v1.6.5) — integration tests for server-side workDays normalization.
 *
 * Closes an employee's class of bug: admin enters `mondayHours=0` but the row
 * is written with `workDays=[1,2,3,4,5]` (the schema default), making Monday
 * count as a workday for Urlaubsverbrauch even though Monday has no expected
 * hours.
 *
 * Verifies:
 *   1. POST /api/v1/employees with body.workDays omitted writes a row whose
 *      workDays falls back to the tenant default / Mo-Fr (per-day-hours are
 *      NOT in the POST body today; the helper is a no-op pass-through here).
 *   2. POST /api/v1/employees with body.workDays explicit non-default → trust caller.
 *   3. PUT /api/v1/settings/work/:employeeId with workDays omitted +
 *      mondayHours=0 → row workDays = [2,3,4,5] (Anna's bug fixed).
 *   4. PUT with explicit workDays=[0,1,2,3,4] + Mo-Fr hours → row workDays =
 *      [0,1,2,3,4] (admin override wins).
 *   5. PUT with workDays=[1,2,3,4,5] (literal default) + mondayHours=0 → row
 *      workDays = [2,3,4,5] (literal default overridden).
 *   6. PUT regression with workDays=[1,2,3,4,5] + Mo-Fr hours → row workDays =
 *      [1,2,3,4,5] (no change, no harm).
 *
 * Pattern mirrors apps/api/src/__tests__/workschedule-validfrom-month1.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("WorkSchedule.workDays normalization (Phase 61)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "wdn");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  // Common PUT helper — builds a fully-formed schedule payload.
  const putSchedule = async (
    overrides: Record<string, unknown>,
    employeeId: string = data.employee.id,
  ) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 32,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        overtimeThreshold: 60,
        allowOvertimePayout: false,
        validFrom: "2026-06-01",
        ...overrides,
      },
    });

  it("POST /employees without body.workDays falls back to tenant default / Mo-Fr", async () => {
    const slug = "wdn-post1-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        email: `${slug}@test.de`,
        firstName: "P",
        lastName: "OST",
        employeeNumber: slug,
        hireDate: "2026-01-01T00:00:00Z",
        password: "TestPass1234!",
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 40,
      },
    });
    expect(res.statusCode).toBe(201);
    const emp = JSON.parse(res.body);
    const ws = await app.prisma.workSchedule.findFirst({ where: { employeeId: emp.id } });
    expect(ws).not.toBeNull();
    // createEmployeeSchema does not accept per-day-hours; helper synthesizes
    // Mo-Fr schema defaults, so derived = [1,2,3,4,5] and tenant fallback wins
    // only when caller sends something non-default. Final: [1,2,3,4,5].
    expect(ws!.workDays).toEqual([1, 2, 3, 4, 5]);
  });

  it("POST /employees with body.workDays=[2,3,4,5] writes [2,3,4,5] (admin override)", async () => {
    const slug = "wdn-post2-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        email: `${slug}@test.de`,
        firstName: "P",
        lastName: "OST2",
        employeeNumber: slug,
        hireDate: "2026-01-01T00:00:00Z",
        password: "TestPass1234!",
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 32,
        workDays: [2, 3, 4, 5],
      },
    });
    expect(res.statusCode).toBe(201);
    const emp = JSON.parse(res.body);
    const ws = await app.prisma.workSchedule.findFirst({ where: { employeeId: emp.id } });
    expect(ws!.workDays).toEqual([2, 3, 4, 5]);
  });

  it("PUT /settings/work without workDays + mondayHours=0 → workDays = [2,3,4,5] (Anna bug fixed)", async () => {
    const res = await putSchedule({
      mondayHours: 0,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workDays).toEqual([2, 3, 4, 5]);

    // Confirm persisted state too
    const ws = await app.prisma.workSchedule.findFirst({
      where: { employeeId: data.employee.id, validFrom: new Date("2026-06-01T00:00:00Z") },
    });
    expect(ws!.workDays).toEqual([2, 3, 4, 5]);
  });

  it("PUT /settings/work with explicit workDays=[0,1,2,3,4] + Mo-Fr hours → [0,1,2,3,4] (admin override)", async () => {
    // Bump validFrom to a different month so we get a new row, not an update.
    const res = await putSchedule({
      workDays: [0, 1, 2, 3, 4],
      validFrom: "2026-07-01",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workDays).toEqual([0, 1, 2, 3, 4]);
  });

  it("PUT /settings/work with workDays=[1,2,3,4,5] (literal default) + mondayHours=0 → [2,3,4,5]", async () => {
    const res = await putSchedule({
      workDays: [1, 2, 3, 4, 5],
      mondayHours: 0,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      validFrom: "2026-08-01",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workDays).toEqual([2, 3, 4, 5]);
  });

  it("PUT /settings/work with workDays=[1,2,3,4,5] + Mo-Fr hours → [1,2,3,4,5] (regression, no change)", async () => {
    const res = await putSchedule({
      workDays: [1, 2, 3, 4, 5],
      validFrom: "2026-09-01",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.workDays).toEqual([1, 2, 3, 4, 5]);
  });
});
