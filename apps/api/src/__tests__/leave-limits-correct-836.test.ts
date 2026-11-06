/**
 * Issue #836 (D-836-19, AC-7) — `PATCH /leave/requests/:id/correct` checks only the days a correction
 * ADDS; a shortening never asks for an exception; the anonymisation exit-day shortening (which runs
 * through the shared correction core, not through the route) is never checked; and the #835 takeover
 * (a candidate without a request id) sees what a stored PENDING request sees.
 *
 * Fixture (fake clock 2026-06-15T10:00Z, installed BEFORE the app boots): one tenant with its default
 * salon S, an ALL rule `maxPersons 1` for S, person A (raw employee, Mo-Fr contract, homed in S) and
 * person B (the seeded employee, homed in S). August 2026: Mon 3rd .. Fri 7th. No names.
 *
 * Mutation proof (Phase 836, 2026-11-06) — recorded here, not re-run by CI; each change was reverted
 * with cp afterwards:
 * M1 leave.ts correct: the old range replaced by a far-away one, so the whole new range counts as
 *    added -> red: "shortening an over-limit request asks for no exception" (1 failed | 6 passed).
 * M2 leave.ts correct: the exception spread removed from LEAVE_CORRECTED -> red: "with an exception
 *    it corrects and records ..." (1 failed | 6 passed).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  auditRowsFor,
  soleAuditRow,
} from "./setup";
import { evaluateLeaveLimits } from "../contexts/absence/leave-limits";
import { leaveTypeFields } from "../contexts/absence/leave-type";

const PASSWORD = "test1234";
const REASON = "Vertretung im Team abgestimmt, Ausnahme gewollt";

type Conflict = {
  code: string;
  exceedances: Array<{ ruleId: string; days: Array<{ day: string; count: number }> }>;
};

describe("Issue #836 — correction and exit-day shortening against a limit", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let personA: string;
  let sickTypeId: string;

  async function rawEmployee(tag: string) {
    const user = await app.prisma.user.create({
      data: {
        email: `${tag}-${Date.now().toString(36)}@example.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        isActive: true,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `${tag}${Date.now().toString(36)}`.slice(0, 20),
        firstName: tag,
        lastName: "Correct836",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    await home(emp.id);
    await seedEntitlementYears(app, {
      employeeId: emp.id,
      leaveTypeId: data.vacationType.id,
      years: [2026],
    });
    return emp.id;
  }

  function home(employeeId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId: data.salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  function leave(
    employeeId: string,
    status: "APPROVED" | "PENDING",
    startDate: string,
    endDate: string,
    days: number,
    leaveTypeId = data.vacationType.id,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T00:00:00Z`),
        days,
        status,
        ...(status === "APPROVED" ? { reviewedBy: "system", reviewedAt: new Date() } : {}),
      },
    });
  }

  function rule() {
    return app.prisma.leaveLimitRule.create({
      data: {
        tenantId: data.tenant.id,
        salonId: data.salonId,
        groupKind: "ALL",
        maxPersons: 1,
        name: "Fixture rule",
      },
    });
  }

  function correct(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { reason: "Korrektur wegen Planänderung", ...payload },
    });
  }

  /** B's approved request, booked through the real approval so the entitlement ledger is consistent. */
  async function approvedOfB(startDate: string, endDate: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate, endDate },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;
    const reviewed = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED", limitException: { reason: REASON } },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    return id;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "lv836c");
    sickTypeId = (
      await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      })
    ).id;
    personA = await rawEmployee("A");
    await home(data.employee.id);
  });

  afterEach(async () => {
    await app.prisma.leaveLimitRule.deleteMany({ where: { tenantId: data.tenant.id } });
    await app.prisma.leaveRequest.deleteMany({
      where: { employee: { tenantId: data.tenant.id } },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("409 for the added days only, and the request still ends Wednesday with no LEAVE_CORRECTED audit", async () => {
    const id = await approvedOfB("2026-08-03", "2026-08-05");
    await leave(personA, "APPROVED", "2026-08-06", "2026-08-07", 2);
    const r = await rule();

    const res = await correct(id, { startDate: "2026-08-03", endDate: "2026-08-07" });
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as Conflict;
    expect(body.code).toBe("LEAVE_LIMIT_EXCEPTION_REQUIRED");
    expect(body.exceedances[0].ruleId).toBe(r.id);
    expect(body.exceedances[0].days).toEqual([
      { day: "2026-08-06", count: 2, max: 1 },
      { day: "2026-08-07", count: 2, max: 1 },
    ]);
    expect(res.body).not.toContain(personA);

    const row = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
    expect(row.endDate.toISOString().slice(0, 10)).toBe("2026-08-05");
    expect(await auditRowsFor(app, "LeaveRequest", id, "LEAVE_CORRECTED")).toHaveLength(0);
  });

  it("with an exception it corrects and records reason, rule snapshot and Thu/Fri counts in LEAVE_CORRECTED", async () => {
    const id = await approvedOfB("2026-08-03", "2026-08-05");
    await leave(personA, "APPROVED", "2026-08-06", "2026-08-07", 2);
    const r = await rule();

    const res = await correct(id, {
      startDate: "2026-08-03",
      endDate: "2026-08-07",
      limitException: { reason: REASON },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
    expect(row.endDate.toISOString().slice(0, 10)).toBe("2026-08-07");

    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "LeaveRequest", entityId: id, action: "LEAVE_CORRECTED" },
    });
    const exception = (audit.newValue as Record<string, unknown>).leaveLimitException as {
      reason: string;
      rules: Array<{ ruleId: string }>;
      days: Array<{ day: string; ruleId: string; count: number }>;
    };
    expect(exception.reason).toBe(REASON);
    expect(exception.rules.map((x) => x.ruleId)).toEqual([r.id]);
    expect(exception.days.map((d) => [d.day, d.count])).toEqual([
      ["2026-08-06", 2],
      ["2026-08-07", 2],
    ]);
    expect(JSON.stringify(audit)).not.toContain(personA);
  });

  it("a correction that adds nothing over a limit carries no exception key", async () => {
    const id = await approvedOfB("2026-08-03", "2026-08-05");
    await rule();
    const res = await correct(id, {
      startDate: "2026-08-03",
      endDate: "2026-08-06",
      limitException: { reason: REASON },
    });
    expect(res.statusCode, res.body).toBe(200);
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "LeaveRequest", entityId: id, action: "LEAVE_CORRECTED" },
    });
    expect(Object.keys(audit.newValue as object)).not.toContain("leaveLimitException");
  });

  it("shortening an over-limit request asks for no exception", async () => {
    await leave(personA, "APPROVED", "2026-08-03", "2026-08-07", 5);
    await rule();
    const id = await approvedOfB("2026-08-03", "2026-08-07");

    const res = await correct(id, { startDate: "2026-08-03", endDate: "2026-08-04" });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } })).endDate
        .toISOString()
        .slice(0, 10),
    ).toBe("2026-08-04");
  });

  it("SICK to VACATION over days where the limit is full checks the whole range", async () => {
    await leave(personA, "APPROVED", "2026-08-03", "2026-08-07", 5);
    await rule();
    const sick = await leave(
      data.employee.id,
      "APPROVED",
      "2026-08-03",
      "2026-08-07",
      5,
      sickTypeId,
    );

    const res = await correct(sick.id, {
      startDate: "2026-08-03",
      endDate: "2026-08-07",
      type: "VACATION",
    });
    expect(res.statusCode, res.body).toBe(409);
    expect((JSON.parse(res.body) as Conflict).exceedances[0].days).toHaveLength(5);
    const row = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: sick.id },
      include: { leaveType: true },
    });
    expect(row.leaveType.code).toBe("SICK");
  });

  it("the anonymisation exit-day shortening never asks for an exception", async () => {
    await leave(personA, "APPROVED", "2026-08-03", "2026-08-07", 5);
    await rule();
    const worker = await rawEmployee("X");
    const request = await leave(worker, "PENDING", "2026-08-03", "2026-08-07", 5);
    const approved = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${request.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED", limitException: { reason: REASON } },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await app.prisma.employee.update({
      where: { id: worker },
      data: { exitDate: new Date("2026-08-05T00:00:00Z") },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/employees/${worker}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, res.body).toBe(204);

    const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe("APPROVED");
    expect(after.endDate.toISOString().slice(0, 10)).toBe("2026-08-05");
    const corrected = await auditRowsFor(app, "LeaveRequest", request.id, "LEAVE_CORRECTED");
    expect(corrected).toHaveLength(1);
    expect(Object.keys(corrected[0].newValue as object)).not.toContain("leaveLimitException");
  });

  it("#835 parity: a wish (no request id) yields what the stored PENDING request yields", async () => {
    await leave(personA, "APPROVED", "2026-08-03", "2026-08-07", 5);
    await rule();
    const pending = await leave(data.employee.id, "PENDING", "2026-08-05", "2026-08-11", 5);
    const span = { startDay: "2026-08-05", endDay: "2026-08-11", typeCode: "VACATION" };

    const stored = await evaluateLeaveLimits(app.prisma, data.tenant.id, {
      candidates: [{ requestId: pending.id, employeeId: data.employee.id, ...span }],
      excludeRequestIds: [pending.id],
    });
    await app.prisma.leaveRequest.delete({ where: { id: pending.id } });
    const wish = await evaluateLeaveLimits(app.prisma, data.tenant.id, {
      candidates: [{ requestId: null, employeeId: data.employee.id, ...span }],
      excludeRequestIds: [],
    });

    expect(stored.exceedances).toHaveLength(1);
    expect(stored.exceedances[0].days.map((d) => [d.day, d.count])).toEqual([
      ["2026-08-05", 2],
      ["2026-08-06", 2],
      ["2026-08-07", 2],
    ]);
    expect(wish.exceedances).toEqual(stored.exceedances);
  });
});
