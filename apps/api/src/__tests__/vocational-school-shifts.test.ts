// Phase 63 Plan 04 — Schichtplan integration tests (D-20).
//
// Covers the Availability bucket extension + classifyAbsenceType + rankAvailability:
//   - VOCATIONAL_SCHOOL Absence -> availability bucket "vocational_school" in /shifts/week
//   - soft-deleted BS Absence does NOT surface as "vocational_school"
//   - shift creation on a BS cell is rejected (POST /shifts conflict path inherits D-43)
//   - rank: vocational_school = 4 (ties with "special"; sick still wins)
//
// Threat model:
//   T-63-20: Tampering — shift creation on BS day is rejected by existing conflict path

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// Compute the next Monday strictly in the future (UTC). The /shifts/week endpoint
// expects an ISO Mon-anchored week start.
function nextMonday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const daysUntilMon = (1 - dow + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMon);
  return d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("Berufsschule shifts (Phase 63 Plan 04 Task 3)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vssh");

    // /shifts/week needs a SHIFT_BASED schedule on the employee for it to appear in
    // the response with availability info. Replace the default FIXED schedule.
    await app.prisma.workSchedule.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2020-01-01"),
      },
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

  beforeEach(async () => {
    await app.prisma.absence.deleteMany({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL" },
    });
    await app.prisma.shift.deleteMany({ where: { employeeId: data.employee.id } });
  });

  // ── D-20: classification & /week response ──────────────────────────────────

  it("GET /shifts/week returns availability=vocational_school for a BS cell", async () => {
    const monday = nextMonday();
    const targetDate = new Date(monday); // BS on the Monday
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: targetDate,
        endDate: targetDate,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${toIsoDate(monday)}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const cell = body.availability.find(
      (a: { employeeId: string; date: string; availability: string }) =>
        a.employeeId === data.employee.id && a.date === toIsoDate(targetDate),
    );
    expect(cell).toBeTruthy();
    expect(cell.availability).toBe("vocational_school");
  });

  it("soft-deleted BS Absence does NOT surface as vocational_school", async () => {
    const monday = nextMonday();
    const targetDate = new Date(monday);
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: targetDate,
        endDate: targetDate,
        days: 1.0,
        createdBy: "SYSTEM",
        deletedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${toIsoDate(monday)}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const cell = body.availability.find(
      (a: { employeeId: string; date: string; availability: string }) =>
        a.employeeId === data.employee.id && a.date === toIsoDate(targetDate),
    );
    // The cell may exist with default "available" or not at all — either way NOT BS.
    if (cell) {
      expect(cell.availability).not.toBe("vocational_school");
    }
  });

  // ── D-43 inheritance: conflict path rejects shift creation on BS day ───────

  it("POST /shifts on a BS day returns 409 conflict (T-63-20)", async () => {
    const monday = nextMonday();
    const targetDate = new Date(monday);
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: targetDate,
        endDate: targetDate,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: toIsoDate(targetDate),
        startTime: "09:00",
        endTime: "17:00",
      },
    });
    expect(res.statusCode).toBe(409);
  });

  // ── Rank: vocational_school = 4 (tie with "special", sick wins) ───────────

  it("rank: sick on same day overrides vocational_school", async () => {
    const monday = nextMonday();
    const targetDate = new Date(monday);
    // Insert BOTH a BS absence and a SICK absence on the same day. By rank,
    // sick (6) should win over vocational_school (4).
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: targetDate,
        endDate: targetDate,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "SICK",
        source: "MANUAL",
        startDate: targetDate,
        endDate: targetDate,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${toIsoDate(monday)}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const cell = body.availability.find(
      (a: { employeeId: string; date: string; availability: string }) =>
        a.employeeId === data.employee.id && a.date === toIsoDate(targetDate),
    );
    expect(cell).toBeTruthy();
    expect(cell.availability).toBe("sick"); // sick beats vocational_school
  });
});
