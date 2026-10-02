/**
 * Issue #448 (owner decision 01.10.2026 + implementation decisions 02.10.2026) — a
 * Berufsschultag (VOCATIONAL_SCHOOL Absence) never costs a leave day and never reduces Soll
 * twice. This file covers the HTTP-level pricing and 400-rejection behaviour (D-01/D-02/D-07)
 * for every schedule type and write path (POST create, PUT edit, PATCH correct). The saldo
 * (D-03) is covered separately in
 * contexts/working-time-account/__tests__/close-employee-month-bs-leave.test.ts.
 *
 * Every date is a fixed 2027 calendar literal (not computed from "today") — 2027-03-08..12 is a
 * Monday-Friday week with no German statutory holiday (NIEDERSACHSEN, the seedTestData default
 * federal state) and no Easter proximity (Ostern 2027 = 28.03.).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  seedTestData,
  seedEntitlementYears,
  cleanupTestData,
  closeTestApp,
} from "./setup";

describe("Issue #448 — Berufsschultag kostet keinen Urlaubstag", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let sbEmployeeId: string;
  let sbToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bs448");
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: new Date("2010-06-01") },
    });
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2027, 2028],
    });

    // SHIFT_BASED AZUBI, contractWorkDaysPerWeek 5 (Task 2 — D-02 applies to every schedule
    // type, not only FIXED_SCHEDULE).
    const passwordHash = await bcrypt.hash("test1234", 10);
    const sbUser = await app.prisma.user.create({
      data: {
        email: `bs448-sb-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const sbEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: sbUser.id,
        employeeNumber: `SB448-${Date.now()}`,
        firstName: "Azubi",
        lastName: "ShiftBased",
        hireDate: new Date("2026-01-01"),
        classification: "AZUBI",
        birthDate: new Date("2010-06-01"),
      },
    });
    sbEmployeeId = sbEmployee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: sbEmployeeId,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        contractWorkDaysPerWeek: 5,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2026-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: sbEmployeeId, balanceHours: 0 },
    });
    await seedEntitlementYears(app, {
      employeeId: sbEmployeeId,
      leaveTypeId: data.vacationType.id,
      years: [2027, 2028],
    });
    const sbLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: sbUser.email, password: "test1234" },
    });
    sbToken = JSON.parse(sbLogin.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createBsAbsence(
    employeeId: string,
    isoDate: string,
    source: "PATTERN" | "MANUAL" = "PATTERN",
  ) {
    const d = new Date(`${isoDate}T00:00:00.000Z`);
    await app.prisma.absence.create({
      data: {
        employeeId,
        type: "VOCATIONAL_SCHOOL",
        source,
        startDate: d,
        endDate: d,
        days: 1,
        halfDay: false,
        createdBy: "system",
      },
    });
  }

  it("FIXED AZUBI: Mo–Fr vacation over a BS Tuesday prices 4 days (not 5)", async () => {
    await createBsAbsence(data.employee.id, "2027-03-09");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-03-08", endDate: "2027-03-12" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(Number(body.days)).toBe(4);
  });

  it("FIXED AZUBI: a request for only the BS Tuesday is rejected with the owner's text", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-03-09", endDate: "2027-03-09" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe(
      "An Berufsschultagen kann kein Urlaub genommen werden – der Azubi ist für den Unterricht freigestellt.",
    );
    expect(body.code).toBe("VOCATIONAL_SCHOOL_DAY");

    const stored = await app.prisma.leaveRequest.findFirst({
      where: { employeeId: data.employee.id, startDate: new Date("2027-03-09T00:00:00.000Z") },
    });
    expect(stored).toBeNull();
  });

  it("FIXED AZUBI: a week with no BS row prices unchanged (5 days)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-03-15", endDate: "2027-03-19" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(Number(body.days)).toBe(5);
  });

  // ── Task 2: every schedule type, every write path (D-02, D-07) ─────────────────────────────

  it("SHIFT_BASED AZUBI (contract 5): Mo–Fr vacation over a BS Tuesday prices 4 days", async () => {
    await createBsAbsence(sbEmployeeId, "2027-03-09");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${sbToken}` },
      payload: { type: "VACATION", startDate: "2027-03-08", endDate: "2027-03-12" },
    });

    expect(res.statusCode).toBe(201);
    expect(Number(JSON.parse(res.body).days)).toBe(4);
  });

  it("SHIFT_BASED AZUBI: a request for only the BS Tuesday is rejected 400", async () => {
    // A FRESH, non-overlapping ISO week — reusing the Mo-Fr week above would interact with the
    // Issue #436 week-union marginal pricing (a sibling already claiming the week) rather than
    // isolating the BS-only rule this test targets.
    await createBsAbsence(sbEmployeeId, "2027-06-08"); // Tuesday
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${sbToken}` },
      payload: { type: "VACATION", startDate: "2027-06-08", endDate: "2027-06-08" },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("VOCATIONAL_SCHOOL_DAY");
  });

  it("FIXED AZUBI: a half-day vacation on the BS Tuesday is rejected 400", async () => {
    await createBsAbsence(data.employee.id, "2027-04-06");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {
        type: "VACATION",
        startDate: "2027-04-06",
        endDate: "2027-04-06",
        halfDay: true,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("VOCATIONAL_SCHOOL_DAY");
  });

  it("FIXED AZUBI: a MANUAL-source BS row displaces leave exactly like a PATTERN one", async () => {
    await createBsAbsence(data.employee.id, "2027-04-13", "MANUAL");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-04-12", endDate: "2027-04-16" },
    });

    expect(res.statusCode).toBe(201);
    expect(Number(JSON.parse(res.body).days)).toBe(4);
  });

  it("FIXED AZUBI: BS Tue + manual holiday Wed — Tue..Wed rejected 400, Wed-only not (holiday stays a holiday)", async () => {
    await createBsAbsence(data.employee.id, "2027-04-20"); // Tuesday
    await app.prisma.publicHoliday.create({
      data: {
        tenantId: data.tenant.id,
        salonId: data.salonId as string,
        date: new Date("2027-04-21T00:00:00.000Z"), // Wednesday — manual, non-statutory
        name: "Testfeiertag 448",
        federalState: "NIEDERSACHSEN",
        year: 2027,
      },
    });

    const resBoth = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-04-20", endDate: "2027-04-21" },
    });
    expect(resBoth.statusCode).toBe(400);
    expect(JSON.parse(resBoth.body).code).toBe("VOCATIONAL_SCHOOL_DAY");

    const resWedOnly = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-04-21", endDate: "2027-04-21" },
    });
    expect(resWedOnly.statusCode).not.toBe(400);
  });

  it("FIXED AZUBI: SICK on the BS Tuesday is NOT displaced — 201, days 1", async () => {
    await createBsAbsence(data.employee.id, "2027-04-27");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "SICK", startDate: "2027-04-27", endDate: "2027-04-27" },
    });

    expect(res.statusCode).toBe(201);
    expect(Number(JSON.parse(res.body).days)).toBe(1);
  });

  it("PATCH /requests/:id (edit, PENDING) moving onto the BS Tuesday only is rejected 400, row unchanged", async () => {
    await createBsAbsence(data.employee.id, "2027-05-04");
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-05-10", endDate: "2027-05-10" },
    });
    expect(createRes.statusCode).toBe(201);
    const id = JSON.parse(createRes.body).id;

    const editRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-05-04", endDate: "2027-05-04" },
    });

    expect(editRes.statusCode).toBe(400);
    expect(JSON.parse(editRes.body).code).toBe("VOCATIONAL_SCHOOL_DAY");

    const stillPending = await app.prisma.leaveRequest.findUnique({ where: { id } });
    expect(stillPending?.startDate.toISOString().slice(0, 10)).toBe("2027-05-10");
  });

  it("PATCH /requests/:id/correct (APPROVED) moving onto the BS Tuesday only is rejected 400, row+entitlement unchanged", async () => {
    await createBsAbsence(data.employee.id, "2027-05-18");
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-05-24", endDate: "2027-05-24" },
    });
    expect(createRes.statusCode).toBe(201);
    const id = JSON.parse(createRes.body).id;

    const approveRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(approveRes.statusCode).toBe(200);

    const before = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id, year: 2027 },
    });

    const correctRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        startDate: "2027-05-18",
        endDate: "2027-05-18",
        reason: "Test-Korrektur Issue #448",
      },
    });

    expect(correctRes.statusCode).toBe(400);
    expect(JSON.parse(correctRes.body).code).toBe("VOCATIONAL_SCHOOL_DAY");

    const afterRow = await app.prisma.leaveRequest.findUnique({ where: { id } });
    expect(afterRow?.startDate.toISOString().slice(0, 10)).toBe("2027-05-24");
    const after = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id, year: 2027 },
    });
    expect(Number(after?.usedDays)).toBe(Number(before?.usedDays));
  });

  it("Cross-year: VACATION over New Year with a BS day splits so the two years still sum to the total", async () => {
    await createBsAbsence(sbEmployeeId, "2027-12-28"); // Tuesday, within the request range

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${sbToken}` },
      payload: { type: "VACATION", startDate: "2027-12-27", endDate: "2028-01-07" },
    });

    expect(res.statusCode).toBe(201);
    const id = JSON.parse(res.body).id;
    const totalDays = Number(JSON.parse(res.body).days);

    const row = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
    const holidays = new Set<string>();
    const { splitLeaveDaysByYear } = await import("../contexts/absence/leave-days");
    const split = await splitLeaveDaysByYear(
      app.prisma,
      sbEmployeeId,
      data.tenant.id,
      row.startDate,
      row.endDate,
      totalDays,
      holidays,
    );
    expect(split.year1Days + split.year2Days).toBeCloseTo(totalDays, 5);
  });
});
