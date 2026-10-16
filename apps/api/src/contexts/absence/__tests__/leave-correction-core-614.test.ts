/**
 * Issue #614 (plan 614-03) — the leave-correction core, called directly (no HTTP).
 *
 * `prepareLeaveCorrection` returns a refusal as data with an internal UPPER_SNAKE reason that the
 * exit path (plan 614-04) maps; the route keeps sending `statusCode` + `body`. The route-level
 * behaviour is pinned by the existing `/correct` test family, which runs unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
} from "../../../__tests__/setup";
import {
  prepareLeaveCorrection,
  applyLeaveCorrection,
  type CorrectableLeaveRequest,
} from "../leave-correction";
import { resolveLeaveDays, getHolidayMap } from "../leave-days";

describe("leave-correction core (Issue #614)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lcc614");
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2029],
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createApprovedVacation(startDate: string, endDate: string, days = 5) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        days,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
      },
    });
  }

  async function load(id: string): Promise<CorrectableLeaveRequest> {
    return app.prisma.leaveRequest.findFirstOrThrow({
      where: { id, deletedAt: null },
      include: { leaveType: true, employee: { select: { tenantId: true } } },
    });
  }

  async function prepare(id: string, startDate: string, endDate: string, halfDay = false) {
    return prepareLeaveCorrection(app, {
      existing: await load(id),
      start: new Date(startDate),
      end: new Date(endDate),
      halfDay,
      note: null,
      reason: "Kerntest 614",
      tenantId: data.tenant.id,
    });
  }

  it("a shortening whose removed days lie in a closed month is refused CLOSED_MONTH (409)", async () => {
    const req = await createApprovedVacation("2029-05-07", "2029-05-11");
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: new Date(Date.UTC(2029, 4, 1)),
        periodEnd: new Date(Date.UTC(2029, 5, 0)),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    const result = await prepare(req.id, "2029-05-07", "2029-05-09");

    expect(result).toEqual({
      ok: false,
      statusCode: 409,
      body: { error: "Gesperrter Monat — Korrektur nicht möglich" },
      reason: "CLOSED_MONTH",
    });
  });

  it("a range colliding with another APPROVED vacation is refused OVERLAP (409)", async () => {
    const first = await createApprovedVacation("2029-06-04", "2029-06-08");
    await createApprovedVacation("2029-06-11", "2029-06-15");

    const result = await prepare(first.id, "2029-06-04", "2029-06-12");

    expect(result).toEqual({
      ok: false,
      statusCode: 409,
      body: { error: "Überschneidung mit bestehendem Antrag" },
      reason: "OVERLAP",
    });
  });

  it("a corrected range of Berufsschule days only is refused BS_ONLY (400, error + code)", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: new Date("2010-06-01") },
    });
    try {
      const bsDay = new Date("2029-07-10T00:00:00.000Z"); // Tuesday
      await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "MANUAL",
          startDate: bsDay,
          endDate: bsDay,
          days: 1,
          halfDay: false,
          createdBy: "system",
        },
      });
      const req = await createApprovedVacation("2029-07-09", "2029-07-13", 4);

      const result = await prepare(req.id, "2029-07-10", "2029-07-10");

      expect(result).toEqual({
        ok: false,
        statusCode: 400,
        body: {
          error:
            "An Berufsschultagen kann kein Urlaub genommen werden – der Azubi ist für den Unterricht freigestellt.",
          code: "VOCATIONAL_SCHOOL_DAY",
        },
        reason: "BS_ONLY",
      });
    } finally {
      await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { classification: "VOLLZEIT", birthDate: null },
      });
    }
  });

  it("a valid shortening of an APPROVED VACATION is ok: plan days equal resolveLeaveDays, apply books the difference, no audit without § 9 credits or invalid entries", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2029-03-12", endDate: "2029-03-16" },
    });
    expect(created.statusCode).toBe(201);
    const requestId = JSON.parse(created.body).id as string;
    const approved = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${requestId}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(approved.statusCode).toBe(200);
    const used = async () =>
      Number(
        (
          await app.prisma.leaveEntitlement.findFirstOrThrow({
            where: {
              employeeId: data.employee.id,
              leaveTypeId: data.vacationType.id,
              year: 2029,
            },
          })
        ).usedDays,
      );
    expect(await used()).toBe(5);

    const result = await prepare(requestId, "2029-03-12", "2029-03-14");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const start = new Date("2029-03-12");
    const end = new Date("2029-03-14");
    const holidays = new Set(
      (await getHolidayMap(app.prisma, data.tenant.id, data.employee.id, start, end)).keys(),
    );
    const expected = await resolveLeaveDays(
      app.prisma,
      data.employee.id,
      data.tenant.id,
      start,
      end,
      false,
      holidays,
      { mode: "request", leaveTypeCode: "VACATION", excludeRequestId: requestId },
    );
    expect(result.plan.days).toBe(expected.days);
    expect(result.plan.days).toBe(3);

    const audits: unknown[] = [];
    const updated = await app.prisma.$transaction((tx) =>
      applyLeaveCorrection(tx, result.plan, {
        actorUserId: data.adminUser.id,
        audit: async (entry) => {
          audits.push(entry);
        },
      }),
    );

    expect(updated.endDate.toISOString().slice(0, 10)).toBe("2029-03-14");
    expect(Number(updated.days)).toBe(3);
    expect(await used()).toBe(3);
    expect(audits).toEqual([]);
  });
});
