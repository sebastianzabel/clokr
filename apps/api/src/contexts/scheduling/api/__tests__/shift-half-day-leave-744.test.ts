import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
} from "../../../../__tests__/setup";

/**
 * Issue #744 - a HALF-day leave no longer blocks a shift (hint HALF_DAY_LEAVE instead of the 409
 * SHIFT_CONFLICT_LEAVE); a full-day leave still blocks, and a full day beside a half day wins.
 */
describe("shifts on a half-day leave (Issue #744)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let offset = 90;

  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Always in the future (SHIFT_PAST_IMMUTABLE), always a weekday.
  const nextDay = (): string => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    offset += 3;
    return iso(d);
  };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "shift-half-744");
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-02-01"),
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

  async function leave(dateIso: string, halfDay: boolean) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(dateIso),
        endDate: new Date(dateIso),
        days: halfDay ? 0.5 : 1,
        halfDay,
        status: "APPROVED",
      },
    });
  }

  const post = (date: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date, startTime: "08:00", endTime: "12:00" },
    });

  it("POST on a half-day leave: 201 with the HALF_DAY_LEAVE hint, shift not flagged", async () => {
    const date = nextDay();
    await leave(date, true);
    const res = await post(date);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.hint.code).toBe("HALF_DAY_LEAVE");
    expect(typeof body.hint.message).toBe("string");
    const row = await app.prisma.shift.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.conflictsWithLeave).toBe(false);
  });

  it("POST on a day without leave carries no hint", async () => {
    const res = await post(nextDay());
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).hint).toBeUndefined();
  });

  it("POST on a full-day leave: still 409 SHIFT_CONFLICT_LEAVE", async () => {
    const date = nextDay();
    await leave(date, false);
    const res = await post(date);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("SHIFT_CONFLICT_LEAVE");
  });

  it("POST on half-day plus full-day leave of the same date: the full day wins (409)", async () => {
    const date = nextDay();
    await leave(date, true);
    await leave(date, false);
    const res = await post(date);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("SHIFT_CONFLICT_LEAVE");
  });

  it("PUT moving a shift onto a half-day leave: 200 with the hint; onto a full day: 409", async () => {
    const free = nextDay();
    const created = JSON.parse((await post(free)).body);
    const halfDate = nextDay();
    await leave(halfDate, true);
    const ok = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${created.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { date: halfDate },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).hint.code).toBe("HALF_DAY_LEAVE");

    const fullDate = nextDay();
    await leave(fullDate, false);
    const blocked = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${created.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { date: fullDate },
    });
    expect(blocked.statusCode).toBe(409);
    expect(JSON.parse(blocked.body).code).toBe("SHIFT_CONFLICT_LEAVE");
  });

  it("approving a half-day request does not flag an existing shift of that day", async () => {
    const { flagShiftsConflictingWithLeave } = await import("../../facade/shifts");
    const date = nextDay();
    const created = JSON.parse((await post(date)).body);
    const day = new Date(date);
    const flaggedHalf = await flagShiftsConflictingWithLeave(
      app.prisma,
      data.employee.id,
      data.tenant.id,
      day,
      day,
      { halfDay: true },
    );
    expect(flaggedHalf).toHaveLength(0);
    const flaggedFull = await flagShiftsConflictingWithLeave(
      app.prisma,
      data.employee.id,
      data.tenant.id,
      day,
      day,
      { halfDay: false },
    );
    expect(flaggedFull.map((s) => s.id)).toEqual([created.id]);
  });

  it("a shift on a half-day leave does not change the request's stored day count", async () => {
    const date = nextDay();
    const lr = await leave(date, true);
    const res = await post(date);
    expect(res.statusCode).toBe(201);
    const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } });
    expect(Number(after.days)).toBe(0.5);
  });
});
